// Tiny framework-free state store + event bus that drives the UI.

export type AppState =
  | "idle"
  | "recording"
  | "uploading"
  | "retrying"
  | "recovered"
  | "success"
  | "error";

export type AppEvent =
  | "record_started"
  | "chunk_created"
  | "chunk_uploaded"
  | "chunk_duplicate"
  | "upload_failed"
  | "retrying"
  | "resumed"
  | "recovered"
  | "completed"
  | "error"
  | "storage_warning";

export interface StoreSnapshot {
  state: AppState;
  sessionId: string | null;
  segmentIndex: number;
  chunksCreated: number;
  chunksUploaded: number;
  chunksDuplicate: number;
  chunksFailed: number;
  pending: number;
  message: string;
  storageWarning: boolean;
  lastError: string | null;
}

type Listener = (snapshot: StoreSnapshot, event?: AppEvent) => void;

const VALID_TRANSITIONS: Record<AppState, AppState[]> = {
  idle: ["recording", "recovered", "error"],
  recording: ["uploading", "retrying", "success", "error", "idle"],
  uploading: ["recording", "retrying", "success", "error", "idle"],
  retrying: ["recording", "uploading", "success", "error", "idle"],
  recovered: ["recording", "uploading", "retrying", "error", "idle"],
  success: ["idle", "recording"],
  error: ["idle", "recording", "retrying"],
};

export class Store {
  private listeners = new Set<Listener>();
  private snap: StoreSnapshot = {
    state: "idle",
    sessionId: null,
    segmentIndex: 0,
    chunksCreated: 0,
    chunksUploaded: 0,
    chunksDuplicate: 0,
    chunksFailed: 0,
    pending: 0,
    message: "מוכן להקלטה",
    storageWarning: false,
    lastError: null,
  };

  getState(): StoreSnapshot {
    return { ...this.snap };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  /** Guarded state transition; ignores illegal transitions but still allows self. */
  transition(next: AppState): boolean {
    const current = this.snap.state;
    if (current === next) return true;
    if (!VALID_TRANSITIONS[current].includes(next)) {
      return false;
    }
    this.snap.state = next;
    return true;
  }

  update(patch: Partial<StoreSnapshot>, event?: AppEvent): void {
    this.snap = { ...this.snap, ...patch };
    this.emit(event);
  }

  private emit(event?: AppEvent): void {
    const s = this.getState();
    for (const l of this.listeners) l(s, event);
  }
}
