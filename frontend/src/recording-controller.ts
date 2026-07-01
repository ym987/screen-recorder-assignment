// Wraps getUserMedia + MediaRecorder to emit a chunk every CHUNK_INTERVAL_MS.

import { CHECKSUM_ALGO, CHUNK_INTERVAL_MS, makeIdempotencyKey, type ChunkMetadata } from "../../shared/contract.js";
import { sha256Hex } from "./checksum.js";

export interface CreatedChunk {
  meta: ChunkMetadata;
  blob: Blob;
  /**
   * True when this chunk was emitted via the fast emergency tail-flush and its
   * checksum was deliberately not computed yet (to keep the unload-time write
   * short). The checksum is filled in later, before upload.
   */
  checksumPending?: boolean;
}

/**
 * What the user wants to capture:
 * - "screen": a tab / window / screen (with its audio when available), via
 *   getDisplayMedia. The browser's own picker lets the user choose which
 *   tab, window or the whole screen to share.
 */
export type CaptureMode = "screen";

export interface RecordingControllerOptions {
  intervalMs?: number;
  displayMimePreference?: string[];
  onChunk: (chunk: CreatedChunk) => void | Promise<void>;
  onError?: (err: Error) => void;
  /** Called when the user stops the screen share via the browser control. */
  onCaptureEnded?: () => void;
}

const DEFAULT_DISPLAY_MIME_PREFERENCE = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export function pickMimeType(preference: string[]): string {
  const supported =
    typeof MediaRecorder !== "undefined" && typeof MediaRecorder.isTypeSupported === "function";
  if (supported) {
    for (const m of preference) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
  }
  return preference[0] ?? "video/webm";
}

export class RecordingController {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private intervalMs: number;
  private displayMimePreference: string[];
  private onChunk: (chunk: CreatedChunk) => void | Promise<void>;
  private onError?: (err: Error) => void;
  private onCaptureEnded?: () => void;

  // Tracks in-flight chunk pipelines so stop() can await the final flush.
  private pendingEmits = new Set<Promise<void>>();

  // One-shot flag: the next emitted chunk is an emergency tail flush and should
  // skip checksum computation to keep the unload-time persistence path short.
  private tailFast = false;

  // True while a recording session is running. Because each chunk is produced by
  // its own MediaRecorder start/stop cycle, `active` (not the momentary
  // recorder.state, which flips to "inactive" between chunks) is the source of
  // truth for "are we recording".
  private active = false;
  // Set when the page is being torn down (reload/close). In this mode we do
  // a one-shot final flush and avoid scheduling any new recorders/timers.
  private unloading = false;
  private chunkTimer: ReturnType<typeof setInterval> | null = null;

  private sessionId = "";
  private segmentIndex = 0;
  private chunkIndex = 0;
  private mimeType = "audio/webm";
  private chunkStartedAt = 0;

  constructor(opts: RecordingControllerOptions) {
    this.intervalMs = opts.intervalMs ?? CHUNK_INTERVAL_MS;
    this.displayMimePreference = opts.displayMimePreference ?? DEFAULT_DISPLAY_MIME_PREFERENCE;
    this.onChunk = opts.onChunk;
    this.onError = opts.onError;
    this.onCaptureEnded = opts.onCaptureEnded;
  }

  get isRecording(): boolean {
    return this.active;
  }

  get currentSegmentIndex(): number {
    return this.segmentIndex;
  }

  /**
   * Start a recording segment under the given session/segment.
   *
   * Each chunk is emitted as a **self-contained media file**. Instead of one
   * long MediaRecorder stream sliced into header-less fragments (where only the
   * first chunk carries the WebM header), we run a fresh `MediaRecorder`
   * start/stop cycle every `intervalMs`. Every stop yields a complete container
   * (its own EBML header + initial keyframe), so any single chunk plays on its
   * own and a lost chunk never breaks the others.
   *
   * Trade-off: cycling the recorder drops a few milliseconds of audio at each
   * chunk boundary — accepted in exchange for per-chunk independence.
   */
  async start(
    sessionId: string,
    segmentIndex: number,
    startChunkIndex = 0,
    captureMode: CaptureMode = "screen",
  ): Promise<string> {
    this.sessionId = sessionId;
    this.segmentIndex = segmentIndex;
    this.chunkIndex = startChunkIndex;

    const preference = this.displayMimePreference;
    this.stream = await this.acquireStream(captureMode);
    this.mimeType = pickMimeType(preference);

    // When the user ends the screen share from the browser's own control, the
    // capture track fires "ended"; surface it so the app can stop cleanly.
    for (const track of this.stream.getVideoTracks()) {
      track.addEventListener("ended", () => this.onCaptureEnded?.());
    }

    this.active = true;
    this.startChunkRecorder();

    // Roll to a new standalone chunk every intervalMs.
    this.chunkTimer = setInterval(() => this.rollChunk(), this.intervalMs);
    return this.mimeType;
  }

  private async acquireStream(_captureMode: CaptureMode): Promise<MediaStream> {
    // The browser picker lets the user choose a tab, a window or the whole
    // screen, and (where supported) share that source's audio too.
    return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  }

  /**
   * Create and start a fresh MediaRecorder for a single chunk. On stop it emits
   * one complete media file; if the session is still active it immediately
   * chains into the next chunk's recorder for near-continuous capture.
   */
  private startChunkRecorder(): void {
    if (!this.stream || this.unloading) return;
    const recorder = new MediaRecorder(this.stream, { mimeType: this.mimeType });
    this.chunkStartedAt = Date.now();

    recorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) {
        const fast = this.tailFast;
        this.tailFast = false;
        const startedAt = new Date(this.chunkStartedAt).toISOString();
        const p = this.emitChunk(ev.data, fast, startedAt).finally(() => {
          this.pendingEmits.delete(p);
        });
        this.pendingEmits.add(p);
      }
    };
    recorder.onstop = () => {
      // Chain into the next standalone chunk unless the session has stopped.
      if (this.active && !this.unloading) this.startChunkRecorder();
    };
    recorder.onerror = (ev: Event) => {
      const err = (ev as unknown as { error?: Error }).error ?? new Error("MediaRecorder error");
      this.onError?.(err);
    };

    this.recorder = recorder;
    // No timeslice: the whole recording is emitted as one complete blob on stop.
    recorder.start();
  }

  /**
   * Stop the current chunk recorder so it flushes a complete file; its onstop
   * handler then starts the next one (while the session is still active).
   */
  private rollChunk(): void {
    if (this.recorder && this.recorder.state === "recording") {
      this.recorder.stop();
    }
  }

  private async emitChunk(blob: Blob, fast: boolean, startedAt: string): Promise<void> {
    const index = this.chunkIndex++;
    // Emergency tail flush: skip the (async, CPU-heavy) checksum so the durable
    // write to IndexedDB is as short as possible before the page is destroyed.
    // The checksum is computed later, on recovery, before the chunk is uploaded.
    let checksum = "";
    if (!fast) {
      const buf = await blob.arrayBuffer();
      checksum = await sha256Hex(buf);
    }
    const meta: ChunkMetadata = {
      sessionId: this.sessionId,
      segmentIndex: this.segmentIndex,
      chunkIndex: index,
      clientTimestamp: new Date().toISOString(),
      startedAt,
      durationMs: this.intervalMs,
      mimeType: this.mimeType,
      sizeBytes: blob.size,
      checksumAlgo: CHECKSUM_ALGO,
      checksum,
      idempotencyKey: makeIdempotencyKey(this.sessionId, this.segmentIndex, index),
    };
    await this.onChunk({ meta, blob, checksumPending: fast });
  }

  /**
   * Force-close the current chunk into a complete, standalone file and keep
   * recording. Used to persist the in-progress tail before the page is
   * hidden/unloaded so it survives a reload or accidental close.
   */
  flush(): void {
    this.rollChunk();
  }

  /**
   * Emergency variant of {@link flush} for the page-hide/unload path: closes the
   * current chunk into a complete file but skips checksum computation so the
   * durable write finishes in the tiny window the browser gives before
   * destroying the page. The checksum is filled in later, on recovery.
   */
  flushTail(): void {
    if (this.recorder && this.recorder.state === "recording") {
      this.tailFast = true;
      this.recorder.stop();
    }
  }

  /**
   * Final best-effort tail flush for reload/close.
   *
   * Unlike regular flushTail(), this avoids any follow-up chunk scheduling,
   * which keeps the unload path shorter and improves the chance the durable
   * write finishes before the page is destroyed.
   */
  flushTailForUnload(): void {
    this.unloading = true;
    this.active = false;
    if (this.chunkTimer) {
      clearInterval(this.chunkTimer);
      this.chunkTimer = null;
    }
    if (this.recorder && this.recorder.state === "recording") {
      this.tailFast = true;
      this.recorder.stop();
    }
  }

  /** Stop recording and flush the final chunk. Resolves after last chunk emitted. */
  async stop(): Promise<void> {
    // Prevent the onstop handler from chaining into a new chunk recorder.
    this.unloading = false;
    this.active = false;
    if (this.chunkTimer) {
      clearInterval(this.chunkTimer);
      this.chunkTimer = null;
    }

    const recorder = this.recorder;
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        const onStop = () => {
          recorder.removeEventListener("stop", onStop);
          resolve();
        };
        recorder.addEventListener("stop", onStop);
        recorder.stop(); // triggers a final dataavailable (complete file), then stop
      });
    }
    // Ensure the final chunk's pipeline (persist + enqueue) has fully settled
    // before we resolve, so the complete barrier can't run ahead of it.
    await this.flushPending();
    this.teardown();
  }

  /** Await all in-flight chunk pipelines (including any started during the wait). */
  private async flushPending(): Promise<void> {
    while (this.pendingEmits.size > 0) {
      await Promise.allSettled([...this.pendingEmits]);
    }
  }

  private teardown(): void {
    this.unloading = false;
    this.active = false;
    if (this.chunkTimer) {
      clearInterval(this.chunkTimer);
      this.chunkTimer = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }
}
