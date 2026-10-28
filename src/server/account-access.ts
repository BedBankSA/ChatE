import type { DatabaseSync } from "node:sqlite";
import { changeCount } from "@/server/db/rows";

export function endUserSessions(db: DatabaseSync, userId: string, nowIso: string): void {
  db.prepare("UPDATE users SET session_valid_after = ? WHERE id = ?").run(nowIso, userId);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM presence WHERE user_id = ?").run(userId);
}

export function touchActivity(db: DatabaseSync, userId: string, nowIso: string): void {
  const result = db.prepare("UPDATE users SET last_activity_at = ? WHERE id = ?").run(nowIso, userId);
  void changeCount(result);
}
