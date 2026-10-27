export const PRESENCE_TTL_MS = 90_000;
export const HEARTBEAT_MS = 30_000;
export const PRESENCE_NOTE = "النشاط خلال 90 ثانية من آخر نبض، وليس تعدادًا مؤكدًا للرؤوس.";

export type PresenceKind = "registered" | "anonymous";

export function presenceSubject(userId: string | null, visitorId: string): { key: string; kind: PresenceKind } {
  if (userId) return { key: `user:${userId}`, kind: "registered" };
  return { key: `anon:${visitorId}`, kind: "anonymous" };
}

export function presenceExpiry(nowMs: number): string {
  return new Date(nowMs + PRESENCE_TTL_MS).toISOString();
}

export function isPresent(lastSeenIso: string, expiresIso: string, nowMs: number): boolean {
  const seen = Date.parse(lastSeenIso);
  const expires = Date.parse(expiresIso);
  if (!Number.isFinite(seen) || !Number.isFinite(expires)) return false;
  return seen >= nowMs - PRESENCE_TTL_MS && expires > nowMs;
}

export function countPresence(
  rows: { userId: string | null; lastSeenIso: string; expiresIso: string }[],
  nowMs: number,
): { anonymousVisitors: number; activeRegisteredUsers: number } {
  const registered = new Set<string>();
  let anonymous = 0;
  for (const row of rows) {
    if (!isPresent(row.lastSeenIso, row.expiresIso, nowMs)) continue;
    if (row.userId) registered.add(row.userId);
    else anonymous += 1;
  }
  return { anonymousVisitors: anonymous, activeRegisteredUsers: registered.size };
}

const VISITOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validVisitorId(value: string | undefined): string | null {
  if (!value || !VISITOR.test(value)) return null;
  return value.toLowerCase();
}
