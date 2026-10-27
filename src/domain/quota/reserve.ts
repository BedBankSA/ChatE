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

export function countBillableUnits(runs: { status: string; provider: "openrouter" | "anthropic" | "none" }[]): {
  openRouter: number;
  anthropic: number;
} {
  return {
    openRouter: runs.filter((run) => run.status === "queued" && run.provider === "openrouter").length,
    anthropic: runs.filter((run) => run.status === "queued" && run.provider === "anthropic").length,
  };
}

export function retryDecision(attempt: number, status: number, retryAfterSec: number | null):
  | { retry: false }
  | { retry: true; waitMs: number } {
  if (status !== 429 || attempt >= 2) return { retry: false };
  return { retry: true, waitMs: Math.min((retryAfterSec ?? 1) * 1000, 30_000) };
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
