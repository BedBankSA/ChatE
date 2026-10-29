import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  SETTING_KEYS,
  SETTING_META,
  lastFour,
  maskSecret,
  validateSettingValue,
  type SettingKey,
  type SettingView,
} from "@/domain/admin/settings";
import { getDatabase } from "@/server/db/runtime";

/**
 * Runtime credential resolver. SQLite wins over the environment so an admin can
 * rotate a provider key from /admin/settings without a restart. Every read
 * happens at request time (no cross-request cache), which is what makes the UI
 * change effective immediately.
 */
export function getSystemKey(
  name: string,
  options: { db?: DatabaseSync; env?: Record<string, string | undefined> } = {},
): string {
  try {
    const db = options.db ?? getDatabase();
    const stored = readSystemSettingRow(db, name)?.value?.trim();
    if (stored) return stored;
  } catch {
    // A missing/locked store must never break env-based fallback.
  }
  return options.env?.[name]?.trim() ?? "";
}

/** process.env with DB-managed keys layered on top (only the allowlisted keys). */
export function runtimeEnv(
  base: Record<string, string | undefined> = process.env,
  database?: DatabaseSync,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  try {
    const db = database ?? getDatabase();
    for (const key of SETTING_KEYS) {
      const stored = readSystemSettingRow(db, key)?.value?.trim();
      if (stored) env[key] = stored;
    }
    // Saving an Anthropic key from the admin UI is an explicit opt-in: it must
    // override a stale HAIKU_LIVE_CALLS=0 left in the deployment env. An
    // explicit DB toggle still wins.
    if (readSystemSettingRow(db, "ANTHROPIC_API_KEY")?.value?.trim() && !readSystemSettingRow(db, "HAIKU_LIVE_CALLS")) {
      env.HAIKU_LIVE_CALLS = "1";
    }
  } catch {
    // Fall back to the environment; the app must still boot with a broken store.
  }
  return env;
}

export type SystemSettingRow = { key: string; value: string; updatedAt: string };

export function readSystemSettingRow(db: DatabaseSync, key: string): SystemSettingRow | null {
  const row = db.prepare("SELECT key, value, updated_at FROM system_settings WHERE key = ?").get(key) as Record<string, SQLOutputValue> | undefined;
  if (!row || typeof row.key !== "string" || typeof row.value !== "string" || typeof row.updated_at !== "string") return null;
  return { key: row.key, value: row.value, updatedAt: row.updated_at };
}

/** Admin-facing snapshot: masked hints only, never the stored secret. */
export function readSettingsView(db: DatabaseSync, env: Record<string, string | undefined> = process.env): SettingView[] {
  return SETTING_KEYS.map((key) => {
    const dbRow = readSystemSettingRow(db, key);
    const dbValue = dbRow?.value?.trim() ?? "";
    const envValue = env[key]?.trim() ?? "";
    const source = dbValue ? "db" : envValue ? "env" : "none";
    const effective = dbValue || envValue;
    return {
      key,
      label: SETTING_META[key].label,
      group: SETTING_META[key].group,
      hint: SETTING_META[key].hint,
      configured: Boolean(effective),
      source,
      masked: effective ? maskSecret(effective) : null,
      lastFour: effective ? lastFour(effective) : null,
      updatedAt: dbRow?.updatedAt ?? null,
    };
  });
}

export type SettingWrite = { ok: true; changed: boolean } | { ok: false; message: string };

/** Upserts a validated value; an empty value removes the DB override. */
export function writeSystemSetting(
  db: DatabaseSync,
  key: SettingKey,
  raw: unknown,
  now: Date,
): SettingWrite {
  const parsed = validateSettingValue(key, raw);
  if (!parsed.ok) return parsed;
  const existing = readSystemSettingRow(db, key);
  if (!parsed.value) {
    if (!existing) return { ok: true, changed: false };
    db.prepare("DELETE FROM system_settings WHERE key = ?").run(key);
    return { ok: true, changed: true };
  }
  if (existing && existing.value === parsed.value) return { ok: true, changed: false };
  db.prepare(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, parsed.value, now.toISOString());
  return { ok: true, changed: true };
}

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === "string" && (SETTING_KEYS as readonly string[]).includes(value);
}
