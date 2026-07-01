import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import { CHECKSUM_ALGO, makeIdempotencyKey, type ChunkAck, type ChunkMetadata } from "../../shared/contract.js";
import type { ChunkUploader, UploadResult } from "../../frontend/src/chunk-uploader.js";
import { Idb } from "../../frontend/src/idb.js";
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
