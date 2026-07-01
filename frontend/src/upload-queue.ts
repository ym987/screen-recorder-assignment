// Upload queue: memory + IndexedDB persistence, FIFO dequeue, circuit breaker,
// retention (delete blob on ACK + tombstone) and checkpoint reconcile.

import { RETENTION, RETRY_POLICY, type CheckpointModel, type ChunkMetadata } from "../../shared/contract.js";
import { sha256Hex } from "./checksum.js";
import { ChunkUploader, UploadError } from "./chunk-uploader.js";
import { Idb, type StoredChunkRecord } from "./idb.js";
import { Store } from "./state/store.js";

export interface UploadQueueEvents {
  onCircuitBroken?: () => void;
  onDrained?: () => void;
}

export class UploadQueue {
  private processing = false;
  private consecutiveFailures = 0;
  private stopped = false;

  constructor(
    private idb: Idb,
    private uploader: ChunkUploader,
    private store: Store,
    private events: UploadQueueEvents = {},
  ) {}

  /** Persist a new chunk and trigger processing. */
  async enqueue(meta: ChunkMetadata, blob: Blob, checksumPending = false): Promise<void> {
    const record: StoredChunkRecord = {
      idempotencyKey: meta.idempotencyKey,
      meta,
      blob,
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
      checksumPending,
    };
    await this.idb.putChunk(record);
    await this.refreshPendingCount();
    void this.process();
  }

  hasPending(): Promise<boolean> {
    return this.idb.listPendingChunks().then((p) => p.length > 0);
  }

  async pendingCount(): Promise<number> {
    return (await this.idb.listPendingChunks()).length;
  }

  private async refreshPendingCount(): Promise<void> {
    const pending = await this.pendingCount();
    this.store.update({ pending });
  }

  /** Resume the queue after a circuit break or pause. */
  resume(): void {
    this.stopped = false;
    this.consecutiveFailures = 0;
    void this.process();
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Drop local pending chunks that the server already accepted, based on the
   * authoritative checkpoint. Runs before continuing uploads after a resume.
   */
  async reconcile(checkpoint: CheckpointModel): Promise<void> {
    const pending = await this.idb.listPendingChunks();
    for (const c of pending) {
      const serverLast = checkpoint.lastAcceptedChunkIndexBySegment[String(c.meta.segmentIndex)];
      if (serverLast !== undefined && c.meta.chunkIndex <= serverLast) {
        // Server already has it -> delete locally + tombstone.
        await this.acknowledgeLocally(c, true);
      }
    }
    await this.refreshPendingCount();
  }

  private async acknowledgeLocally(record: StoredChunkRecord, duplicate: boolean): Promise<void> {
    await this.idb.deleteChunk(record.idempotencyKey);
    await this.idb.putTombstone({
      idempotencyKey: record.idempotencyKey,
      sessionId: record.meta.sessionId,
      segmentIndex: record.meta.segmentIndex,
      chunkIndex: record.meta.chunkIndex,
      ackedAt: Date.now(),
    });
    if (duplicate) {
      const s = this.store.getState();
      this.store.update({ chunksDuplicate: s.chunksDuplicate + 1 }, "chunk_duplicate");
    }
  }

  /** Process the queue sequentially in FIFO order. Safe to call repeatedly. */
  async process(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;
    try {
      // eslint-disable-next-line no-constant-condition
      while (!this.stopped) {
        const pending = await this.idb.listPendingChunks();
        if (pending.length === 0) {
          this.events.onDrained?.();
          break;
        }
        const record = pending[0];
        // A chunk saved via the emergency tail-flush has no checksum yet; compute
        // it now (calmly, on the recovery path) before uploading, since the
        // server validates the blob against meta.checksum.
        if (record.checksumPending || !record.meta.checksum) {
          const buf = await record.blob.arrayBuffer();
          record.meta = { ...record.meta, checksum: await sha256Hex(buf) };
          record.checksumPending = false;
          await this.idb.putChunk(record);
        }
        this.store.transition("uploading");
        this.store.update({ message: `מעלה chunk ${record.meta.chunkIndex} (segment ${record.meta.segmentIndex})` });

        try {
          const { ack } = await this.uploader.upload(record.meta, record.blob, (attempt, delayMs) => {
            this.store.transition("retrying");
            this.store.update(
              { message: `ניסיון חוזר ${attempt} בעוד ${Math.round(delayMs / 1000)}s` },
              "retrying",
            );
          });

          this.consecutiveFailures = 0;
          await this.acknowledgeLocally(record, ack.duplicate);

          const s = this.store.getState();
          this.store.update(
            {
              chunksUploaded: s.chunksUploaded + (ack.duplicate ? 0 : 1),
              message: ack.duplicate ? "chunk כפול (כבר התקבל)" : `chunk ${record.meta.chunkIndex} התקבל`,
            },
            ack.duplicate ? "chunk_duplicate" : "chunk_uploaded",
          );
          await this.refreshPendingCount();
        } catch (err) {
          const uErr = err instanceof UploadError ? err : new UploadError(String(err), false);
          await this.handleFinalFailure(record, uErr);
          if (this.stopped) break;
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async handleFinalFailure(record: StoredChunkRecord, err: UploadError): Promise<void> {
    record.status = "permanent_failed";
    record.attempts = RETRY_POLICY.maxRetriesPerChunk;
    await this.idb.putChunk(record);

    this.consecutiveFailures += 1;
    const s = this.store.getState();
    this.store.update(
      {
        chunksFailed: s.chunksFailed + 1,
        lastError: err.message,
      },
      "upload_failed",
    );

    if (this.consecutiveFailures >= RETRY_POLICY.circuitBreakerConsecutiveFailures) {
      this.stopped = true;
      this.store.transition("error");
      this.store.update(
        { message: "העלאה נכשלה שוב ושוב — ההקלטה הושהתה", lastError: err.message },
        "error",
      );
      this.events.onCircuitBroken?.();
    }
  }

  /** Retention cleanup: prune expired tombstones. */
  async cleanup(): Promise<void> {
    await this.idb.pruneTombstones(RETENTION.tombstoneTtlMs);
  }
}
