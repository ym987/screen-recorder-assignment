import "fake-indexeddb/auto";

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CHECKSUM_ALGO,
  makeIdempotencyKey,
  type ChunkAck,
  type CheckpointModel,
  type ChunkMetadata,
} from "../../shared/contract.js";
import type { ChunkUploader, UploadResult } from "../../frontend/src/chunk-uploader.js";
import { UploadError } from "../../frontend/src/chunk-uploader.js";
import { Idb, STORE_TOMBSTONES, type Tombstone } from "../../frontend/src/idb.js";
import { Store } from "../../frontend/src/state/store.js";
import { UploadQueue } from "../../frontend/src/upload-queue.js";

function meta(segment: number, index: number): ChunkMetadata {
  return {
    sessionId: "s1",
    segmentIndex: segment,
    chunkIndex: index,
    clientTimestamp: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    durationMs: 30000,
    mimeType: "video/webm",
    sizeBytes: 3,
    checksumAlgo: CHECKSUM_ALGO,
    checksum: "deadbeef",
    idempotencyKey: makeIdempotencyKey("s1", segment, index),
  };
}

function ackFor(m: ChunkMetadata, duplicate = false): ChunkAck {
  return {
    sessionId: m.sessionId,
    segmentIndex: m.segmentIndex,
    chunkIndex: m.chunkIndex,
    accepted: true,
    duplicate,
    lastAcceptedSegmentIndex: m.segmentIndex,
    lastAcceptedChunkIndexBySegment: { [String(m.segmentIndex)]: m.chunkIndex },
    serverStoredAt: new Date().toISOString(),
  };
}

const drain = (queue: UploadQueue) => queue.process();

async function clearChunks(store: Idb): Promise<void> {
  for (const c of await store.listAllChunks()) {
    await store.deleteChunk(c.idempotencyKey);
  }
}

/** Persist a pending chunk with a deterministic FIFO createdAt. */
async function putPending(store: Idb, index: number, opts: Partial<ChunkMetadata> = {}): Promise<void> {
  await store.putChunk({
    idempotencyKey: makeIdempotencyKey("s1", 0, index),
    meta: { ...meta(0, index), ...opts },
    blob: new Blob(["abc"]),
    status: "pending",
    attempts: 0,
    createdAt: Date.now() + index,
  });
}

/** Read the tombstone store directly (Idb intentionally exposes no list API). */
function readTombstones(): Promise<Tombstone[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("audio-chunk-upload", 1);
    req.onsuccess = () => {
      const tx = req.result.transaction(STORE_TOMBSTONES, "readonly");
      const all = tx.objectStore(STORE_TOMBSTONES).getAll();
      all.onsuccess = () => resolve(all.result as Tombstone[]);
      all.onerror = () => reject(all.error);
    };
    req.onerror = () => reject(req.error);
  });
}

function checkpoint(lastBySegment: Record<string, number>): CheckpointModel {
  const segments = Object.keys(lastBySegment).map(Number);
  return {
    sessionId: "s1",
    status: "active",
    lastAcceptedSegmentIndex: segments.length ? Math.max(...segments) : -1,
    lastAcceptedChunkIndexBySegment: lastBySegment,
    updatedAt: new Date().toISOString(),
  };
}

let idb: Idb;

beforeEach(async () => {
  // Reuse one open connection and clear it, instead of deleteDatabase() which
  // would block behind the previous test's still-open connection and hang.
  idb = new Idb();
  await clearChunks(idb);
});

describe("UploadQueue ordering + concurrency", () => {
  it("uploads chunks strictly in FIFO order even when stored out of insertion order", async () => {
    const store = new Store();
    const seen: number[] = [];

    const uploader = {
      upload: async (m: ChunkMetadata): Promise<UploadResult> => {
        seen.push(m.chunkIndex);
        return { ack: ackFor(m) };
      },
    } as unknown as ChunkUploader;

    const queue = new UploadQueue(idb, uploader, store);

    // Persist chunks in REVERSE insertion order, but with ascending createdAt,
    // to prove the queue sorts by createdAt (FIFO) rather than storage order.
    const base = Date.now();
    for (const i of [2, 0, 1]) {
      await idb.putChunk({
        idempotencyKey: makeIdempotencyKey("s1", 0, i),
        meta: meta(0, i),
        blob: new Blob(["abc"]),
        status: "pending",
        attempts: 0,
        createdAt: base + i, // createdAt order = 0,1,2
      });
    }

    await drain(queue);

    expect(seen).toEqual([0, 1, 2]);
    expect(await queue.pendingCount()).toBe(0);
  });

  it("never runs two uploads concurrently (processing guard serializes the queue)", async () => {
    const store = new Store();
    let inFlight = 0;
    let maxInFlight = 0;

    const uploader = {
      upload: async (m: ChunkMetadata): Promise<UploadResult> => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yield so a competing upload could interleave if the guard were broken.
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return { ack: ackFor(m) };
      },
    } as unknown as ChunkUploader;

    const queue = new UploadQueue(idb, uploader, store);

    const base = Date.now();
    for (const i of [0, 1, 2]) {
      await idb.putChunk({
        idempotencyKey: makeIdempotencyKey("s1", 0, i),
        meta: meta(0, i),
        blob: new Blob(["abc"]),
        status: "pending",
        attempts: 0,
        createdAt: base + i,
      });
    }

    // Fire several process() calls "at the same moment" to try to break the guard.
    await Promise.all([queue.process(), queue.process(), queue.process()]);
    await drain(queue);

    expect(maxInFlight).toBe(1);
    expect(await queue.pendingCount()).toBe(0);
  });
});

describe("UploadQueue circuit breaker", () => {
  it("breaks the circuit after N consecutive failures and stops processing", async () => {
    const store = new Store();
    let broken = 0;
    const uploader = {
      upload: async (): Promise<UploadResult> => {
        throw new UploadError("boom", false);
      },
    } as unknown as ChunkUploader;

    const queue = new UploadQueue(idb, uploader, store, { onCircuitBroken: () => broken++ });

    // Exactly the breaker threshold of chunks, all destined to fail.
    for (let i = 0; i < 5; i++) await putPending(idb, i);
    await drain(queue);

    expect(broken).toBe(1);
    expect(store.getState().chunksFailed).toBe(5);
    expect(store.getState().state).toBe("error");
    // Every failed chunk is parked as permanent_failed, so nothing stays pending.
    expect(await queue.pendingCount()).toBe(0);
    const all = await idb.listAllChunks();
    expect(all.every((c) => c.status === "permanent_failed")).toBe(true);
  });

  it("a success resets the consecutive-failure counter (no false trip)", async () => {
    const store = new Store();
    let broken = 0;
    const uploader = {
      upload: async (m: ChunkMetadata): Promise<UploadResult> => {
        if (m.chunkIndex < 4) throw new UploadError("boom", false);
        return { ack: ackFor(m) };
      },
    } as unknown as ChunkUploader;

    const queue = new UploadQueue(idb, uploader, store, { onCircuitBroken: () => broken++ });

    // 4 failures then a success: the counter resets before hitting the threshold.
    for (let i = 0; i < 5; i++) await putPending(idb, i);
    await drain(queue);

    expect(broken).toBe(0);
    expect(store.getState().state).not.toBe("error");
    expect(store.getState().chunksFailed).toBe(4);
    expect(store.getState().chunksUploaded).toBe(1);
  });
});

describe("UploadQueue deferred checksum (tail-flush recovery)", () => {
  it("computes the missing checksum from the stored blob before uploading", async () => {
    const store = new Store();
    const captured: ChunkMetadata[] = [];
    const uploader = {
      upload: async (m: ChunkMetadata): Promise<UploadResult> => {
        captured.push(m);
        return { ack: ackFor(m) };
      },
    } as unknown as ChunkUploader;

    const queue = new UploadQueue(idb, uploader, store);

    // A chunk saved via the emergency tail-flush: no checksum yet.
    await idb.putChunk({
      idempotencyKey: makeIdempotencyKey("s1", 0, 0),
      meta: { ...meta(0, 0), checksum: "" },
      blob: new Blob(["abc"]),
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
      checksumPending: true,
    });

    await drain(queue);

    const expected = createHash("sha256").update(Buffer.from("abc")).digest("hex");
    expect(captured).toHaveLength(1);
    expect(captured[0].checksum).toBe(expected);
    expect(await queue.pendingCount()).toBe(0);
  });
});

describe("UploadQueue reconcile + tombstones", () => {
  it("drops chunks the server already accepted and writes a tombstone", async () => {
    const store = new Store();
    const uploader = {
      upload: async (m: ChunkMetadata): Promise<UploadResult> => ({ ack: ackFor(m) }),
    } as unknown as ChunkUploader;
    const queue = new UploadQueue(idb, uploader, store);

    await putPending(idb, 0);
    expect(await queue.pendingCount()).toBe(1);

    // Server checkpoint says chunk 0 in segment 0 is already accepted.
    await queue.reconcile(checkpoint({ "0": 0 }));

    expect(await queue.pendingCount()).toBe(0);
    expect(store.getState().chunksDuplicate).toBe(1);
    const tombs = await readTombstones();
    expect(tombs.map((t) => t.idempotencyKey)).toContain(makeIdempotencyKey("s1", 0, 0));
  });

  it("keeps chunks the server has not accepted yet", async () => {
    const store = new Store();
    const uploader = {
      upload: async (m: ChunkMetadata): Promise<UploadResult> => ({ ack: ackFor(m) }),
    } as unknown as ChunkUploader;
    const queue = new UploadQueue(idb, uploader, store);

    await putPending(idb, 1); // chunk 1
    // Server only has chunk 0 -> chunk 1 must survive reconcile.
    await queue.reconcile(checkpoint({ "0": 0 }));

    expect(await queue.pendingCount()).toBe(1);
  });

  it("cleanup prunes tombstones older than the retention TTL", async () => {
    await idb.putTombstone({
      idempotencyKey: "old-1",
      sessionId: "s1",
      segmentIndex: 0,
      chunkIndex: 0,
      ackedAt: Date.now() - 40 * 60 * 1000, // older than the 30m retention TTL
    });
    await idb.putTombstone({
      idempotencyKey: "fresh-1",
      sessionId: "s1",
      segmentIndex: 0,
      chunkIndex: 1,
      ackedAt: Date.now(),
    });

    const store = new Store();
    const uploader = {
      upload: async (m: ChunkMetadata): Promise<UploadResult> => ({ ack: ackFor(m) }),
    } as unknown as ChunkUploader;
    const queue = new UploadQueue(idb, uploader, store);

    await queue.cleanup();

    const keys = (await readTombstones()).map((t) => t.idempotencyKey);
    expect(keys).not.toContain("old-1");
    expect(keys).toContain("fresh-1");
  });
});
