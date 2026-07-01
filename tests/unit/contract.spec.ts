import { describe, expect, it } from "vitest";

import {
  RETRY_POLICY,
  backoffDelayMs,
  makeIdempotencyKey,
} from "../../shared/contract.js";

describe("backoffDelayMs", () => {
  it("follows the fixed 1/2/4/8/16 schedule", () => {
    expect(backoffDelayMs(0)).toBe(1000);
    expect(backoffDelayMs(1)).toBe(2000);
    expect(backoffDelayMs(2)).toBe(4000);
    expect(backoffDelayMs(3)).toBe(8000);
    expect(backoffDelayMs(4)).toBe(16000);
  });

  it("clamps to max delay for high attempts", () => {
    expect(backoffDelayMs(5)).toBe(RETRY_POLICY.maxDelayMs);
    expect(backoffDelayMs(20)).toBe(RETRY_POLICY.maxDelayMs);
  });
});

describe("makeIdempotencyKey", () => {
  it("produces the fixed session|segment|chunk format", () => {
    expect(makeIdempotencyKey("abc", 2, 5)).toBe("session:abc|segment:2|chunk:5");
  });

  it("is deterministic: same inputs always produce the same key", () => {
    const key1 = makeIdempotencyKey("sess-123", 1, 2);
    const key2 = makeIdempotencyKey("sess-123", 1, 2);
    expect(key1).toBe(key2);
    expect(key1).toBe("session:sess-123|segment:1|chunk:2");
  });

  it("distinguishes different segment/chunk combinations", () => {
    expect(makeIdempotencyKey("s", 0, 1)).not.toBe(makeIdempotencyKey("s", 1, 0));
    expect(makeIdempotencyKey("s", 0, 0)).not.toBe(makeIdempotencyKey("s", 0, 1));
  });
});
