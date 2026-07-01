// Promise-based IndexedDB wrapper.
// Persists queued chunk blobs + metadata, local session state and tombstones.

import type { ChunkMetadata } from "../../shared/contract.js";

const DB_NAME = "audio-chunk-upload";
const DB_VERSION = 1;

export const STORE_CHUNKS = "chunks";
export const STORE_SESSION = "session";
export const STORE_TOMBSTONES = "tombstones";

export type ChunkStatus = "pending" | "permanent_failed";

export interface StoredChunkRecord {
  idempotencyKey: string;
  meta: ChunkMetadata;
  blob: Blob;
  status: ChunkStatus;
  attempts: number;
  createdAt: number;
}

export interface LocalSessionState {
  key: "current";
  sessionId: string;
  segmentIndex: number;
  // segmentIndex -> lastCreatedChunkIndex
  lastChunkIndexBySegment: Record<string, number>;
  updatedAt: number;
}

export interface Tombstone {
  idempotencyKey: string;
  sessionId: string;
  segmentIndex: number;
  chunkIndex: number;
  ackedAt: number;
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class Idb {
  private dbPromise: Promise<IDBDatabase>;

  constructor(indexedDBImpl: IDBFactory = indexedDB) {
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDBImpl.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
          const s = db.createObjectStore(STORE_CHUNKS, { keyPath: "idempotencyKey" });
          s.createIndex("byCreatedAt", "createdAt");
          s.createIndex("byStatus", "status");
        }
        if (!db.objectStoreNames.contains(STORE_SESSION)) {
          db.createObjectStore(STORE_SESSION, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORE_TOMBSTONES)) {
          db.createObjectStore(STORE_TOMBSTONES, { keyPath: "idempotencyKey" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async tx(store: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.dbPromise;
    return db.transaction(store, mode).objectStore(store);
  }

  // --- chunks ---------------------------------------------------------------

  async putChunk(record: StoredChunkRecord): Promise<void> {
    const store = await this.tx(STORE_CHUNKS, "readwrite");
    await promisifyRequest(store.put(record));
  }

  async getChunk(idempotencyKey: string): Promise<StoredChunkRecord | undefined> {
    const store = await this.tx(STORE_CHUNKS, "readonly");
    return promisifyRequest(store.get(idempotencyKey)) as Promise<StoredChunkRecord | undefined>;
  }

  async deleteChunk(idempotencyKey: string): Promise<void> {
    const store = await this.tx(STORE_CHUNKS, "readwrite");
    await promisifyRequest(store.delete(idempotencyKey));
  }

  /** All pending chunks ordered by creation time (FIFO). */
  async listPendingChunks(): Promise<StoredChunkRecord[]> {
    const store = await this.tx(STORE_CHUNKS, "readonly");
    const all = (await promisifyRequest(store.getAll())) as StoredChunkRecord[];
    return all
      .filter((c) => c.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async listAllChunks(): Promise<StoredChunkRecord[]> {
    const store = await this.tx(STORE_CHUNKS, "readonly");
    return (await promisifyRequest(store.getAll())) as StoredChunkRecord[];
  }

  async totalStoredBytes(): Promise<number> {
    const all = await this.listAllChunks();
    return all.reduce((sum, c) => sum + (c.meta.sizeBytes || c.blob.size), 0);
  }

  // --- session --------------------------------------------------------------

  async saveSession(state: Omit<LocalSessionState, "key" | "updatedAt">): Promise<void> {
    const store = await this.tx(STORE_SESSION, "readwrite");
    const record: LocalSessionState = { key: "current", updatedAt: Date.now(), ...state };
    await promisifyRequest(store.put(record));
  }

  async getSession(): Promise<LocalSessionState | undefined> {
    const store = await this.tx(STORE_SESSION, "readonly");
    return promisifyRequest(store.get("current")) as Promise<LocalSessionState | undefined>;
  }

  async clearSession(): Promise<void> {
    const store = await this.tx(STORE_SESSION, "readwrite");
    await promisifyRequest(store.delete("current"));
  }

  // --- tombstones -----------------------------------------------------------

  async putTombstone(t: Tombstone): Promise<void> {
    const store = await this.tx(STORE_TOMBSTONES, "readwrite");
    await promisifyRequest(store.put(t));
  }

  async pruneTombstones(ttlMs: number, now = Date.now()): Promise<void> {
    const store = await this.tx(STORE_TOMBSTONES, "readwrite");
    const all = (await promisifyRequest(store.getAll())) as Tombstone[];
    for (const t of all) {
      if (now - t.ackedAt > ttlMs) {
        await promisifyRequest(store.delete(t.idempotencyKey));
      }
    }
  }

  /** Remove all chunks + tombstones for a session (used on complete/expire). */
  async clearSessionData(sessionId: string): Promise<void> {
    const chunks = await this.listAllChunks();
    for (const c of chunks) {
      if (c.meta.sessionId === sessionId) await this.deleteChunk(c.idempotencyKey);
    }
    const tStore = await this.tx(STORE_TOMBSTONES, "readwrite");
    const tombs = (await promisifyRequest(tStore.getAll())) as Tombstone[];
    for (const t of tombs) {
      if (t.sessionId === sessionId) await promisifyRequest(tStore.delete(t.idempotencyKey));
    }
  }
}
