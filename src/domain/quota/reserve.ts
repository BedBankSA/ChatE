export type QuotaState = {
  sharedLimit: number;
  sharedUsed: number;
  sharedReserved: number;
  userLimit: number;
  userUsed: number;
  userReserved: number;
  userInFlight: number;
  globalInFlight: number;
  maxUserConcurrent: number;
  maxGlobalConcurrent: number;
};

export function reserve(state: QuotaState, units: number):
  | { ok: true; next: QuotaState }
  | { ok: false; code: "quota" | "concurrency" } {
  if (units < 0) return { ok: false, code: "quota" };
  if (state.userInFlight + units > state.maxUserConcurrent) return { ok: false, code: "concurrency" };
  if (state.globalInFlight + units > state.maxGlobalConcurrent) return { ok: false, code: "concurrency" };
  if (state.sharedUsed + state.sharedReserved + units > state.sharedLimit) return { ok: false, code: "quota" };
  if (state.userUsed + state.userReserved + units > state.userLimit) return { ok: false, code: "quota" };
  return {
    ok: true,
    next: {
      ...state,
      sharedReserved: state.sharedReserved + units,
      userReserved: state.userReserved + units,
      userInFlight: state.userInFlight + units,
      globalInFlight: state.globalInFlight + units,
    },
  };
}

/**
 * 429 retry pacing for free upstreams. Without a Retry-After header the first
 * retry waits 2.5s and the second 12s: free provider limits are usually
 * per-minute bursts, so an immediate retry only burns the same quota window.
 */
const RATE_LIMIT_BACKOFF_MS = [2_500, 12_000] as const;

export function retryDecision(attempt: number, status: number, retryAfterSec: number | null):
  | { retry: false }
  | { retry: true; waitMs: number } {
  if (status !== 429 || attempt >= 2) return { retry: false };
  if (retryAfterSec != null) return { retry: true, waitMs: Math.min(retryAfterSec * 1000, 30_000) };
  return { retry: true, waitMs: RATE_LIMIT_BACKOFF_MS[attempt] ?? 12_000 };
}

export function beginIdempotent(existing: { id: string; key: string } | null, key: string):
  | { duplicate: true; id: string }
  | { duplicate: false } {
  if (existing?.key === key) return { duplicate: true, id: existing.id };
  return { duplicate: false };
}

export const RESERVE_LOCK_SQL = `
UPDATE quota_accounts
SET reserved_units = reserved_units + ?,
    in_flight = in_flight + ?
WHERE id = ?
  AND used_units + reserved_units + ? <= limit_units
  AND in_flight + ? <= ?
`.trim();
