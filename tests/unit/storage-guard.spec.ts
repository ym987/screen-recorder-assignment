import { afterEach, describe, expect, it, vi } from "vitest";

import { STORAGE_LIMITS } from "../../shared/contract.js";
import { evaluatePressure } from "../../frontend/src/storage-guard.js";

const MB = 1024 * 1024;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("storage-guard evaluatePressure (fixed byte limits)", () => {
  it("returns 'ok' below the soft limit", async () => {
    expect(await evaluatePressure(STORAGE_LIMITS.softLimitBytes - 1)).toBe("ok");
    expect(await evaluatePressure(0)).toBe("ok");
  });

  it("returns 'soft' between the soft and hard limits", async () => {
    expect(await evaluatePressure(STORAGE_LIMITS.softLimitBytes)).toBe("soft");
    expect(await evaluatePressure(STORAGE_LIMITS.hardLimitBytes - 1)).toBe("soft");
  });

  it("returns 'hard' at or above the hard limit", async () => {
    expect(await evaluatePressure(STORAGE_LIMITS.hardLimitBytes)).toBe("hard");
    expect(await evaluatePressure(STORAGE_LIMITS.hardLimitBytes + 100 * MB)).toBe("hard");
  });
});

describe("storage-guard evaluatePressure (quota-derived hard limit)", () => {
  it("uses the quota fraction when it is stricter than the fixed hard limit", async () => {
    // quota 1000MB * 0.2 = 200MB hard limit, which is below the 300MB fixed cap.
    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ quota: 1000 * MB }) },
    });

    expect(await evaluatePressure(199 * MB)).toBe("soft");
    expect(await evaluatePressure(200 * MB)).toBe("hard");
  });

  it("falls back to fixed limits when estimate() throws", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        estimate: async () => {
          throw new Error("denied");
        },
      },
    });

    expect(await evaluatePressure(STORAGE_LIMITS.hardLimitBytes)).toBe("hard");
    expect(await evaluatePressure(STORAGE_LIMITS.softLimitBytes)).toBe("soft");
  });
});
