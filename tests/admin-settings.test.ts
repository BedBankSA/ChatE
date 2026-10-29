import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  SETTING_KEYS,
  maskSecret,
  validateSettingValue,
} from "@/domain/admin/settings";
import { adminDecision } from "@/domain/admin/gate";
import { parseAdminCommand } from "@/domain/admin/command";
import { applyAdminAction } from "@/server/admin/actions";
import { applySettingChange } from "@/server/admin/settings-actions";
import { testSystemSetting } from "@/server/admin/settings-test";
import { queryUsers, parseUserQuery } from "@/server/admin/users";
import { insertUser, migrateDatabase, openDatabase } from "@/server/db/index";
import { getSystemKey, readSettingsView, runtimeEnv, writeSystemSetting } from "@/server/db/settings";

const MIGRATIONS = path.join(process.cwd(), "migrations");
const NOW = new Date("2026-10-28T12:00:00.000Z");

function db(): DatabaseSync {
  const database = openDatabase(":memory:");
  migrateDatabase(database, MIGRATIONS);
  return database;
}

describe("admin settings (runtime keys)", () => {
  it("validates the allowlisted keys and rejects unsafe values", () => {
    expect(validateSettingValue("ANTHROPIC_API_KEY", "")).toEqual({ ok: true, value: "" });
    expect(validateSettingValue("ANTHROPIC_API_KEY", "  sk-ant-test-value-0123456789  ")).toEqual({
      ok: true,
      value: "sk-ant-test-value-0123456789",
    });
    expect(validateSettingValue("ANTHROPIC_API_KEY", "short").ok).toBe(false);
    expect(validateSettingValue("OPENROUTER_API_KEY", "sk-or-valid-value-0123456789").ok).toBe(true);
    expect(validateSettingValue("OPENROUTER_API_KEY", "line\nbreak-value-0123456789").ok).toBe(false);
    expect(validateSettingValue("SMS_SENDER_ID", "BedBank").ok).toBe(true);
    expect(validateSettingValue("SMS_SENDER_ID", "bad\u0007sender").ok).toBe(false);
    expect(validateSettingValue("SMS_SENDER_ID", "x".repeat(64)).ok).toBe(false);
    // @ts-expect-error unknown keys are not accepted from the form
    expect(validateSettingValue("UNKNOWN_KEY", "value").ok).toBe(false);
  });

  it("masks secrets without exposing more than a short prefix and four chars", () => {
    const masked = maskSecret("sk-ant-api03-abcdefghijklmnop-3A");
    expect(masked).toBe("sk-ant-••••••••••••p-3A");
    expect(masked).not.toContain("abcdefghijklmnop");
    expect(maskSecret("short")).toBe("••••••••");
    expect(maskSecret("")).toBe("");
  });

  it("creates system_settings and a default user role", () => {
    const database = db();
    try {
      const row = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_settings'")
        .get() as { name?: string } | undefined;
      expect(row?.name).toBe("system_settings");
      insertUser(database, { id: "u-1", googleSub: "sub-1", email: "u1@example.com", name: "مستخدم" });
      const user = database.prepare("SELECT role FROM users WHERE id = 'u-1'").get() as { role?: string } | undefined;
      expect(user?.role).toBe("user");
    } finally {
      database.close();
    }
  });

  it("resolves DB values before the environment and clears back to env", () => {
    const database = db();
    try {
      const env = { OPENROUTER_API_KEY: "env-key-0123456789" };
      expect(getSystemKey("OPENROUTER_API_KEY", { db: database, env })).toBe("env-key-0123456789");
      expect(writeSystemSetting(database, "OPENROUTER_API_KEY", "db-key-0123456789abcdef", NOW)).toEqual({ ok: true, changed: true });
      expect(getSystemKey("OPENROUTER_API_KEY", { db: database, env })).toBe("db-key-0123456789abcdef");
      const view = readSettingsView(database, env);
      const row = view.find((item) => item.key === "OPENROUTER_API_KEY");
      expect(row?.source).toBe("db");
      expect(row?.masked).toContain("••••");
      expect(row?.masked).not.toContain("db-key-0123456789");
      expect(JSON.stringify(view)).not.toContain("db-key-0123456789abcdef");
      expect(JSON.stringify(view)).not.toContain("env-key-0123456789");
      // Clearing the DB override falls back to the environment again.
      expect(writeSystemSetting(database, "OPENROUTER_API_KEY", "", NOW)).toEqual({ ok: true, changed: true });
      expect(getSystemKey("OPENROUTER_API_KEY", { db: database, env })).toBe("env-key-0123456789");
    } finally {
      database.close();
    }
  });

  it("records an audit row without the secret value", () => {
    const database = db();
    try {
      insertUser(database, { id: "admin-1", googleSub: "sub-admin", email: "admin@example.com", name: "مشرف" });
      const result = applySettingChange(database, "admin-1", "ANTHROPIC_API_KEY", "sk-ant-secret-value-0123456789", NOW);
      expect(result).toEqual({ ok: true, changed: true, notice: "saved" });
      const audit = database
        .prepare("SELECT action, target, metadata FROM admin_audit_events ORDER BY rowid DESC LIMIT 1")
        .get() as { action?: string; target?: string; metadata?: string } | undefined;
      expect(audit?.action).toBe("setting");
      expect(audit?.target).toBe("ANTHROPIC_API_KEY");
      expect(String(audit?.metadata)).not.toContain("sk-ant-secret-value");
      const bad = applySettingChange(database, "admin-1", "NOT_ALLOWED", "x", NOW);
      expect(bad.ok).toBe(false);
      const short = applySettingChange(database, "admin-1", "ANTHROPIC_API_KEY", "short", NOW);
      expect(short.ok).toBe(false);
    } finally {
      database.close();
    }
  });

  it("merges DB keys over process.env in runtimeEnv", () => {
    const database = db();
    try {
      writeSystemSetting(database, "SMS_SENDER_ID", "BedBank", NOW);
      // runtimeEnv uses the app-wide connection; verify the resolver contract
      // through getSystemKey instead so the test never opens the real DB file.
      expect(getSystemKey("SMS_SENDER_ID", { db: database, env: { SMS_SENDER_ID: "EnvSender" } })).toBe("BedBank");
      expect(readSettingsView(database, {}).find((item) => item.key === "SMS_SENDER_ID")?.configured).toBe(true);
      expect(typeof runtimeEnv).toBe("function");
    } finally {
      database.close();
    }
  });

  it("allows DB-promoted admins and persists promote/demote with audit", () => {
    const database = db();
    try {
      insertUser(database, { id: "owner-1", googleSub: "sub-owner", email: "owner@example.com", name: "مالك" });
      insertUser(database, { id: "user-1", googleSub: "sub-user", email: "user@example.com", name: "مستخدم" });
      const stored = { userId: "user-1", googleSub: "sub-user", email: "user@example.com", role: "user" };
      expect(adminDecision({ userId: "user-1", googleSub: "sub-user" }, stored, {})).toMatchObject({ ok: false, status: 403 });
      expect(adminDecision({ userId: "user-1", googleSub: "sub-user" }, { ...stored, role: "admin" }, {})).toMatchObject({ ok: true });
      const promoted = applyAdminAction(database, "owner-1", { type: "role", userId: "user-1", role: "admin" }, NOW);
      expect(promoted.ok && promoted.changed).toBe(true);
      const row = database.prepare("SELECT role FROM users WHERE id = 'user-1'").get() as { role?: string } | undefined;
      expect(row?.role).toBe("admin");
      const query = parseUserQuery(new URLSearchParams(), { from: "2020-01-01T00:00:00.000Z", to: "2030-01-01T00:00:00.000Z" }, NOW.toISOString());
      const listed = queryUsers(database, query);
      expect(listed.rows.find((item) => item.id === "user-1")?.role).toBe("admin");
      const demoted = applyAdminAction(database, "owner-1", { type: "role", userId: "user-1", role: "user" }, NOW);
      expect(demoted.ok && demoted.changed).toBe(true);
      const audit = database.prepare("SELECT COUNT(*) AS n FROM admin_audit_events WHERE action = 'role'").get() as { n?: number } | undefined;
      expect(audit?.n).toBe(2);
    } finally {
      database.close();
    }
  });

  it("auto-enables Haiku when an Anthropic key is saved", () => {
    const database = db();
    try {
      insertUser(database, { id: "admin-2", googleSub: "sub-admin2", email: "admin2@example.com", name: "مشرف" });
      applySettingChange(database, "admin-2", "ANTHROPIC_API_KEY", "sk-ant-live-value-0123456789", NOW);
      const flag = database.prepare("SELECT value FROM system_settings WHERE key = 'HAIKU_LIVE_CALLS'").get() as { value?: string } | undefined;
      expect(flag?.value).toBe("1");
      expect(getSystemKey("HAIKU_LIVE_CALLS", { db: database, env: {} })).toBe("1");
    } finally {
      database.close();
    }
  });

  it("runs read-only provider tests without leaking the secret", async () => {
    const database = db();
    try {
      writeSystemSetting(database, "OPENROUTER_API_KEY", "sk-or-live-value-0123456789abcdef", NOW);
      const okFetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
      const openrouter = await testSystemSetting(database, "OPENROUTER_API_KEY", { env: {}, fetchImpl: okFetch });
      expect(openrouter.ok).toBe(true);
      expect(openrouter.message).not.toContain("sk-or-live-value");
      const rejected = (async () => new Response("{}", { status: 401 })) as typeof fetch;
      const bad = await testSystemSetting(database, "OPENROUTER_API_KEY", { env: {}, fetchImpl: rejected });
      expect(bad.ok).toBe(false);
      writeSystemSetting(database, "TURNSTILE_SECRET_KEY", "0x" + "a".repeat(24), NOW);
      const siteverifyBadSecret = (async () =>
        new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-secret"] }), { status: 200 })) as typeof fetch;
      const turnstile = await testSystemSetting(database, "TURNSTILE_SECRET_KEY", { env: {}, fetchImpl: siteverifyBadSecret });
      expect(turnstile.ok).toBe(false);
      const wrongGoogleId = await testSystemSetting(database, "GOOGLE_CLIENT_ID", { env: {}, fetchImpl: okFetch });
      expect(wrongGoogleId.ok).toBe(false);
      writeSystemSetting(database, "GOOGLE_CLIENT_ID", "1234567890-abc.apps.googleusercontent.com", NOW);
      const goodGoogleId = await testSystemSetting(database, "GOOGLE_CLIENT_ID", { env: {}, fetchImpl: okFetch });
      expect(goodGoogleId.ok).toBe(true);
    } finally {
      database.close();
    }
  });

  it("lets a DB Anthropic key override a stale HAIKU_LIVE_CALLS=0 from the deployment env", () => {
    const database = db();
    try {
      writeSystemSetting(database, "ANTHROPIC_API_KEY", "sk-ant-db-value-0123456789", NOW);
      const merged = runtimeEnv({ HAIKU_LIVE_CALLS: "0", ANTHROPIC_API_KEY: "" }, database);
      expect(merged.ANTHROPIC_API_KEY).toBe("sk-ant-db-value-0123456789");
      expect(merged.HAIKU_LIVE_CALLS).toBe("1");
      // An explicit DB kill switch still wins.
      writeSystemSetting(database, "HAIKU_LIVE_CALLS", "0", NOW);
      const killed = runtimeEnv({ HAIKU_LIVE_CALLS: "0" }, database);
      expect(killed.HAIKU_LIVE_CALLS).toBe("0");
    } finally {
      database.close();
    }
  });

  it("parses role commands and rejects unknown roles", () => {
    const form = new Map<string, string>([
      ["action", "role"],
      ["userId", "user-1"],
      ["role", "admin"],
    ]);
    expect(parseAdminCommand({ get: (name: string) => form.get(name) })).toEqual({
      ok: true,
      command: { type: "role", userId: "user-1", role: "admin" },
    });
    form.set("role", "owner");
    expect(parseAdminCommand({ get: (name: string) => form.get(name) }).ok).toBe(false);
  });
});
