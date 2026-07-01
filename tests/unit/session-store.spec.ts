import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CHECKSUM_ALGO, makeIdempotencyKey, type ChunkMetadata } from "../../shared/contract.js";
import { ProtocolError, SessionStore } from "../../mock-server/src/session-store.js";

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sstore-"));
  store = new SessionStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeChunk(sessionId: string, segmentIndex: number, chunkIndex: number, body: string) {
  const blob = Buffer.from(body);
  const checksum = createHash("sha256").update(blob).digest("hex");
  const meta: ChunkMetadata = {
    sessionId,
    segmentIndex,
    chunkIndex,
    clientTimestamp: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    durationMs: 30000,
    mimeType: "video/webm",
    sizeBytes: blob.length,
    checksumAlgo: CHECKSUM_ALGO,
    checksum,
    idempotencyKey: makeIdempotencyKey(sessionId, segmentIndex, chunkIndex),
  };
  return { meta, blob };
}

describe("SessionStore protocol", () => {
  it("accepts ordered chunks and advances the checkpoint", async () => {
    const s = await store.startSession();
    for (let i = 0; i < 3; i++) {
      const { meta, blob } = makeChunk(s.sessionId, 0, i, `chunk-${i}`);
      const ack = await store.acceptChunk(s.sessionId, meta, blob);
      expect(ack.accepted).toBe(true);
      expect(ack.duplicate).toBe(false);
      expect(ack.lastAcceptedChunkIndexBySegment["0"]).toBe(i);
    }
  });

  it("returns duplicate:true for a repeated idempotency key", async () => {
    const s = await store.startSession();
    const c0 = makeChunk(s.sessionId, 0, 0, "chunk-0");
    await store.acceptChunk(s.sessionId, c0.meta, c0.blob);
    const dup = await store.acceptChunk(s.sessionId, c0.meta, c0.blob);
    expect(dup.duplicate).toBe(true);
  });

  it("rejects out-of-order chunks with OUT_OF_ORDER_CHUNK", async () => {
    const s = await store.startSession();
    const c1 = makeChunk(s.sessionId, 0, 1, "chunk-1");
    await expect(store.acceptChunk(s.sessionId, c1.meta, c1.blob)).rejects.toMatchObject({
      code: "OUT_OF_ORDER_CHUNK",
    });
  });

  it("rejects a checksum mismatch", async () => {
    const s = await store.startSession();
    const c0 = makeChunk(s.sessionId, 0, 0, "chunk-0");
    c0.meta.checksum = "0".repeat(64);
    await expect(store.acceptChunk(s.sessionId, c0.meta, c0.blob)).rejects.toMatchObject({
      code: "CHECKSUM_MISMATCH",
    });
  });

  it("resumes with a new segment index = lastAccepted + 1", async () => {
    const s = await store.startSession();
    const c0 = makeChunk(s.sessionId, 0, 0, "chunk-0");
    await store.acceptChunk(s.sessionId, c0.meta, c0.blob);
    const { checkpoint, resumable } = store.resumeSession(s.sessionId);
    expect(resumable).toBe(true);
    expect(checkpoint.lastAcceptedSegmentIndex).toBe(0);
    // next recording segment should be 1
    expect(checkpoint.lastAcceptedSegmentIndex + 1).toBe(1);
  });

  it("throws SESSION_NOT_FOUND for unknown session", () => {
    expect(() => store.getCheckpoint(randomUUID())).toThrow(ProtocolError);
  });

  it("throws SESSION_NOT_FOUND when accepting a chunk for an unknown session", async () => {
    const { meta, blob } = makeChunk(randomUUID(), 0, 0, "x");
    await expect(store.acceptChunk(randomUUID(), meta, blob)).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  it("throws SESSION_NOT_FOUND when resuming an unknown session", () => {
    expect(() => store.resumeSession(randomUUID())).toThrow(ProtocolError);
  });

  it("handles multiple segments independently", async () => {
    const s = await store.startSession();
    // segment 0: chunks 0 and 1
    for (let i = 0; i < 2; i++) {
      const c = makeChunk(s.sessionId, 0, i, `seg0-chunk${i}`);
      const ack = await store.acceptChunk(s.sessionId, c.meta, c.blob);
      expect(ack.accepted).toBe(true);
    }
    // segment 1: chunk 0 (new segment starts independently from 0)
    const c1 = makeChunk(s.sessionId, 1, 0, "seg1-chunk0");
    const ack1 = await store.acceptChunk(s.sessionId, c1.meta, c1.blob);
    expect(ack1.accepted).toBe(true);
    expect(ack1.lastAcceptedChunkIndexBySegment["0"]).toBe(1);
    expect(ack1.lastAcceptedChunkIndexBySegment["1"]).toBe(0);
  });

  it("complete reports missing chunks and is idempotent", async () => {
    const s = await store.startSession();
    const c0 = makeChunk(s.sessionId, 0, 0, "chunk-0");
    await store.acceptChunk(s.sessionId, c0.meta, c0.blob);

    // expect 2 chunks in segment 0 but only chunk 0 was uploaded
    const summary = store.completeSession(s.sessionId, 0, { "0": 1 }, "complete:x");
    expect(summary.status).toBe("completed_with_segments");
    expect(summary.missingChunks).toEqual([{ segmentIndex: 0, chunkIndex: 1 }]);

    // idempotent: same key returns cached summary
    const again = store.completeSession(s.sessionId, 0, { "0": 1 }, "complete:x");
    expect(again).toEqual(summary);
  });

  it("complete succeeds when all expected chunks are present", async () => {
    const s = await store.startSession();
    for (let i = 0; i < 2; i++) {
      const c = makeChunk(s.sessionId, 0, i, `c${i}`);
      await store.acceptChunk(s.sessionId, c.meta, c.blob);
    }
    const summary = store.completeSession(s.sessionId, 0, { "0": 1 }, "complete:y");
    expect(summary.status).toBe("completed");
    expect(summary.missingChunks).toHaveLength(0);
    expect(summary.receivedChunksTotal).toBe(2);
  });
});
