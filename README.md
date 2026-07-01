# Screen Chunk Upload

An MVP system for recording the screen and uploading it to a server in **30-second chunks**, with
**Retry**, **Resume**, and **Idempotency** mechanisms for high network resilience. The client is
written in Vanilla TypeScript (no framework) and the server is a Mock Server based on
Node/Express for protocol validation.

## Key Features

- **Continuous recording** – `MediaRecorder` (screen capture via `getDisplayMedia`) produces a
  chunk every 30 seconds.
- **Persistent upload queue** – The queue is stored in IndexedDB (Blob + metadata + checkpoint),
  so page refreshes or network drops do not lose data.
- **Exponential retry** – backoff `1s, 2s, 4s, 8s, 16s`, up to 7 attempts per chunk,
  20s timeout per attempt, and a circuit breaker after 5 consecutive failures.
- **Resume after refresh** – Recovery by `sessionId`, opening a new `segment` and continuing
  the upload from the checkpoint.
- **Idempotency + Checksum** – Every chunk carries an `idempotencyKey` and `sha256`; the server
  validates order and checksum before sending ACK.
- **Complete barrier** – Closing a session is only allowed after ACK for all chunks.
- **Storage policy** – soft limit of 150 MB (warning) and hard limit of 300 MB (recorder is
  paused until space is freed).

## Project Structure

```
shared/contract.ts       Shared data contract between client and server (envelopes, models, policies)
frontend/                Vanilla TS client
  index.html             HTML shell
  src/
    main.ts              UI <-> services wiring, recovery, complete barrier
    recording-controller.ts  MediaStream/MediaRecorder wrapper, chunk creation
    upload-queue.ts      Persistent upload queue (IndexedDB)
    chunk-uploader.ts    Upload with retry/timeout/idempotency
    api-client.ts        REST calls to the server
    checksum.ts          sha256 computation
    idb.ts               IndexedDB layer
    storage-guard.ts     Local storage limit enforcement
    state/store.ts       Small event-based state store
mock-server/src/
  server.ts              Express endpoints (start/resume/checkpoint/chunk/complete)
  session-store.ts       Session management, checkpoints, protocol validation
scripts/
  build.ts               Builds a single dist/index.html (JS inlined)
  dev.ts                 Dev runner: client + server on the same origin :3000 (live rebuild)
tests/                   Unit + integration tests (Vitest)
```

## API

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/sessions/start` | Create a new session (status=active) |
| `POST` | `/sessions/{id}/resume` | Resume an existing session + return checkpoint |
| `GET`  | `/sessions/{id}/checkpoint` | Get the current checkpoint state |
| `POST` | `/sessions/{id}/chunks` | Upload a chunk (`multipart`: `meta` JSON + `blob`) |
| `POST` | `/sessions/{id}/complete` | Close the session + receipt summary |

## Prerequisites

- Node.js 18+ (20+ recommended)
- npm

## Installation

```powershell
npm install
```

## Running

### Development mode

Runs the client and server on the same origin – `http://localhost:3000`. The client is rebuilt
on every request so edits appear on refresh, and serving from `http://localhost` provides the
secure context required by `getUserMedia`:

```powershell
npm run dev
```

### Build + run server

```powershell
npm start
```

This command builds a single `dist/index.html` file and starts the server.

### Additional commands

```powershell
npm run build     # Build a single dist/index.html (openable by double-click)
npm run server    # Run the server in watch mode
npm run typecheck # Type checking (tsc --noEmit)
npm test          # Run tests (Vitest)
npm run test:watch
```

## Tests

The project includes unit and integration tests run with Vitest:

```powershell
npm test
```

- `tests/unit/` – contract, session-store, store, uploader, upload-queue
- `tests/integration/` – full record → upload flow

## Known Limitations & Future Work

- **Multiple tabs in the same browser are not currently protected.** Two tabs in the same browser
  share the same IndexedDB and the same local session key (`"current"`), so opening two tabs and
  recording in both simultaneously may cause conflicts (shared upload queue and an overwritten
  session pointer). The server side itself properly isolates two separate browsers — each session
  is a UUID with a separate record — so two simultaneous recordings in two different browsers work
  correctly. Single-tab enforcement (e.g. via the Web Locks API or BroadcastChannel) remains
  **future work**.

## Notes

- When the client is served from the server (same origin) there is no CORS; when opened as a
  local file (`file://`) it points to `http://localhost:3000`.
- The API base URL can be overridden via `window.__API_BASE__`.
