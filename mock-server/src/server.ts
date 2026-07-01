// Mock server (Node/Express) for protocol validation.
// Exposes session lifecycle + chunk upload with consistent error envelopes.

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";

import {
  ERROR_CODES,
  type ChunkMetadata,
  type CompleteSessionRequest,
  type ResumeSessionRequest,
} from "../../shared/contract.js";
import { ProtocolError, SessionStore } from "./session-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_CHUNK_BYTES = 25 * 1024 * 1024; // 25MB per chunk upload

export function createServer(dataDir: string) {
  const store = new SessionStore(dataDir);
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_CHUNK_BYTES },
  });

  const envelope = () => ({ requestId: randomUUID(), serverTime: new Date().toISOString() });

  // Helper to send a consistent error envelope.
  function sendError(res: Response, err: unknown): void {
    if (err instanceof ProtocolError) {
      const spec = ERROR_CODES[err.code];
      res.status(spec.httpStatus).json({
        ...envelope(),
        error: { code: err.code, message: err.message, retryable: spec.retryable },
      });
      return;
    }
    const spec = ERROR_CODES.INTERNAL_UPLOAD_ERROR;
    res.status(spec.httpStatus).json({
      ...envelope(),
      error: {
        code: "INTERNAL_UPLOAD_ERROR",
        message: err instanceof Error ? err.message : "Internal error",
        retryable: spec.retryable,
      },
    });
  }

  // --- Start session ---------------------------------------------------------
  app.post("/sessions/start", async (_req: Request, res: Response) => {
    try {
      const session = await store.startSession();
      res.status(201).json({ ...envelope(), session });
    } catch (err) {
      sendError(res, err);
    }
  });

  // --- Resume session --------------------------------------------------------
  app.post("/sessions/:sessionId/resume", (req: Request, res: Response) => {
    try {
      const body = req.body as ResumeSessionRequest;
      if (typeof body?.lastKnownSegmentIndex !== "number") {
        throw new ProtocolError("BAD_REQUEST", "lastKnownSegmentIndex is required");
      }
      const result = store.resumeSession(req.params.sessionId);
      res.status(200).json({ ...envelope(), ...result });
    } catch (err) {
      sendError(res, err);
    }
  });

  // --- Get checkpoint --------------------------------------------------------
  app.get("/sessions/:sessionId/checkpoint", (req: Request, res: Response) => {
    try {
      const checkpoint = store.getCheckpoint(req.params.sessionId);
      res.status(200).json({ ...envelope(), checkpoint });
    } catch (err) {
      sendError(res, err);
    }
  });

  // --- Upload chunk ----------------------------------------------------------
  app.post(
    "/sessions/:sessionId/chunks",
    upload.single("blob"),
    async (req: Request, res: Response) => {
      try {
        const metaRaw = req.body?.meta;
        if (!metaRaw) throw new ProtocolError("BAD_REQUEST", "meta field is required");
        if (!req.file) throw new ProtocolError("BAD_REQUEST", "blob file is required");

        let meta: ChunkMetadata;
        try {
          meta = JSON.parse(metaRaw) as ChunkMetadata;
        } catch {
          throw new ProtocolError("BAD_REQUEST", "meta is not valid JSON");
        }

        if (meta.sessionId !== req.params.sessionId) {
          throw new ProtocolError("BAD_REQUEST", "meta.sessionId mismatch with URL");
        }

        const ack = await store.acceptChunk(req.params.sessionId, meta, req.file.buffer);
        res.status(200).json({ ...envelope(), ack });
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // --- Complete session ------------------------------------------------------
  app.post("/sessions/:sessionId/complete", (req: Request, res: Response) => {
    try {
      const body = req.body as CompleteSessionRequest;
      if (!body?.idempotencyKey) {
        throw new ProtocolError("BAD_REQUEST", "idempotencyKey is required");
      }
      const summary = store.completeSession(
        req.params.sessionId,
        body.expectedLastSegmentIndex,
        body.expectedLastChunkIndexBySegment ?? {},
        body.idempotencyKey,
      );
      res.status(200).json({ ...envelope(), ...summary });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Multer / payload-size errors -> PAYLOAD_TOO_LARGE envelope.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      const spec = ERROR_CODES.PAYLOAD_TOO_LARGE;
      res.status(spec.httpStatus).json({
        ...envelope(),
        error: { code: "PAYLOAD_TOO_LARGE", message: "Chunk exceeds size limit", retryable: spec.retryable },
      });
      return;
    }
    if (err) {
      sendError(res, err);
      return;
    }
    next();
  });

  return { app, store };
}

// Run directly (not when imported by tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const PORT = Number(process.env.PORT ?? 3000);
  const dataDir = process.env.DATA_DIR ?? join(__dirname, "..", "..", ".data", "sessions");
  const { app, store } = createServer(dataDir);

  // Serve the single-file client from the same origin as the API (no CORS,
  // secure context for getUserMedia). Run `npm run build` first.
  const distIndex = join(__dirname, "..", "..", "dist", "index.html");
  app.get(["/", "/index.html"], (_req: Request, res: Response) => {
    res.sendFile(distIndex, (err) => {
      if (err) {
        res.status(404).type("text/plain").send("dist/index.html not found — run `npm run build` first");
      }
    });
  });

  store
    .hydrate()
    .catch(() => undefined)
    .finally(() => {
      app.listen(PORT, () => {
        // eslint-disable-next-line no-console
        console.log(`[mock-server] listening on http://localhost:${PORT}`);
        // eslint-disable-next-line no-console
        console.log(`[mock-server] data dir: ${dataDir}`);
      });
    });
}
