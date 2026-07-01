// HTTP client that uploads a single chunk with retry/backoff + timeout.
// Idempotency is guaranteed by the stable idempotencyKey embedded in meta.

import {
  RETRY_POLICY,
  backoffDelayMs,
  type ApiError,
  type ChunkAck,
  type ChunkMetadata,
} from "../../shared/contract.js";

export interface UploadResult {
  ack: ChunkAck;
}

export class UploadError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
    public code?: string,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

export type FetchLike = typeof fetch;
export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export interface UploaderOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  sleep?: SleepFn;
}

export class ChunkUploader {
  private baseUrl: string;
  private fetchImpl: FetchLike;
  private sleep: SleepFn;

  constructor(opts: UploaderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    // Wrap fetch so it keeps its window binding (avoids "Illegal invocation").
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Single network attempt. Throws UploadError with retryable flag on failure. */
  async attempt(meta: ChunkMetadata, blob: Blob): Promise<UploadResult> {
    const form = new FormData();
    form.append("meta", JSON.stringify(meta));
    form.append("blob", blob, `chunk-${meta.chunkIndex}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RETRY_POLICY.requestTimeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/sessions/${meta.sessionId}/chunks`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      // Network failure / abort -> retryable.
      throw new UploadError(
        err instanceof Error ? err.message : "network error",
        true,
        "NETWORK",
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      const body = (await res.json()) as { ack: ChunkAck };
      return { ack: body.ack };
    }

    // Error envelope path.
    let apiError: ApiError | undefined;
    try {
      const body = (await res.json()) as { error?: ApiError };
      apiError = body.error;
    } catch {
      // fallthrough
    }
    const retryable = apiError?.retryable ?? (res.status >= 500 || res.status === 429);
    throw new UploadError(
      apiError?.message ?? `HTTP ${res.status}`,
      retryable,
      apiError?.code,
      res.status,
    );
  }

  /**
   * Upload with bounded exponential backoff.
   * Resolves with the ACK, or throws the final UploadError after max retries
   * (or immediately for non-retryable errors).
   */
  async upload(
    meta: ChunkMetadata,
    blob: Blob,
    onRetry?: (attempt: number, delayMs: number, err: UploadError) => void,
  ): Promise<UploadResult> {
    let lastErr: UploadError | undefined;
    // attempt 0 = first try; up to maxRetriesPerChunk additional tries.
    for (let attempt = 0; attempt <= RETRY_POLICY.maxRetriesPerChunk; attempt++) {
      try {
        return await this.attempt(meta, blob);
      } catch (err) {
        const uErr = err instanceof UploadError ? err : new UploadError(String(err), true);
        lastErr = uErr;
        if (!uErr.retryable || attempt === RETRY_POLICY.maxRetriesPerChunk) {
          throw uErr;
        }
        const delay = backoffDelayMs(attempt);
        onRetry?.(attempt + 1, delay, uErr);
        await this.sleep(delay);
      }
    }
    throw lastErr ?? new UploadError("upload failed", false);
  }
}
