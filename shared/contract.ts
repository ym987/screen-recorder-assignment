// Shared contract between client and server (Phase 1).
// Single source of truth for envelopes, models, API payloads and fixed policies.

// ---------------------------------------------------------------------------
// Common envelopes
// ---------------------------------------------------------------------------

export interface ResponseEnvelope {
  requestId: string;
  serverTime: string; // ISO-8601
}

export type ServerErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_EXPIRED"
  | "SESSION_NOT_RESUMABLE"
  | "OUT_OF_ORDER_CHUNK"
  | "CHECKSUM_MISMATCH"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "INTERNAL_UPLOAD_ERROR"
  | "BAD_REQUEST";

export interface ApiError {
  code: ServerErrorCode;
  message: string;
  retryable: boolean;
}

export interface ErrorEnvelope extends ResponseEnvelope {
  error: ApiError;
}

export interface ErrorCodeSpec {
  httpStatus: number;
  retryable: boolean;
}

// Fixed mapping of server error codes -> HTTP status + retryable flag.
export const ERROR_CODES: Record<ServerErrorCode, ErrorCodeSpec> = {
  SESSION_NOT_FOUND: { httpStatus: 404, retryable: false },
  SESSION_EXPIRED: { httpStatus: 410, retryable: false },
  SESSION_NOT_RESUMABLE: { httpStatus: 409, retryable: false },
  OUT_OF_ORDER_CHUNK: { httpStatus: 409, retryable: true },
  CHECKSUM_MISMATCH: { httpStatus: 422, retryable: true },
  PAYLOAD_TOO_LARGE: { httpStatus: 413, retryable: false },
  RATE_LIMITED: { httpStatus: 429, retryable: true },
  INTERNAL_UPLOAD_ERROR: { httpStatus: 500, retryable: true },
  BAD_REQUEST: { httpStatus: 400, retryable: false },
};

// ---------------------------------------------------------------------------
// Session + Checkpoint models
// ---------------------------------------------------------------------------

export type SessionStatus =
  | "active"
  | "interrupted"
  | "completed"
  | "completed_with_segments"
  | "expired";

export interface SessionModel {
  sessionId: string;
  status: SessionStatus;
  createdAt: string;
  interruptedAt: string | null;
  expiresAt: string; // short TTL -> interrupted
  finalTtlExpiresAt: string; // final TTL -> resume no longer allowed
}

export interface CheckpointModel {
  sessionId: string;
  status: SessionStatus;
  lastAcceptedSegmentIndex: number;
  // segmentIndex (as string key) -> last accepted chunkIndex
  lastAcceptedChunkIndexBySegment: Record<string, number>;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Chunk metadata + ACK
// ---------------------------------------------------------------------------

export const CHECKSUM_ALGO = "sha256" as const;

export interface ChunkMetadata {
  sessionId: string;
  segmentIndex: number;
  chunkIndex: number;
  clientTimestamp: string;
  startedAt: string;
  durationMs: number;
  mimeType: string;
  sizeBytes: number;
  checksumAlgo: typeof CHECKSUM_ALGO;
  checksum: string; // hex sha256
  idempotencyKey: string; // session:{id}|segment:{s}|chunk:{c}
}

export interface ChunkAck {
  sessionId: string;
  segmentIndex: number;
  chunkIndex: number;
  accepted: boolean;
  duplicate: boolean;
  lastAcceptedSegmentIndex: number;
  lastAcceptedChunkIndexBySegment: Record<string, number>;
  serverStoredAt: string;
}

// ---------------------------------------------------------------------------
// API request/response payloads
// ---------------------------------------------------------------------------

export interface StartSessionRequest {
  clientId: string;
  mimePreference: string[];
}
export interface StartSessionResponse extends ResponseEnvelope {
  session: SessionModel;
}

export interface ResumeSessionRequest {
  lastKnownSegmentIndex: number;
  lastKnownChunkIndexBySegment: Record<string, number>;
}
export interface ResumeSessionResponse extends ResponseEnvelope {
  session: SessionModel;
  checkpoint: CheckpointModel;
  resumable: boolean;
}

export interface GetCheckpointResponse extends ResponseEnvelope {
  checkpoint: CheckpointModel;
}

export interface UploadChunkResponse extends ResponseEnvelope {
  ack: ChunkAck;
}

export interface CompleteSessionRequest {
  expectedLastSegmentIndex: number;
  expectedLastChunkIndexBySegment: Record<string, number>;
  idempotencyKey: string;
}
export interface MissingChunk {
  segmentIndex: number;
  chunkIndex: number;
}
export interface CompleteSessionResponse extends ResponseEnvelope {
  sessionId: string;
  status: SessionStatus;
  receivedSegments: number;
  receivedChunksTotal: number;
  missingChunks: MissingChunk[];
}

// ---------------------------------------------------------------------------
// Fixed policies (shared so client + tests stay consistent)
// ---------------------------------------------------------------------------

export const RETRY_POLICY = {
  backoffMs: [1000, 2000, 4000, 8000, 16000] as const,
  maxDelayMs: 16000,
  maxRetriesPerChunk: 7,
  requestTimeoutMs: 20000,
  circuitBreakerConsecutiveFailures: 5,
} as const;

export const SESSION_TTL = {
  interruptedMs: 5 * 60 * 1000, // short TTL -> interrupted
  finalMs: 60 * 60 * 1000, // final TTL -> resume window
} as const;

export const STORAGE_LIMITS = {
  softLimitBytes: 150 * 1024 * 1024,
  hardLimitBytes: 300 * 1024 * 1024,
  hardLimitQuotaFraction: 0.2,
} as const;

export const RETENTION = {
  tombstoneTtlMs: 30 * 60 * 1000,
} as const;

export const CHUNK_INTERVAL_MS = 30000;

// Backoff delay for a given attempt (0-based). Clamped to maxDelayMs.
export function backoffDelayMs(attempt: number): number {
  const table = RETRY_POLICY.backoffMs;
  const idx = Math.min(attempt, table.length - 1);
  return Math.min(table[idx], RETRY_POLICY.maxDelayMs);
}

export function makeIdempotencyKey(
  sessionId: string,
  segmentIndex: number,
  chunkIndex: number,
): string {
  return `session:${sessionId}|segment:${segmentIndex}|chunk:${chunkIndex}`;
}
