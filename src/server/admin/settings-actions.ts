import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { immediateTransaction } from "@/server/db/transaction";
import { isSettingKey, readSystemSettingRow, writeSystemSetting } from "@/server/db/settings";

function readSystemSettingRowFor(db: DatabaseSync, key: string) {
  try {
    return readSystemSettingRow(db, key);
  } catch {
    return null;
  }
}

export type SettingChangeResult =
  | { ok: true; changed: boolean; notice: "saved" | "cleared" }
  | { ok: false };

/**
 * Writes one allowlisted setting and records an audit row. The secret value is
 * never written to the audit metadata or any log; only the key and whether the
 * override was saved or cleared is recorded.
 */
export function applySettingChange(
  db: DatabaseSync,
  actorId: string,
  rawKey: unknown,
  rawValue: unknown,
  now: Date,
): SettingChangeResult {
  if (!isSettingKey(rawKey)) return { ok: false };
  return immediateTransaction<SettingChangeResult>(db, () => {
    const result = writeSystemSetting(db, rawKey, rawValue, now);
    if (!result.ok) return { commit: false, value: { ok: false } };
    if (rawKey === "ANTHROPIC_API_KEY" && String(rawValue ?? "").trim()) {
      // A saved key is the operator's opt-in; keep the kill switch explicit.
      if (!readSystemSettingRowFor(db, "HAIKU_LIVE_CALLS")) {
        writeSystemSetting(db, "HAIKU_LIVE_CALLS", "1", now);
      }
    }
    if (result.changed) {
      db.prepare(`
        INSERT INTO admin_audit_events (id, admin_user_id, action, target, metadata)
        VALUES (?, ?, 'setting', ?, ?)
      `).run(
        randomUUID(),
        actorId,
        rawKey,
        JSON.stringify({ cleared: !String(rawValue ?? "").trim() }),
      );
    }
    return {
      commit: true,
      value: { ok: true, changed: result.changed, notice: String(rawValue ?? "").trim() ? "saved" : "cleared" } as const,
    };
  });
}
