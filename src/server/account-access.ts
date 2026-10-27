import type { DatabaseSync } from "node:sqlite";
import { isSuspended, sessionEnded } from "@/domain/admin/access";
import { changeCount, nullableText, textField } from "@/server/db/rows";

export type AccountRow = {
  status: string;
  suspendedUntil: string | null;
  sessionValidAfter: string | null;
};

export function readAccountRow(db: DatabaseSync, userId: string): AccountRow | null {
  const row = db.prepare(`
    SELECT status, suspended_until, session_valid_after
    FROM users
    WHERE id = ?
  `).get(userId);
  if (!row) return null;
  return {
    status: textField(row, "status"),
    suspendedUntil: nullableText(row, "suspended_until"),
    sessionValidAfter: nullableText(row, "session_valid_after"),
  };
}

export function serviceDenial(
  db: DatabaseSync,
  session: { userId: string; iat?: number },
  nowSec: number,
): { message: string; code: string; status: number } | null {
  const account = readAccountRow(db, session.userId);
  if (!account) return { message: "أعد تسجيل الدخول لحفظ الحساب.", code: "account_missing", status: 401 };
  if (sessionEnded(account.sessionValidAfter, session.iat, nowSec)) {
    return { message: "انتهت الجلسة. ادخل من جديد.", code: "session_ended", status: 401 };
  }
  const nowIso = new Date(nowSec * 1000).toISOString();
  if (isSuspended(account.status, account.suspendedUntil, nowIso)) {
    return { message: "الحساب موقوف.", code: "suspended", status: 403 };
  }
  if (account.status === "suspended" && account.suspendedUntil && account.suspendedUntil <= nowIso) {
    db.prepare(`
      UPDATE users
      SET status = 'active', suspended_until = NULL
      WHERE id = ? AND status = 'suspended'
    `).run(session.userId);
  }
  return null;
}

export function endUserSessions(db: DatabaseSync, userId: string, nowIso: string): void {
  db.prepare("UPDATE users SET session_valid_after = ? WHERE id = ?").run(nowIso, userId);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM presence WHERE user_id = ?").run(userId);
}

export function providerWorkShouldStop(db: DatabaseSync, userId: string, jobId: string, nowIso: string): boolean {
  const account = readAccountRow(db, userId);
  if (account && isSuspended(account.status, account.suspendedUntil, nowIso)) return true;
  const job = db.prepare("SELECT cancel_requested_at FROM jobs WHERE id = ?").get(jobId);
  return Boolean(job && nullableText(job, "cancel_requested_at"));
}

export function touchActivity(db: DatabaseSync, userId: string, nowIso: string): void {
  const result = db.prepare("UPDATE users SET last_activity_at = ? WHERE id = ?").run(nowIso, userId);
  void changeCount(result);
}
