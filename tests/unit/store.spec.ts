import { describe, expect, it } from "vitest";

import { Store } from "../../frontend/src/state/store.js";

describe("Store state machine", () => {
  it("starts idle", () => {
    const s = new Store();
    expect(s.getState().state).toBe("idle");
  });

  it("allows idle -> recording -> uploading", () => {
    const s = new Store();
    expect(s.transition("recording")).toBe(true);
    expect(s.transition("uploading")).toBe(true);
    expect(s.getState().state).toBe("uploading");
  });

  it("allows uploading -> success (happy path completion)", () => {
    const s = new Store();
    s.transition("recording");
    s.transition("uploading");
    expect(s.transition("success")).toBe(true);
    expect(s.getState().state).toBe("success");
  });

  it("allows recording -> idle (cancel recording)", () => {
    const s = new Store();
    s.transition("recording");
    expect(s.transition("idle")).toBe(true);
    expect(s.getState().state).toBe("idle");
  });

  it("allows error -> idle (user dismisses error)", () => {
    const s = new Store();
    s.transition("recording");
    s.transition("error");
    expect(s.transition("idle")).toBe(true);
    expect(s.getState().state).toBe("idle");
  });

  it("allows success -> recording (start a new recording)", () => {
    const s = new Store();
    s.transition("recording");
    s.transition("uploading");
    s.transition("success");
    expect(s.transition("recording")).toBe(true);
    expect(s.getState().state).toBe("recording");
  });

  it("rejects illegal transitions", () => {
    const s = new Store();
    // idle -> success is not allowed
    expect(s.transition("success")).toBe(false);
    expect(s.getState().state).toBe("idle");
  });

  it("subscribe fires immediately with initial snapshot and undefined event", () => {
    const s = new Store();
    const received: Array<{ state: string; event: string | undefined }> = [];
    s.subscribe((snap, ev) => received.push({ state: snap.state, event: ev }));
    expect(received).toHaveLength(1);
    expect(received[0].state).toBe("idle");
    expect(received[0].event).toBeUndefined();
  });

  it("notifies subscribers on update with event", () => {
    const s = new Store();
    const events: (string | undefined)[] = [];
    s.subscribe((_snap, ev) => events.push(ev));
    s.update({ chunksCreated: 1 }, "chunk_created");
    // first call is the initial snapshot (undefined event), then our event
    expect(events).toContain("chunk_created");
  });

  it("unsubscribe stops further notifications", () => {
    const s = new Store();
    const events: (string | undefined)[] = [];
    const unsub = s.subscribe((_snap, ev) => events.push(ev));
    unsub();
    s.update({ chunksCreated: 1 }, "chunk_created");
    // only the initial notification should be present
    expect(events).toHaveLength(1);
    expect(events[0]).toBeUndefined();
  });

  it("allows recovery from error back to recording", () => {
    const s = new Store();
    s.transition("recording");
    s.transition("error");
    expect(s.transition("recording")).toBe(true);
  });
});
