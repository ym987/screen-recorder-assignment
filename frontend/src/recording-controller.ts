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
 * - "microphone": audio only, via getUserMedia.
 * - "screen": a tab / window / screen (with its audio when available), via
 *   getDisplayMedia. The browser's own picker lets the user choose which
 *   tab, window or the whole screen to share.
 */
export type CaptureMode = "microphone" | "screen";

export interface RecordingControllerOptions {
  intervalMs?: number;
  mimePreference?: string[];
  displayMimePreference?: string[];
  onChunk: (chunk: CreatedChunk) => void | Promise<void>;
  onError?: (err: Error) => void;
  /** Called when the user stops the screen share via the browser control. */
  onCaptureEnded?: () => void;
}

const DEFAULT_MIME_PREFERENCE = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

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
  return preference[0] ?? "audio/webm";
}

export class RecordingController {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private intervalMs: number;
  private mimePreference: string[];
  private displayMimePreference: string[];
  private onChunk: (chunk: CreatedChunk) => void | Promise<void>;
  private onError?: (err: Error) => void;
  private onCaptureEnded?: () => void;

  // Tracks in-flight chunk pipelines so stop() can await the final flush.
  private pendingEmits = new Set<Promise<void>>();

  // One-shot flag: the next emitted chunk is an emergency tail flush and should
  // skip checksum computation to keep the unload-time persistence path short.
  private tailFast = false;

  private sessionId = "";
  private segmentIndex = 0;
  private chunkIndex = 0;
  private segmentStartedAt = 0;

  constructor(opts: RecordingControllerOptions) {
    this.intervalMs = opts.intervalMs ?? CHUNK_INTERVAL_MS;
    this.mimePreference = opts.mimePreference ?? DEFAULT_MIME_PREFERENCE;
    this.displayMimePreference = opts.displayMimePreference ?? DEFAULT_DISPLAY_MIME_PREFERENCE;
    this.onChunk = opts.onChunk;
    this.onError = opts.onError;
    this.onCaptureEnded = opts.onCaptureEnded;
  }

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  get currentSegmentIndex(): number {
    return this.segmentIndex;
  }

  /** Start a recording segment under the given session/segment. */
  async start(
    sessionId: string,
    segmentIndex: number,
    startChunkIndex = 0,
    captureMode: CaptureMode = "microphone",
  ): Promise<string> {
    this.sessionId = sessionId;
    this.segmentIndex = segmentIndex;
    this.chunkIndex = startChunkIndex;

    const preference = captureMode === "screen" ? this.displayMimePreference : this.mimePreference;
    this.stream = await this.acquireStream(captureMode);
    const mimeType = pickMimeType(preference);
    this.recorder = new MediaRecorder(this.stream, { mimeType });
    this.segmentStartedAt = Date.now();

    // When the user ends the screen share from the browser's own control, the
    // capture track fires "ended"; surface it so the app can stop cleanly.
    for (const track of this.stream.getVideoTracks()) {
      track.addEventListener("ended", () => this.onCaptureEnded?.());
    }

    this.recorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) {
        const fast = this.tailFast;
        this.tailFast = false;
        const p = this.emitChunk(ev.data, mimeType, fast).finally(() => {
          this.pendingEmits.delete(p);
        });
        this.pendingEmits.add(p);
      }
    };
    this.recorder.onerror = (ev: Event) => {
      const err = (ev as unknown as { error?: Error }).error ?? new Error("MediaRecorder error");
      this.onError?.(err);
    };

    this.recorder.start(this.intervalMs);
    return mimeType;
  }

  private async acquireStream(captureMode: CaptureMode): Promise<MediaStream> {
    if (captureMode === "screen") {
      // The browser picker lets the user choose a tab, a window or the whole
      // screen, and (where supported) share that source's audio too.
      return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    }
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }

  private async emitChunk(blob: Blob, mimeType: string, fast = false): Promise<void> {
    const index = this.chunkIndex++;
    // Emergency tail flush: skip the (async, CPU-heavy) checksum so the durable
    // write to IndexedDB is as short as possible before the page is destroyed.
    // The checksum is computed later, on recovery, before the chunk is uploaded.
    let checksum = "";
    if (!fast) {
      const buf = await blob.arrayBuffer();
      checksum = await sha256Hex(buf);
    }
    const startedAt = new Date(this.segmentStartedAt + index * this.intervalMs).toISOString();
    const meta: ChunkMetadata = {
      sessionId: this.sessionId,
      segmentIndex: this.segmentIndex,
      chunkIndex: index,
      clientTimestamp: new Date().toISOString(),
      startedAt,
      durationMs: this.intervalMs,
      mimeType,
      sizeBytes: blob.size,
      checksumAlgo: CHECKSUM_ALGO,
      checksum,
      idempotencyKey: makeIdempotencyKey(this.sessionId, this.segmentIndex, index),
    };
    await this.onChunk({ meta, blob, checksumPending: fast });
  }

  /**
   * Force-emit the audio buffered since the last chunk boundary as a chunk,
   * without stopping the recorder. Used to persist the in-progress tail before
   * the page is hidden/unloaded so it survives a reload or accidental close.
   */
  flush(): void {
    if (this.recorder && this.recorder.state === "recording") {
      this.recorder.requestData();
    }
  }

  /**
   * Emergency variant of {@link flush} for the page-hide/unload path: emits the
   * buffered tail but skips checksum computation so the durable write finishes
   * in the tiny window the browser gives before destroying the page. Normal 30s
   * chunks are unaffected; this only runs when the page is being hidden/closed.
   */
  flushTail(): void {
    if (this.recorder && this.recorder.state === "recording") {
      this.tailFast = true;
      this.recorder.requestData();
    }
  }

  /** Stop recording and flush the final chunk. Resolves after last chunk emitted. */
  async stop(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") {
      await this.flushPending();
      this.teardown();
      return;
    }
    await new Promise<void>((resolve) => {
      const onStop = () => {
        recorder.removeEventListener("stop", onStop);
        resolve();
      };
      recorder.addEventListener("stop", onStop);
      recorder.stop(); // triggers a final dataavailable, then stop
    });
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
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }
}
