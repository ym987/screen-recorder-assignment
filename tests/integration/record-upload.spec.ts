import "fake-indexeddb/auto";

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CHECKSUM_ALGO, makeIdempotencyKey, type ChunkMetadata } from "../../shared/contract.js";
import { createServer } from "../../mock-server/src/server.js";
import { ApiClient } from "../../frontend/src/api-client.js";
import { ChunkUploader } from "../../frontend/src/chunk-uploader.js";
import { Idb } from "../../frontend/src/idb.js";
import { Store } from "../../frontend/src/state/store.js";
import { UploadQueue } from "../../frontend/src/upload-queue.js";

let server: Server;
let baseUrl: string;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "integ-"));
  const { app } = createServer(dataDir);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://localhost:${port}`;
});

afterAll(() => {
  server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function chunk(sessionId: string, segment: number, index: number, body: string) {
  const blob = Buffer.from(body);
  const checksum = createHash("sha256").update(blob).digest("hex");
  const meta: ChunkMetadata = {
    sessionId,
    segmentIndex: segment,
    chunkIndex: index,
    clientTimestamp: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    durationMs: 30000,
    mimeType: "video/webm",
    sizeBytes: blob.length,
    checksumAlgo: CHECKSUM_ALGO,
    checksum,
    idempotencyKey: makeIdempotencyKey(sessionId, segment, index),
  };
  return { meta, blob: new Blob([blob]) };
}

const noSleep = () => Promise.resolve();

describe("integration: record + upload", () => {
  it("happy path: start -> 3 ordered chunks -> complete", async () => {
    const api = new ApiClient(baseUrl);
    const uploader = new ChunkUploader({ baseUrl, sleep: noSleep });
    const session = await api.startSession("client-1", ["audio/webm"]);

    for (let i = 0; i < 3; i++) {
      const c = chunk(session.sessionId, 0, i, `chunk-${i}`);
      const { ack } = await uploader.upload(c.meta, c.blob);
      expect(ack.accepted).toBe(true);
      expect(ack.duplicate).toBe(false);
    }

    const summary = await api.completeSession(session.sessionId, 0, { "0": 2 }, "complete:" + session.sessionId);
    expect(summary.status).toBe("completed");
    expect(summary.receivedChunksTotal).toBe(3);
    expect(summary.missingChunks).toHaveLength(0);
  });

  it("temporary network failure retries and recovers", async () => {
    const api = new ApiClient(baseUrl);
    const session = await api.startSession("client-2", ["audio/webm"]);

    let calls = 0;
    const flakyFetch: typeof fetch = async (input, init) => {
      calls++;
      if (calls <= 2) throw new Error("simulated network drop");
      return fetch(input, init);
    };
    const uploader = new ChunkUploader({ baseUrl, fetchImpl: flakyFetch, sleep: noSleep });

    const c = chunk(session.sessionId, 0, 0, "chunk-0");
    const { ack } = await uploader.upload(c.meta, c.blob);
    expect(ack.accepted).toBe(true);
    expect(calls).toBe(3); // 2 failures + 1 success
  });

  it("duplicate chunk returns duplicate:true", async () => {
    const api = new ApiClient(baseUrl);
    const uploader = new ChunkUploader({ baseUrl, sleep: noSleep });
    const session = await api.startSession("client-3", ["audio/webm"]);

    const c = chunk(session.sessionId, 0, 0, "chunk-0");
    const first = await uploader.upload(c.meta, c.blob);
    expect(first.ack.duplicate).toBe(false);
    const second = await uploader.upload(c.meta, c.blob);
    expect(second.ack.duplicate).toBe(true);
  });

  it("out-of-order chunk is rejected as retryable", async () => {
    const api = new ApiClient(baseUrl);
    const uploader = new ChunkUploader({ baseUrl, sleep: noSleep });
    const session = await api.startSession("client-4", ["audio/webm"]);

    const c1 = chunk(session.sessionId, 0, 1, "chunk-1");
    await expect(uploader.attempt(c1.meta, c1.blob)).rejects.toMatchObject({
      code: "OUT_OF_ORDER_CHUNK",
      retryable: true,
    });
  });

  it("two independent sessions upload concurrently without cross-interference", async () => {
    // Simulates two separate browsers recording two different conversations at
    // the same time. The server keys everything by sessionId, so interleaved
    // uploads must not affect each other's ordering or checkpoints.
    const api = new ApiClient(baseUrl);
    const uploaderA = new ChunkUploader({ baseUrl, sleep: noSleep });
    const uploaderB = new ChunkUploader({ baseUrl, sleep: noSleep });

    const sessionA = await api.startSession("browser-A", ["audio/webm"]);
    const sessionB = await api.startSession("browser-B", ["audio/webm"]);
    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);

    // Interleave chunk uploads from both sessions concurrently.
    for (let i = 0; i < 3; i++) {
      const a = chunk(sessionA.sessionId, 0, i, `A-${i}`);
      const b = chunk(sessionB.sessionId, 0, i, `B-${i}`);
      const [ackA, ackB] = await Promise.all([
        uploaderA.upload(a.meta, a.blob),
        uploaderB.upload(b.meta, b.blob),
      ]);
      expect(ackA.ack.accepted).toBe(true);
      expect(ackB.ack.accepted).toBe(true);
    }

    // Each session's checkpoint reflects only its own chunks.
    const cpA = await api.getCheckpoint(sessionA.sessionId);
    const cpB = await api.getCheckpoint(sessionB.sessionId);
    expect(cpA.lastAcceptedChunkIndexBySegment["0"]).toBe(2);
    expect(cpB.lastAcceptedChunkIndexBySegment["0"]).toBe(2);

    const summaryA = await api.completeSession(sessionA.sessionId, 0, { "0": 2 }, "complete:" + sessionA.sessionId);
    const summaryB = await api.completeSession(sessionB.sessionId, 0, { "0": 2 }, "complete:" + sessionB.sessionId);
    expect(summaryA.status).toBe("completed");
    expect(summaryB.status).toBe("completed");
    expect(summaryA.receivedChunksTotal).toBe(3);
    expect(summaryB.receivedChunksTotal).toBe(3);
  });

  it("refresh flow: resume + reconcile drops already-accepted chunks", async () => {
    const api = new ApiClient(baseUrl);
    const uploader = new ChunkUploader({ baseUrl, sleep: noSleep });
    const session = await api.startSession("client-5", ["audio/webm"]);

    // Upload chunk 0 directly (server now has it).
    const c0 = chunk(session.sessionId, 0, 0, "chunk-0");
    await uploader.upload(c0.meta, c0.blob);

    // Simulate a fresh page load: new Idb + queue with chunk 0 still pending locally.
    const idb = new Idb();
    const store = new Store();
    const queue = new UploadQueue(idb, uploader, store);
    await idb.putChunk({
      idempotencyKey: c0.meta.idempotencyKey,
      meta: c0.meta,
      blob: c0.blob,
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
    });
    expect(await queue.pendingCount()).toBe(1);

    // Resume + reconcile against the server checkpoint.
    const resume = await api.resumeSession(session.sessionId, 0, { "0": 0 });
    await queue.reconcile(resume.checkpoint);

    // Chunk 0 was already accepted -> dropped locally.
    expect(await queue.pendingCount()).toBe(0);
  });

  it("checksum mismatch is rejected with CHECKSUM_MISMATCH", async () => {
    const api = new ApiClient(baseUrl);
    const uploader = new ChunkUploader({ baseUrl, sleep: noSleep });
    const session = await api.startSession("client-7", ["video/webm"]);

    const c = chunk(session.sessionId, 0, 0, "chunk-0");
    const badMeta = { ...c.meta, checksum: "0".repeat(64) };
    await expect(uploader.attempt(badMeta, c.blob)).rejects.toMatchObject({
      code: "CHECKSUM_MISMATCH",
      retryable: true,
    });
  });

  it("complete barrier: queue drains to zero before complete", async () => {
    const api = new ApiClient(baseUrl);
    const uploader = new ChunkUploader({ baseUrl, sleep: noSleep });
    const session = await api.startSession("client-6", ["audio/webm"]);

    const idb = new Idb();
    const store = new Store();
    const queue = new UploadQueue(idb, uploader, store);

    for (let i = 0; i < 3; i++) {
      const c = chunk(session.sessionId, 0, i, `c${i}`);
      await queue.enqueue(c.meta, c.blob);
    }

    // Wait for the queue to drain (barrier condition).
    await queue.process();
    for (let i = 0; i < 50 && (await queue.pendingCount()) > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await queue.pendingCount()).toBe(0);

    const summary = await api.completeSession(session.sessionId, 0, { "0": 2 }, "complete:" + session.sessionId);
    expect(summary.status).toBe("completed");
  });
});
