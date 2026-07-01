# Audio Chunk Upload System - Fixed MVP Plan

## 1) Unified JSON Contract (Client <-> Server)

### 1.1 Common Envelopes

```json
{
  "requestId": "uuid",
  "serverTime": "2026-07-01T10:15:30.000Z"
}
```

```json
{
  "error": {
    "code": "OUT_OF_ORDER_CHUNK",
    "message": "Expected chunkIndex 12 in segment 3",
    "retryable": true
  },
  "requestId": "uuid",
  "serverTime": "2026-07-01T10:15:30.000Z"
}
```

### 1.2 Session Model

```json
{
  "sessionId": "uuid",
  "status": "active",
  "createdAt": "2026-07-01T10:00:00.000Z",
  "interruptedAt": null,
  "expiresAt": "2026-07-01T10:05:00.000Z",
  "finalTtlExpiresAt": "2026-07-01T11:00:00.000Z"
}
```

Allowed `status` values:
- `active`
- `interrupted`
- `completed`
- `expired`

### 1.3 Checkpoint Model

```json
{
  "sessionId": "uuid",
  "status": "active",
  "lastAcceptedSegmentIndex": 2,
  "lastAcceptedChunkIndexBySegment": {
    "0": 14,
    "1": 22,
    "2": 5
  },
  "updatedAt": "2026-07-01T10:15:30.000Z"
}
```

### 1.4 Chunk Metadata (sent with each upload)

```json
{
  "sessionId": "uuid",
  "segmentIndex": 2,
  "chunkIndex": 5,
  "clientTimestamp": "2026-07-01T10:15:20.000Z",
  "startedAt": "2026-07-01T10:14:50.000Z",
  "durationMs": 30000,
  "mimeType": "audio/webm;codecs=opus",
  "sizeBytes": 284512,
  "checksumAlgo": "sha256",
  "checksum": "hex_or_base64",
  "idempotencyKey": "session:uuid|segment:2|chunk:5"
}
```

### 1.5 Chunk ACK

```json
{
  "sessionId": "uuid",
  "segmentIndex": 2,
  "chunkIndex": 5,
  "accepted": true,
  "duplicate": false,
  "lastAcceptedSegmentIndex": 2,
  "lastAcceptedChunkIndexBySegment": {
    "0": 14,
    "1": 22,
    "2": 5
  },
  "serverStoredAt": "2026-07-01T10:15:30.000Z"
}
```

## 2) API Contract (Minimal + Complete)

### 2.1 Start Session

`POST /sessions/start`

Request:
```json
{
  "clientId": "browser-instance-123",
  "mimePreference": [
    "audio/webm;codecs=opus",
    "audio/webm"
  ]
}
```

Response `201`:
```json
{
  "session": {
    "sessionId": "uuid",
    "status": "active",
    "createdAt": "2026-07-01T10:00:00.000Z",
    "interruptedAt": null,
    "expiresAt": "2026-07-01T10:05:00.000Z",
    "finalTtlExpiresAt": "2026-07-01T11:00:00.000Z"
  }
}
```

### 2.2 Resume Session

`POST /sessions/{sessionId}/resume`

Request:
```json
{
  "lastKnownSegmentIndex": 2,
  "lastKnownChunkIndexBySegment": {
    "2": 4
  }
}
```

Response `200`:
```json
{
  "session": {
    "sessionId": "uuid",
    "status": "active",
    "createdAt": "2026-07-01T10:00:00.000Z",
    "interruptedAt": null,
    "expiresAt": "2026-07-01T10:05:00.000Z",
    "finalTtlExpiresAt": "2026-07-01T11:00:00.000Z"
  },
  "checkpoint": {
    "sessionId": "uuid",
    "status": "active",
    "lastAcceptedSegmentIndex": 2,
    "lastAcceptedChunkIndexBySegment": {
      "0": 14,
      "1": 22,
      "2": 5
    },
    "updatedAt": "2026-07-01T10:15:30.000Z"
  },
  "resumable": true
}
```

### 2.3 Get Checkpoint

`GET /sessions/{sessionId}/checkpoint`

Response `200`:
```json
{
  "checkpoint": {
    "sessionId": "uuid",
    "status": "active",
    "lastAcceptedSegmentIndex": 2,
    "lastAcceptedChunkIndexBySegment": {
      "0": 14,
      "1": 22,
      "2": 5
    },
    "updatedAt": "2026-07-01T10:15:30.000Z"
  }
}
```

### 2.4 Upload Chunk

`POST /sessions/{sessionId}/chunks`

Content-Type: `multipart/form-data`
- `meta`: JSON (Chunk Metadata)
- `blob`: binary audio chunk

Response `200`:
```json
{
  "ack": {
    "sessionId": "uuid",
    "segmentIndex": 2,
    "chunkIndex": 5,
    "accepted": true,
    "duplicate": false,
    "lastAcceptedSegmentIndex": 2,
    "lastAcceptedChunkIndexBySegment": {
      "0": 14,
      "1": 22,
      "2": 5
    },
    "serverStoredAt": "2026-07-01T10:15:30.000Z"
  }
}
```

### 2.5 Complete Session

`POST /sessions/{sessionId}/complete`

Request:
```json
{
  "expectedLastSegmentIndex": 2,
  "expectedLastChunkIndexBySegment": {
    "0": 14,
    "1": 22,
    "2": 5
  },
  "idempotencyKey": "complete:uuid"
}
```

Response `200`:
```json
{
  "sessionId": "uuid",
  "status": "completed",
  "receivedSegments": 3,
  "receivedChunksTotal": 43,
  "missingChunks": []
}
```

## 3) Protocol Rules (Fixed)

1. Ordering rule:
- Server accepts only `chunkIndex = lastAccepted + 1` per `segmentIndex`.
- Duplicate chunk (same `idempotencyKey`) returns `200` with `duplicate: true`.
- Out-of-order returns `409 OUT_OF_ORDER_CHUNK` (`retryable: true`).

2. Idempotency rule:
- Unique key: `sessionId + segmentIndex + chunkIndex`.
- Complete endpoint also idempotent by complete idempotency key.

3. Checksum rule:
- Required algorithm: `sha256`.
- Server validates checksum before ACK.

## 4) Retry / Resume / State Policy (Fixed)

1. Retry policy:
- Backoff: `1s, 2s, 4s, 8s, 16s` (max delay 16s).
- Max retries per chunk: `7`.
- Request timeout per attempt: `20s`.

2. Circuit breaker:
- If 5 consecutive chunks fail final retry, state becomes `error` and recording is paused.

3. Resume policy after refresh:
- Keep same `sessionId`.
- Open new recording `segmentIndex = lastAcceptedSegmentIndex + 1`.
- Reconcile local queue with server checkpoint before next upload.

4. Complete barrier (hard rule):
- `complete` is blocked while queue has any pending item.
- `complete` only after all local chunks are ACKed.

## 5) Local Storage Limits (Why + Numbers)

Why limit is mandatory:
- Browser quota is not stable across devices and can be reclaimed by browser/OS.
- Long offline recording can grow unexpectedly.
- Failure at write-time is worse than controlled backpressure.

Recommended limits:
- Soft limit: `150MB` -> show warning banner.
- Hard limit: `300MB` or `20%` of effective quota (lower value wins).
- At hard limit: pause recorder and keep uploader active until usage drops.

## 6) Deletion / Retention Policy (Fixed)

1. On positive ACK:
- Delete chunk blob from IndexedDB immediately.
- Keep tiny tombstone (`sessionId`, `segmentIndex`, `chunkIndex`, `ackedAt`) for 30 minutes.

2. On final failure (after max retries):
- Mark chunk `permanent_failed`.
- Keep chunk for manual retry UI action or auto-clean policy.

3. On complete success:
- Remove all remaining session chunks and metadata.

4. On expiration:
- Background cleaner removes expired sessions + blobs.

## 7) Minimal Telemetry (Clarified)

Collect these counters/timers:
- `chunks_created_total`
- `chunks_uploaded_ok_total`
- `chunks_duplicate_total`
- `chunks_failed_total`
- `retry_attempts_total`
- `time_to_recover_ms`
- `complete_blocked_total`

Why this is enough for MVP:
- Detect unstable networks quickly.
- Measure whether backoff is too aggressive or too weak.
- Prove that resume flow is actually working.

## 8) WebM Merge Risk (Detailed + Fixed)

Problem details:
- Every new segment can contain container headers.
- Naive binary concatenation is often invalid.
- Timestamp discontinuity after refresh may cause playback glitches.

MVP-safe solution:
1. Store per-segment files + `manifest.json` first.
2. Mark session complete based on validated chunk set, not immediate merge.
3. Run asynchronous remux job for single-file output.
4. If remux fails:
- keep session as `completed_with_segments`
- expose segment list for download/playback
- add remediation log entry

## 9) Error Codes (Server)

- `SESSION_NOT_FOUND` -> 404, retryable false
- `SESSION_EXPIRED` -> 410, retryable false
- `SESSION_NOT_RESUMABLE` -> 409, retryable false
- `OUT_OF_ORDER_CHUNK` -> 409, retryable true
- `CHECKSUM_MISMATCH` -> 422, retryable true
- `PAYLOAD_TOO_LARGE` -> 413, retryable false
- `RATE_LIMITED` -> 429, retryable true
- `INTERNAL_UPLOAD_ERROR` -> 500, retryable true

## 10) Final Recommendation

Use this exact MVP profile:
- Vanilla TypeScript client
- Node/Express mock server
- HTTP multipart chunk upload
- strict idempotency + checkpoint reconcile
- hard complete barrier
- bounded IndexedDB + deterministic cleanup
- asynchronous remux

This profile keeps implementation simple while closing the main reliability gaps identified in the original plan.
