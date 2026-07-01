import { describe, expect, it, vi } from "vitest";

import { CHECKSUM_ALGO, ERROR_CODES, type ChunkMetadata } from "../../shared/contract.js";
import { ChunkUploader, UploadError } from "../../frontend/src/chunk-uploader.js";

function meta(): ChunkMetadata {
  return {
    sessionId: "s1",
    segmentIndex: 0,
    chunkIndex: 0,
    clientTimestamp: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    durationMs: 30000,
    mimeType: "video/webm",
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

  it("fails fast on non-retryable protocol errors (out-of-order / checksum): a single attempt", async () => {
    // Per the contract these are non-retryable: resending the identical chunk is
    // futile (a checksum mismatch stays mismatched; an out-of-order gap can't be
    // filled by a retry), so the uploader must give up after ONE attempt instead
    // of burning the whole backoff budget and tripping the circuit breaker.
    for (const code of ["OUT_OF_ORDER_CHUNK", "CHECKSUM_MISMATCH"] as const) {
      const spec = ERROR_CODES[code];
      expect(spec.retryable).toBe(false); // guard: contract keeps these non-retryable
      const fetchImpl = vi.fn(async () => errorResponse(spec.httpStatus, code, spec.retryable));
      const up = new ChunkUploader({ baseUrl: "http://x", fetchImpl: fetchImpl as never, sleep: noSleep });

      await expect(up.upload(meta(), new Blob(["abc"]))).rejects.toMatchObject({
        code,
        retryable: false,
      });
      // No resend: exactly one attempt for the whole upload.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("treats a malformed (non-JSON) 200 response body as a thrown error", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const up = new ChunkUploader({ baseUrl: "http://x", fetchImpl: fetchImpl as never, sleep: noSleep });
    await expect(up.attempt(meta(), new Blob(["abc"]))).rejects.toThrow();
  });

  it("treats 401 as non-retryable when there is no error body", async () => {
    const fetchImpl = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    const up = new ChunkUploader({ baseUrl: "http://x", fetchImpl: fetchImpl as never, sleep: noSleep });
    await expect(up.upload(meta(), new Blob(["abc"]))).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
