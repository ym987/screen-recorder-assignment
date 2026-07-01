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

  it("rejects illegal transitions", () => {
    const s = new Store();
    // idle -> success is not allowed
    expect(s.transition("success")).toBe(false);
    expect(s.getState().state).toBe("idle");
  });

  it("notifies subscribers on update with event", () => {
    const s = new Store();
    const events: (string | undefined)[] = [];
    s.subscribe((_snap, ev) => events.push(ev));
    s.update({ chunksCreated: 1 }, "chunk_created");
    // first call is the initial snapshot (undefined event), then our event
    expect(events).toContain("chunk_created");
  });

  it("allows recovery from error back to recording", () => {
    const s = new Store();
    s.transition("recording");
    s.transition("error");
    expect(s.transition("recording")).toBe(true);
  });
});
