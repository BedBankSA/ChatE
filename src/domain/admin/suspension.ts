export function suspensionActive(status: string, suspendedUntil: string | null, nowMs: number): boolean {
  if (status !== "suspended") return false;
  if (!suspendedUntil) return true;
  const until = Date.parse(suspendedUntil);
  if (!Number.isFinite(until)) return true;
  return until > nowMs;
}

export function sessionStillValid(iat: number | undefined, validAfterIso: string | null, nowMs: number): boolean {
  if (!validAfterIso) return true;
  const after = Date.parse(validAfterIso);
  if (!Number.isFinite(after)) return false;
  const issuedMs = iat == null ? 0 : iat * 1000;
  return issuedMs >= after && issuedMs <= nowMs + 5_000;
}
