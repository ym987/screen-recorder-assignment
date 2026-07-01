// REST client for session lifecycle endpoints.

import type {
  CheckpointModel,
  CompleteSessionResponse,
  ResumeSessionResponse,
  SessionModel,
} from "../../shared/contract.js";
import type { FetchLike } from "./chunk-uploader.js";

export class ApiClient {
  private baseUrl: string;
  private fetchImpl: FetchLike;

  constructor(baseUrl: string, fetchImpl?: FetchLike) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    // Wrap fetch so it keeps its window binding (avoids "Illegal invocation").
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
  }

  async startSession(clientId: string, mimePreference: string[]): Promise<SessionModel> {
    const res = await this.fetchImpl(`${this.baseUrl}/sessions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, mimePreference }),
    });
    if (!res.ok) throw new Error(`start failed: HTTP ${res.status}`);
    const body = (await res.json()) as { session: SessionModel };
    return body.session;
  }

  async resumeSession(
    sessionId: string,
    lastKnownSegmentIndex: number,
    lastKnownChunkIndexBySegment: Record<string, number>,
  ): Promise<ResumeSessionResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/sessions/${sessionId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastKnownSegmentIndex, lastKnownChunkIndexBySegment }),
    });
    if (!res.ok) throw new Error(`resume failed: HTTP ${res.status}`);
    return (await res.json()) as ResumeSessionResponse;
  }

  async getCheckpoint(sessionId: string): Promise<CheckpointModel> {
    const res = await this.fetchImpl(`${this.baseUrl}/sessions/${sessionId}/checkpoint`);
    if (!res.ok) throw new Error(`checkpoint failed: HTTP ${res.status}`);
    const body = (await res.json()) as { checkpoint: CheckpointModel };
    return body.checkpoint;
  }

  async completeSession(
    sessionId: string,
    expectedLastSegmentIndex: number,
    expectedLastChunkIndexBySegment: Record<string, number>,
    idempotencyKey: string,
  ): Promise<CompleteSessionResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/sessions/${sessionId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedLastSegmentIndex,
        expectedLastChunkIndexBySegment,
        idempotencyKey,
      }),
    });
    if (!res.ok) throw new Error(`complete failed: HTTP ${res.status}`);
    return (await res.json()) as CompleteSessionResponse;
  }
}
