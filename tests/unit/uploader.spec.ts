import { describe, expect, it, vi } from "vitest";

import { CHECKSUM_ALGO, type ChunkMetadata } from "../../shared/contract.js";
import { ChunkUploader, UploadError } from "../../frontend/src/chunk-uploader.js";

function meta(): ChunkMetadata {
  return {
    sessionId: "s1",
    segmentIndex: 0,
    chunkIndex: 0,
    clientTimestamp: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    durationMs: 30000,
    mimeType: "audio/webm",
    sizeBytes: 3,
    checksumAlgo: CHECKSUM_ALGO,
    checksum: "deadbeef",
    idempotencyKey: "session:s1|segment:0|chunk:0",
  };
}

function okResponse(duplicate = false): Response {
  return new Response(
    JSON.stringify({
      requestId: "r",
      serverTime: new Date().toISOString(),
      ack: {
        sessionId: "s1",
        segmentIndex: 0,
        chunkIndex: 0,
        accepted: true,
        duplicate,
        lastAcceptedSegmentIndex: 0,
        lastAcceptedChunkIndexBySegment: { "0": 0 },
        serverStoredAt: new Date().toISOString(),
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function errorResponse(status: number, code: string, retryable: boolean): Response {
  return new Response(
    JSON.stringify({
      requestId: "r",
      serverTime: new Date().toISOString(),
      error: { code, message: code, retryable },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

const noSleep = () => Promise.resolve();

describe("ChunkUploader", () => {
  it("returns the ACK on first success", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const up = new ChunkUploader({ baseUrl: "http://x", fetchImpl: fetchImpl as never, sleep: noSleep });
    const res = await up.upload(meta(), new Blob(["abc"]));
    expect(res.ack.accepted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries retryable errors then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429, "RATE_LIMITED", true))
      .mockResolvedValueOnce(errorResponse(500, "INTERNAL_UPLOAD_ERROR", true))
      .mockResolvedValueOnce(okResponse());
    const onRetry = vi.fn();
    const up = new ChunkUploader({ baseUrl: "http://x", fetchImpl: fetchImpl as never, sleep: noSleep });
    const res = await up.upload(meta(), new Blob(["abc"]), onRetry);
    expect(res.ack.accepted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable errors", async () => {
    const fetchImpl = vi.fn(async () => errorResponse(404, "SESSION_NOT_FOUND", false));
    const up = new ChunkUploader({ baseUrl: "http://x", fetchImpl: fetchImpl as never, sleep: noSleep });
    await expect(up.upload(meta(), new Blob(["abc"]))).rejects.toBeInstanceOf(UploadError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats network errors as retryable and gives up after max retries", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const up = new ChunkUploader({ baseUrl: "http://x", fetchImpl: fetchImpl as never, sleep: noSleep });
    await expect(up.upload(meta(), new Blob(["abc"]))).rejects.toMatchObject({ retryable: true });
    // 1 initial + 7 retries = 8 attempts
    expect(fetchImpl).toHaveBeenCalledTimes(8);
  });

  it("does NOT resend an out-of-order chunk forever: retries are bounded then fail", async () => {
    // A persistent OUT_OF_ORDER_CHUNK (retryable) must not loop indefinitely.
    // The uploader retries the SAME chunk a bounded number of times and gives up;
    // it never reorders or resends beyond maxRetriesPerChunk.
    const fetchImpl = vi.fn(async () => errorResponse(409, "OUT_OF_ORDER_CHUNK", true));
    const up = new ChunkUploader({ baseUrl: "http://x", fetchImpl: fetchImpl as never, sleep: noSleep });

    let err: UploadError | undefined;
    try {
      await up.upload(meta(), new Blob(["abc"]));
    } catch (e) {
      err = e as UploadError;
    }
    expect(err).toBeInstanceOf(UploadError);
    expect(err?.code).toBe("OUT_OF_ORDER_CHUNK");
    // Bounded: 1 initial + 7 retries = 8 attempts, then it stops (no infinite loop).
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    // Every attempt targeted the exact same chunkIndex (no silent reordering).
    for (const call of fetchImpl.mock.calls) {
      const form = (call as unknown as [string, { body: FormData }])[1].body;
      expect(JSON.parse(form.get("meta") as string).chunkIndex).toBe(0);
    }
  });
});
