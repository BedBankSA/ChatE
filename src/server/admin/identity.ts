import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { StoredAccount } from "@/domain/admin/gate";

export function storedGoogleAccount(
  db: DatabaseSync,
  session: { userId: string; googleSub: string },
): StoredAccount | null {
  const row = db.prepare(`
    SELECT id, google_sub, email
    FROM users
    WHERE id = ? AND google_sub = ?
  `).get(session.userId, session.googleSub) as Record<string, SQLOutputValue> | undefined;
  if (!row) return null;
  if (typeof row.id !== "string" || typeof row.google_sub !== "string" || typeof row.email !== "string") return null;
  return { userId: row.id, googleSub: row.google_sub, email: row.email };
}
