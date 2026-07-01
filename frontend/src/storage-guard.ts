// Storage backpressure: compute soft/hard limits vs. current usage.

import { STORAGE_LIMITS } from "../../shared/contract.js";

export type StoragePressure = "ok" | "soft" | "hard";

export async function effectiveQuotaBytes(): Promise<number | null> {
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      return est.quota ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function evaluatePressure(usedBytes: number): Promise<StoragePressure> {
  const quota = await effectiveQuotaBytes();
  const quotaHard = quota ? quota * STORAGE_LIMITS.hardLimitQuotaFraction : Infinity;
  const hardLimit = Math.min(STORAGE_LIMITS.hardLimitBytes, quotaHard);

  if (usedBytes >= hardLimit) return "hard";
  if (usedBytes >= STORAGE_LIMITS.softLimitBytes) return "soft";
  return "ok";
}
