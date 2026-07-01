// Wires UI <-> services: recording, queue, uploads, session continuity,
// recovery-on-load and the hard complete barrier.

import { makeIdempotencyKey, type CheckpointModel } from "../../shared/contract.js";
import { ApiClient } from "./api-client.js";
import { ChunkUploader } from "./chunk-uploader.js";
import { Idb, type LocalSessionState } from "./idb.js";
import { RecordingController, type CaptureMode, type CreatedChunk } from "./recording-controller.js";
import { Store } from "./state/store.js";
import { evaluatePressure } from "./storage-guard.js";
import { UploadQueue } from "./upload-queue.js";

function resolveBaseUrl(): string {
  const override = (window as { __API_BASE__?: string }).__API_BASE__;
  if (override) return override;
  // Served from the backend (same origin) -> talk to the current origin, no CORS.
  if (location.protocol === "http:" || location.protocol === "https:") return location.origin;
  // Opened directly as a local file (file://) -> cannot reach the API.
  return "http://localhost:3000";
}

const BASE_URL = resolveBaseUrl();
const CLIENT_ID = "browser-" + Math.random().toString(36).slice(2, 10);

// Console logging for every client-side operation.
function log(op: string, details?: unknown): void {
  if (details !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`[recorder] ${op}`, details);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[recorder] ${op}`);
  }
}

const store = new Store();
const idb = new Idb();
const api = new ApiClient(BASE_URL);
const uploader = new ChunkUploader({ baseUrl: BASE_URL });
const queue = new UploadQueue(idb, uploader, store, {
  onCircuitBroken: () => setButtons(true, false),
});

let recorder: RecordingController;
let currentSessionId: string | null = null;
let currentSegmentIndex = 0;
let currentCaptureMode: CaptureMode = "microphone";
const lastChunkIndexBySegment: Record<string, number> = {};
let recorderPausedForStorage = false;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function selectedCaptureMode(): CaptureMode {
  const value = ($("captureMode") as HTMLSelectElement).value;
  return value === "screen" ? "screen" : "microphone";
}

function mimePreferenceFor(mode: CaptureMode): string[] {
  return mode === "screen"
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    : ["audio/webm;codecs=opus", "audio/webm"];
}

function setButtons(startEnabled: boolean, stopEnabled: boolean): void {
  ($("btnStart") as HTMLButtonElement).disabled = !startEnabled;
  ($("btnStop") as HTMLButtonElement).disabled = !stopEnabled;
  // The source can only be changed while not actively recording.
  ($("captureMode") as HTMLSelectElement).disabled = !startEnabled;
}

function setNewButton(enabled: boolean): void {
  ($("btnNew") as HTMLButtonElement).disabled = !enabled;
}

function render(): void {
  const s = store.getState();
  $("state").textContent = s.state;
  $("state").className = "state state-" + s.state;
  $("message").textContent = s.message;
  $("sessionId").textContent = s.sessionId ?? "—";
  $("segment").textContent = String(s.segmentIndex);
  $("cCreated").textContent = String(s.chunksCreated);
  $("cUploaded").textContent = String(s.chunksUploaded);
  $("cDuplicate").textContent = String(s.chunksDuplicate);
  $("cFailed").textContent = String(s.chunksFailed);
  $("cPending").textContent = String(s.pending);
  $("banner").style.display = s.storageWarning ? "block" : "none";
  $("errorBox").style.display = s.lastError ? "block" : "none";
  $("errorBox").textContent = s.lastError ?? "";
}

// ---------------------------------------------------------------------------
// Chunk pipeline
// ---------------------------------------------------------------------------

async function onChunkCreated(chunk: CreatedChunk): Promise<void> {
  lastChunkIndexBySegment[String(chunk.meta.segmentIndex)] = chunk.meta.chunkIndex;
  const s = store.getState();
  store.update({ chunksCreated: s.chunksCreated + 1 }, "chunk_created");
  log("chunkCreated", {
    segmentIndex: chunk.meta.segmentIndex,
    chunkIndex: chunk.meta.chunkIndex,
    sizeBytes: chunk.meta.sizeBytes,
    checksumPending: Boolean(chunk.checksumPending),
  });

  if (chunk.checksumPending) {
    // Emergency tail flush (page hidden/closing): take the shortest durable path
    // so the write can finish before the page dies -- persist the blob + session
    // and skip checksum (deferred to recovery) and storage-pressure evaluation.
    await queue.enqueue(chunk.meta, chunk.blob, true);
    await persistLocalSession();
    return;
  }

  await persistLocalSession();
  await queue.enqueue(chunk.meta, chunk.blob);
  await applyStoragePressure();
}

async function persistLocalSession(): Promise<void> {
  if (!currentSessionId) return;
  await idb.saveSession({
    sessionId: currentSessionId,
    segmentIndex: currentSegmentIndex,
    lastChunkIndexBySegment: { ...lastChunkIndexBySegment },
  });
}

async function applyStoragePressure(): Promise<void> {
  const used = await idb.totalStoredBytes();
  const pressure = await evaluatePressure(used);
  if (pressure === "hard" && recorder.isRecording) {
    recorderPausedForStorage = true;
    await recorder.stop();
    store.update({ storageWarning: true, message: "אחסון מלא — ההקלטה הושהתה עד שהתור יתרוקן" }, "storage_warning");
  } else if (pressure === "soft") {
    store.update({ storageWarning: true }, "storage_warning");
  } else {
    store.update({ storageWarning: false });
  }
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

async function handleStart(): Promise<void> {
  setButtons(false, false);
  try {
    const captureMode = selectedCaptureMode();
    currentCaptureMode = captureMode;
    log("handleStart", { captureMode });
    const local = await idb.getSession();
    if (local) {
      const resumed = await tryResume(local);
      if (!resumed) await startFreshSession(captureMode);
    } else {
      await startFreshSession(captureMode);
    }

    store.transition("recording");
    const mime = await recorder.start(currentSessionId!, currentSegmentIndex, 0, captureMode);
    store.update(
      { sessionId: currentSessionId, segmentIndex: currentSegmentIndex, message: `מקליט (${mime})` },
      "record_started",
    );
    await persistLocalSession();
    setButtons(false, true);
    setNewButton(false);
  } catch (err) {
    store.transition("error");
    store.update({ lastError: err instanceof Error ? err.message : String(err), message: "כשל בתחילת הקלטה" }, "error");
    setButtons(true, false);
  }
}

async function startFreshSession(captureMode: CaptureMode = "microphone"): Promise<void> {
  const session = await api.startSession(CLIENT_ID, mimePreferenceFor(captureMode));
  currentSessionId = session.sessionId;
  currentSegmentIndex = 0;
  for (const k of Object.keys(lastChunkIndexBySegment)) delete lastChunkIndexBySegment[k];
  // Reset per-session counters so a brand-new call starts counting from zero.
  store.update({
    chunksCreated: 0,
    chunksUploaded: 0,
    chunksDuplicate: 0,
    chunksFailed: 0,
    pending: 0,
  });
  log("startFreshSession", { sessionId: session.sessionId });
}

/** Resume an existing local session; returns false if server rejects it. */
async function tryResume(local: LocalSessionState): Promise<boolean> {
  try {
    const result = await api.resumeSession(
      local.sessionId,
      local.segmentIndex,
      local.lastChunkIndexBySegment,
    );
    if (!result.resumable) return false;
    currentSessionId = local.sessionId;
    currentSegmentIndex = result.checkpoint.lastAcceptedSegmentIndex + 1;
    await queue.reconcile(result.checkpoint);
    queue.resume();
    store.transition("recovered");
    store.update({ message: "שוחזרה שיחה קיימת — ממשיך ב-segment חדש" }, "resumed");
    log("tryResume:success", { sessionId: local.sessionId, segmentIndex: currentSegmentIndex });
    return true;
  } catch {
    // Session expired / not resumable -> caller starts fresh.
    await idb.clearSession();
    log("tryResume:rejected", { sessionId: local.sessionId });
    return false;
  }
}

async function handleStop(): Promise<void> {
  setButtons(false, false);
  try {
    log("handleStop", { sessionId: currentSessionId });
    if (recorder.isRecording) {
      store.update({ message: "עוצר ומבצע flush אחרון..." });
      await recorder.stop();
    }

    // Hard complete barrier: wait until every local chunk is ACKed.
    store.update({ message: "ממתין לסיום העלאות (complete barrier)..." });
    await waitForDrain();

    if (!currentSessionId) return;
    const expectedLastSegmentIndex = currentSegmentIndex;
    const idempotencyKey = "complete:" + currentSessionId;
    const summary = await api.completeSession(
      currentSessionId,
      expectedLastSegmentIndex,
      { ...lastChunkIndexBySegment },
      idempotencyKey,
    );

    if (summary.missingChunks.length === 0) {
      store.transition("success");
      store.update(
        { message: `הושלם: ${summary.receivedChunksTotal} chunks ב-${summary.receivedSegments} segments` },
        "completed",
      );
      log("completeSession:success", {
        sessionId: currentSessionId,
        receivedChunksTotal: summary.receivedChunksTotal,
        receivedSegments: summary.receivedSegments,
      });
    } else {
      store.transition("error");
      store.update(
        { message: `הושלם חלקית — חסרים ${summary.missingChunks.length} chunks`, lastError: "missing chunks" },
        "error",
      );
      log("completeSession:partial", {
        sessionId: currentSessionId,
        missingChunks: summary.missingChunks.length,
      });
    }

    await idb.clearSessionData(currentSessionId);
    await idb.clearSession();
    currentSessionId = null;
    for (const k of Object.keys(lastChunkIndexBySegment)) delete lastChunkIndexBySegment[k];
  } catch (err) {
    store.transition("error");
    store.update({ lastError: err instanceof Error ? err.message : String(err), message: "כשל בסגירת שיחה" }, "error");
  } finally {
    setButtons(true, false);
  }
}

/** Block until the upload queue is empty (or circuit is broken). */
async function waitForDrain(): Promise<void> {
  for (;;) {
    if (store.getState().state === "error") return; // circuit broken
    const pending = await queue.pendingCount();
    if (pending === 0) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ---------------------------------------------------------------------------
// New session (discard a recovered session without recording/completing it)
// ---------------------------------------------------------------------------

/**
 * Abandon a session that was recovered after a page reload and prepare a fresh
 * one, without having to start a recording and complete it first. The next
 * Start click will open a brand-new session.
 */
async function handleNewSession(): Promise<void> {
  setButtons(false, false);
  setNewButton(false);
  try {
    log("handleNewSession", { previousSessionId: currentSessionId });
    if (recorder?.isRecording) await recorder.stop();

    // Drop the recovered session's local queue + metadata so nothing from the
    // old conversation keeps uploading under the new one.
    if (currentSessionId) await idb.clearSessionData(currentSessionId);
    await idb.clearSession();
    queue.resume(); // reset any circuit-break/stop flag for the next session

    currentSessionId = null;
    currentSegmentIndex = 0;
    for (const k of Object.keys(lastChunkIndexBySegment)) delete lastChunkIndexBySegment[k];

    store.transition("idle");
    store.update(
      {
        sessionId: null,
        segmentIndex: 0,
        chunksCreated: 0,
        chunksUploaded: 0,
        chunksDuplicate: 0,
        chunksFailed: 0,
        pending: 0,
        storageWarning: false,
        lastError: null,
        message: "שיחה חדשה מוכנה — לחץ התחל כדי להקליט",
      },
    );
  } finally {
    setButtons(true, false);
  }
}

// ---------------------------------------------------------------------------
// Recovery on load (refresh handling)
// ---------------------------------------------------------------------------

async function recoverOnLoad(): Promise<void> {
  await queue.cleanup();
  const local = await idb.getSession();
  if (!local) return;
  log("recoverOnLoad", { sessionId: local.sessionId, segmentIndex: local.segmentIndex });
  try {
    const result = await api.resumeSession(
      local.sessionId,
      local.segmentIndex,
      local.lastChunkIndexBySegment,
    );
    currentSessionId = local.sessionId;
    Object.assign(lastChunkIndexBySegment, local.lastChunkIndexBySegment);
    await reconcileAndDrain(result.checkpoint);
    store.transition("recovered");
    store.update(
      { sessionId: local.sessionId, segmentIndex: local.segmentIndex, message: "שוחזר לאחר רענון — לחץ Start להמשך או ”שיחה חדשה“ לפתיחת שיחה חדשה" },
      "recovered",
    );
    setNewButton(true);
  } catch {
    await idb.clearSession();
    store.update({ message: "השיחה הקודמת פגה — מוכן לשיחה חדשה" });
  }
}

async function reconcileAndDrain(checkpoint: CheckpointModel): Promise<void> {
  await queue.reconcile(checkpoint);
  queue.resume();
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function boot(): void {
  store.subscribe(() => render());

  // Log every state-store event (covers events emitted from the upload queue too).
  store.subscribe((snapshot, event) => {
    if (!event) return;
    log(`event:${event}`, {
      state: snapshot.state,
      created: snapshot.chunksCreated,
      uploaded: snapshot.chunksUploaded,
      duplicate: snapshot.chunksDuplicate,
      failed: snapshot.chunksFailed,
      pending: snapshot.pending,
    });
  });

  // Opened as file:// -> the server (uploads) isn't reachable and the microphone
  // may be blocked, but screen capture (getDisplayMedia) still works. So we no
  // longer disable everything here; we just surface a non-blocking note and let
  // the user record. Failures (e.g. an unreachable server) surface on their own.
  // if (location.protocol === "file:") {
  //   store.update({
  //     message: "הרצה דרך file:// — הקלטת מסך זמינה. להעלאה לשרת ולמיקרופון הרץ npm start וגש ל-http://localhost:3000",
  //   });
  // }

  recorder = new RecordingController({
    onChunk: (c) => onChunkCreated(c),
    onError: (err) => {
      store.transition("error");
      store.update({ lastError: err.message, message: "שגיאת הקלטה" }, "error");
    },
    onCaptureEnded: () => {
      // User pressed the browser's "Stop sharing" control -> stop like the Stop button.
      if (recorder?.isRecording) void handleStop();
    },
  });

  $("btnStart").addEventListener("click", () => void handleStart());
  $("btnStop").addEventListener("click", () => void handleStop());
  $("btnNew").addEventListener("click", () => void handleNewSession());
  setButtons(true, false);
  setNewButton(false);

  // Persist the in-progress recording tail if the page is hidden or closed, so
  // the audio buffered since the last 30s boundary isn't lost on reload/close.
  // visibilitychange (hidden) / pagehide fire before the page is destroyed and
  // give IndexedDB the best chance to finish the write (best-effort). flushTail()
  // skips checksum so the write is short enough to actually complete in time.
  document.addEventListener("visibilitychange", () => {
    // In screen-capture mode the recorder tab is normally hidden (the user is
    // looking at the shared surface), so a hide is NOT a sign the page is about
    // to be destroyed -- flushing here would emit a spurious near-empty chunk at
    // the very start. Real page teardown is still covered by "pagehide" below.
    if (
      document.visibilityState === "hidden" &&
      recorder?.isRecording &&
      currentCaptureMode !== "screen"
    ) {
      recorder.flushTail();
    }
  });
  window.addEventListener("pagehide", () => {
    if (recorder?.isRecording) recorder.flushTail();
  });
  // Guard against an accidental reload/close while recording is active.
  window.addEventListener("beforeunload", (e) => {
    if (recorder?.isRecording) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  void recoverOnLoad();

  // Mark example idempotency key format in a data attribute for debugging.
  $("app").setAttribute("data-idempotency-format", makeIdempotencyKey("<id>", 0, 0));

  // When the queue drains and recorder was paused for storage, allow restart.
  setInterval(async () => {
    if (recorderPausedForStorage) {
      const pending = await queue.pendingCount();
      if (pending === 0) {
        recorderPausedForStorage = false;
        store.update({ storageWarning: false, message: "אחסון פנוי — ניתן להמשיך הקלטה" });
        setButtons(true, false);
      }
    }
  }, 1000);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
}
