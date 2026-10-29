import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { StoredSessionStanding } from "@/domain/auth/session";
import { changeCount } from "@/server/db/rows";

export function endUserSessions(db: DatabaseSync, userId: string, nowIso: string): void {
  db.prepare("UPDATE users SET session_valid_after = ? WHERE id = ?").run(nowIso, userId);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM presence WHERE user_id = ?").run(userId);
}

/**
 * Server-side facts that decide whether an otherwise valid signed session may
 * still be used. Read-only and single-row: this runs once per authenticated
 * request. Returns null (fail closed) when the account no longer exists.
 */
export function readSessionStanding(db: DatabaseSync, userId: string): StoredSessionStanding | null {
  const row = db
    .prepare("SELECT status, suspended_until, session_valid_after FROM users WHERE id = ?")
    .get(userId) as Record<string, SQLOutputValue> | undefined;
  if (!row || typeof row.status !== "string") return null;
  return {
    status: row.status,
    suspendedUntil: typeof row.suspended_until === "string" ? row.suspended_until : null,
    sessionValidAfter: typeof row.session_valid_after === "string" ? row.session_valid_after : null,
  };
}

export function touchActivity(db: DatabaseSync, userId: string, nowIso: string): void {
  const result = db.prepare("UPDATE users SET last_activity_at = ? WHERE id = ?").run(nowIso, userId);
  void changeCount(result);
}
