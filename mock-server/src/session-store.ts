// Server-side session + chunk store with disk persistence.
// Owns protocol logic: ordering, idempotency, checksum validation, TTL.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";

import {
  CHECKSUM_ALGO,
  SESSION_TTL,
  makeIdempotencyKey,
  type ChunkAck,
  type ChunkMetadata,
  type CheckpointModel,
  type MissingChunk,
  type ServerErrorCode,
  type SessionModel,
  type SessionStatus,
} from "../../shared/contract.js";

export class ProtocolError extends Error {
  constructor(
    public code: ServerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

interface StoredChunk {
  meta: ChunkMetadata;
  serverStoredAt: string;
}

interface SessionRecord {
  session: SessionModel;
  // segmentIndex -> lastAcceptedChunkIndex
  lastAcceptedChunkIndexBySegment: Record<string, number>;
  // idempotencyKey -> stored chunk (for duplicate detection)
  chunks: Record<string, StoredChunk>;
  // completeIdempotencyKey -> previously computed response snapshot
  completeResults: Record<string, CompleteSummary>;
}

export interface CompleteSummary {
  sessionId: string;
  status: SessionStatus;
  receivedSegments: number;
  receivedChunksTotal: number;
  missingChunks: MissingChunk[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export class SessionStore {
  private sessions = new Map<string, SessionRecord>();

  constructor(private dataDir: string) {
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle helpers
  // -------------------------------------------------------------------------

  private sessionDir(sessionId: string): string {
    return join(this.dataDir, sessionId);
  }

  /** Refresh derived status based on TTL clocks. Returns the effective status. */
  private refreshStatus(rec: SessionRecord): SessionStatus {
    const s = rec.session;
    if (s.status === "completed" || s.status === "completed_with_segments") {
      return s.status;
    }
    const now = Date.now();
    if (now > new Date(s.finalTtlExpiresAt).getTime()) {
      s.status = "expired";
      return s.status;
    }
    if (s.status === "active" && now > new Date(s.expiresAt).getTime()) {
      s.status = "interrupted";
      s.interruptedAt = nowIso();
    }
    return s.status;
  }

  private getRecordOrThrow(sessionId: string): SessionRecord {
    const rec = this.sessions.get(sessionId);
    if (!rec) {
      throw new ProtocolError("SESSION_NOT_FOUND", `Session ${sessionId} not found`);
    }
    return rec;
  }

  // -------------------------------------------------------------------------
  // API operations
  // -------------------------------------------------------------------------

  async startSession(): Promise<SessionModel> {
    const createdAt = Date.now();
    const session: SessionModel = {
      sessionId: randomUUID(),
      status: "active",
      createdAt: new Date(createdAt).toISOString(),
      interruptedAt: null,
      expiresAt: new Date(createdAt + SESSION_TTL.interruptedMs).toISOString(),
      finalTtlExpiresAt: new Date(createdAt + SESSION_TTL.finalMs).toISOString(),
    };
    const rec: SessionRecord = {
      session,
      lastAcceptedChunkIndexBySegment: {},
      chunks: {},
      completeResults: {},
    };
    this.sessions.set(session.sessionId, rec);
    await this.persistSession(rec);
    return session;
  }

  async resumeSession(sessionId: string): Promise<{ session: SessionModel; checkpoint: CheckpointModel; resumable: boolean }> {
    const rec = this.getRecordOrThrow(sessionId);
    const status = this.refreshStatus(rec);

    if (status === "expired") {
      throw new ProtocolError("SESSION_EXPIRED", `Session ${sessionId} expired`);
    }
    if (status === "completed" || status === "completed_with_segments") {
      throw new ProtocolError("SESSION_NOT_RESUMABLE", `Session ${sessionId} already completed`);
    }

    // Resuming keeps same sessionId; recording continues under a new segment.
    rec.session.status = "active";
    rec.session.interruptedAt = null;
    // Persist the revived status so a crash right after resume can't lose it.
    await this.persistSession(rec);

    return {
      session: rec.session,
      checkpoint: this.buildCheckpoint(rec),
      resumable: true,
    };
  }

  getCheckpoint(sessionId: string): CheckpointModel {
    const rec = this.getRecordOrThrow(sessionId);
    this.refreshStatus(rec);
    return this.buildCheckpoint(rec);
  }

  private buildCheckpoint(rec: SessionRecord): CheckpointModel {
    const segments = Object.keys(rec.lastAcceptedChunkIndexBySegment).map(Number);
    const lastAcceptedSegmentIndex = segments.length ? Math.max(...segments) : -1;
    return {
      sessionId: rec.session.sessionId,
      status: rec.session.status,
      lastAcceptedSegmentIndex,
      lastAcceptedChunkIndexBySegment: { ...rec.lastAcceptedChunkIndexBySegment },
      updatedAt: nowIso(),
    };
  }

  async acceptChunk(sessionId: string, meta: ChunkMetadata, blob: Buffer): Promise<ChunkAck> {
    const rec = this.getRecordOrThrow(sessionId);
    const status = this.refreshStatus(rec);

    if (status === "expired") {
      throw new ProtocolError("SESSION_EXPIRED", `Session ${sessionId} expired`);
    }
    if (status === "completed" || status === "completed_with_segments") {
      throw new ProtocolError("SESSION_NOT_RESUMABLE", `Session ${sessionId} already completed`);
    }

    // Uploading revives an interrupted session.
    rec.session.status = "active";
    rec.session.interruptedAt = null;

    const segKey = String(meta.segmentIndex);

    // Idempotency: same key already stored -> duplicate ACK, no re-store.
    if (rec.chunks[meta.idempotencyKey]) {
      return this.buildAck(rec, meta, true);
    }

    // Checksum validation before accepting.
    if (meta.checksumAlgo !== CHECKSUM_ALGO) {
      throw new ProtocolError("CHECKSUM_MISMATCH", `Unsupported checksum algo ${meta.checksumAlgo}`);
    }
    if (sha256Hex(blob) !== meta.checksum) {
      throw new ProtocolError("CHECKSUM_MISMATCH", "Checksum does not match uploaded blob");
    }

    // Ordering: accept only lastAccepted + 1 per segment (first chunk is 0).
    const lastAccepted = rec.lastAcceptedChunkIndexBySegment[segKey];
    const expected = lastAccepted === undefined ? 0 : lastAccepted + 1;
    if (meta.chunkIndex !== expected) {
      throw new ProtocolError(
        "OUT_OF_ORDER_CHUNK",
        `Expected chunkIndex ${expected} in segment ${meta.segmentIndex}, got ${meta.chunkIndex}`,
      );
    }

    // Persist blob + metadata to disk.
    await this.persistChunk(rec.session.sessionId, meta, blob);

    const serverStoredAt = nowIso();
    rec.chunks[meta.idempotencyKey] = { meta, serverStoredAt };
    rec.lastAcceptedChunkIndexBySegment[segKey] = meta.chunkIndex;
    await this.persistSession(rec);

    return this.buildAck(rec, meta, false, serverStoredAt);
  }

  private buildAck(rec: SessionRecord, meta: ChunkMetadata, duplicate: boolean, serverStoredAt?: string): ChunkAck {
    const cp = this.buildCheckpoint(rec);
    return {
      sessionId: rec.session.sessionId,
      segmentIndex: meta.segmentIndex,
      chunkIndex: meta.chunkIndex,
      accepted: true,
      duplicate,
      lastAcceptedSegmentIndex: cp.lastAcceptedSegmentIndex,
      lastAcceptedChunkIndexBySegment: cp.lastAcceptedChunkIndexBySegment,
      serverStoredAt: serverStoredAt ?? rec.chunks[meta.idempotencyKey]?.serverStoredAt ?? nowIso(),
    };
  }

  async completeSession(
    sessionId: string,
    expectedLastSegmentIndex: number,
    expectedLastChunkIndexBySegment: Record<string, number>,
    idempotencyKey: string,
  ): Promise<CompleteSummary> {
    const rec = this.getRecordOrThrow(sessionId);
    this.refreshStatus(rec);

    // Idempotent complete: return the previously computed summary.
    const cached = rec.completeResults[idempotencyKey];
    if (cached) {
      return cached;
    }

    if (rec.session.status === "expired") {
      throw new ProtocolError("SESSION_EXPIRED", `Session ${sessionId} expired`);
    }

    // Determine which expected chunks are missing on the server.
    const missingChunks: MissingChunk[] = [];
    for (let seg = 0; seg <= expectedLastSegmentIndex; seg++) {
      const expectedLastChunk = expectedLastChunkIndexBySegment[String(seg)];
      if (expectedLastChunk === undefined) continue;
      const have = rec.lastAcceptedChunkIndexBySegment[String(seg)];
      const haveIdx = have === undefined ? -1 : have;
      for (let c = haveIdx + 1; c <= expectedLastChunk; c++) {
        missingChunks.push({ segmentIndex: seg, chunkIndex: c });
      }
    }

    const receivedChunksTotal = Object.keys(rec.chunks).length;
    const receivedSegments = Object.keys(rec.lastAcceptedChunkIndexBySegment).length;

    const status: SessionStatus = missingChunks.length === 0 ? "completed" : "completed_with_segments";
    rec.session.status = status;

    const summary: CompleteSummary = {
      sessionId,
      status,
      receivedSegments,
      receivedChunksTotal,
      missingChunks,
    };
    rec.completeResults[idempotencyKey] = summary;
    // Await the write so the completed status is durable before we return it.
    await this.persistSession(rec);
    return summary;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async persistSession(rec: SessionRecord): Promise<void> {
    const dir = this.sessionDir(rec.session.sessionId);
    await mkdir(dir, { recursive: true });
    const manifest = {
      session: rec.session,
      lastAcceptedChunkIndexBySegment: rec.lastAcceptedChunkIndexBySegment,
      // Store the full metadata so hydrate() can fully rebuild the chunks map
      // (idempotency + received counts) after a restart.
      chunks: Object.values(rec.chunks).map((c) => ({
        meta: c.meta,
        serverStoredAt: c.serverStoredAt,
      })),
    };
    await this.writeFileAtomic(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    await this.writeFileAtomic(
      join(dir, "checkpoint.json"),
      JSON.stringify(this.buildCheckpoint(rec), null, 2),
    );
  }

  /** Write via a temp file + rename so a crash can't leave a half-written JSON. */
  private async writeFileAtomic(path: string, contents: string): Promise<void> {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, contents, "utf8");
    await rename(tmp, path);
  }

  private async persistChunk(sessionId: string, meta: ChunkMetadata, blob: Buffer): Promise<void> {
    const dir = join(this.sessionDir(sessionId), `segment-${meta.segmentIndex}`);
    await mkdir(dir, { recursive: true });
    const ext = meta.mimeType.includes("webm") ? "webm" : "bin";
    await writeFile(join(dir, `chunk-${meta.chunkIndex}.${ext}`), blob);
  }

  /**
   * Rebuild the in-memory chunks map (keyed by idempotencyKey) from a manifest,
   * so idempotency detection and received-chunk counts survive a restart.
   * Handles both the current shape ({ meta, serverStoredAt }) and the legacy
   * flat shape ({ segmentIndex, chunkIndex, ... }) written by older versions.
   */
  private rebuildChunks(sessionId: string, rawChunks: unknown): Record<string, StoredChunk> {
    const chunks: Record<string, StoredChunk> = {};
    if (!Array.isArray(rawChunks)) return chunks;
    for (const entry of rawChunks) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const meta = (e.meta ?? e) as Partial<ChunkMetadata>;
      if (typeof meta.segmentIndex !== "number" || typeof meta.chunkIndex !== "number") continue;
      const idempotencyKey =
        typeof meta.idempotencyKey === "string"
          ? meta.idempotencyKey
          : makeIdempotencyKey(sessionId, meta.segmentIndex, meta.chunkIndex);
      chunks[idempotencyKey] = {
        meta: { ...(meta as ChunkMetadata), sessionId, idempotencyKey },
        serverStoredAt: typeof e.serverStoredAt === "string" ? e.serverStoredAt : nowIso(),
      };
    }
    return chunks;
  }

  /** Load any persisted sessions from disk into memory (best-effort). */
  async hydrate(): Promise<void> {
    if (!existsSync(this.dataDir)) return;
    const entries = await readdir(this.dataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(this.dataDir, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const raw = JSON.parse(await readFile(manifestPath, "utf8"));
        const rec: SessionRecord = {
          session: raw.session,
          lastAcceptedChunkIndexBySegment: raw.lastAcceptedChunkIndexBySegment ?? {},
          chunks: this.rebuildChunks(raw.session.sessionId, raw.chunks),
          completeResults: {},
        };
        this.sessions.set(rec.session.sessionId, rec);
      } catch {
        // Ignore corrupt manifests on startup.
      }
    }
  }
}
