import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PHONE_ACTIONS,
  formatPhoneEventTime,
  isPhoneVerified,
  phoneActionLabel,
  phoneStatusLabel,
  safeNextPath,
  verifyPhoneHref,
} from "@/domain/auth/phone-history";
import { migrateDatabase, openDatabase } from "@/server/db/index";
import { StoreError } from "@/server/db/errors";
import { claimAttempt, insertChallenge } from "@/server/otp/service";
import { issueChallenge } from "@/domain/auth/otp";
import {
  countPhoneHistoryRows,
  findVerifiedPhoneOwner,
  readPhoneHistoryForUser,
  readProfilePhone,
  recordPhoneAudit,
} from "@/server/phone/audit";
import { readPhoneState } from "@/server/phone/state";

const MIGRATIONS = path.join(process.cwd(), "migrations");
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PHONE = "+966501234567";
const OTHER_PHONE = "+966555555555";
const NOW = Date.parse("2026-10-29T08:00:00.000Z");

function openMigrated(filePath = ":memory:"): DatabaseSync {
  const db = openDatabase(filePath);
  migrateDatabase(db, MIGRATIONS);
  return db;
}

function seedUser(db: DatabaseSync, id: string, name = "مستخدم"): void {
  db.prepare("INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)").run(
    id,
    "sub-" + id,
    id + "@example.com",
    name,
  );
  db.prepare("INSERT INTO profiles (user_id) VALUES (?)").run(id);
}

function event(patch: Partial<Parameters<typeof recordPhoneAudit>[1]> = {}): Parameters<typeof recordPhoneAudit>[1] {
  return {
    userId: USER_A,
    oldPhone: null,
    newPhone: PHONE,
    action: "OTP_SENT",
    phoneVerified: false,
    actorType: "user",
    actorUserId: USER_A,
    metadata: {},
    now: new Date(NOW),
    ...patch,
  };
}

describe("phone_history migration and append-only store", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openMigrated();
    seedUser(db, USER_A);
    seedUser(db, USER_B);
  });

  afterEach(() => {
    if (db.isOpen) db.close();
  });

  it("creates the permanent table, its indexes and both append-only triggers", () => {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'phone_history'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe("phone_history");
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'phone_history' ORDER BY name")
      .all() as { name: string }[];
    expect(triggers.map((row) => row.name)).toEqual(["phone_history_no_delete", "phone_history_no_update"]);
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'phone_history' AND name NOT LIKE 'sqlite_autoindex%'",
      )
      .all() as { name: string }[];
    expect(indexes.map((row) => row.name).sort()).toEqual([
      "phone_history_action_time_idx",
      "phone_history_phone_time_idx",
      "phone_history_time_idx",
      "phone_history_user_time_idx",
    ]);
  });

  it("refuses UPDATE and DELETE at the database level, even for a raw handle", () => {
    recordPhoneAudit(db, event({ action: "INITIAL_ENTRY" }));
    expect(() => db.prepare("UPDATE phone_history SET new_phone = ?").run(OTHER_PHONE)).toThrow(/PHONE_HISTORY_APPEND_ONLY/);
    expect(() => db.prepare("DELETE FROM phone_history").run()).toThrow(/PHONE_HISTORY_APPEND_ONLY/);
    expect(countPhoneHistoryRows(db, USER_A)).toBe(1);
  });

  it("records every action with actor/network metadata and reads it newest-first", () => {
    for (const action of PHONE_ACTIONS) {
      recordPhoneAudit(
        db,
        event({
          action,
          oldPhone: action.startsWith("PHONE_CHANGED") ? OTHER_PHONE : null,
          newPhone: PHONE,
          phoneVerified: action === "OTP_VERIFIED",
          actorType: action === "PHONE_CHANGED_BY_ADMIN" ? "admin" : "user",
          ip: "203.0.113.9",
          userAgent: "Vitest",
          now: new Date(NOW + PHONE_ACTIONS.indexOf(action) * 1000),
        }),
      );
    }
    const rows = readPhoneHistoryForUser(db, USER_A, 20);
    expect(rows).toHaveLength(PHONE_ACTIONS.length);
    expect(rows[0]?.action).toBe("FAILED_OTP_ATTEMPT");
    expect(rows.at(-1)?.action).toBe("INITIAL_ENTRY");
    const changed = rows.find((row) => row.action === "PHONE_CHANGED_BY_ADMIN");
    expect(changed).toMatchObject({
      oldPhone: OTHER_PHONE,
      newPhone: PHONE,
      actorType: "admin",
      ip: "203.0.113.9",
      userAgent: "Vitest",
    });
    expect(JSON.parse(rows[0]?.metadata ?? "{}")).toEqual({});
  });

  it("rejects an invalid E.164 number or an unknown action before touching SQL", () => {
    expect(() => recordPhoneAudit(db, event({ newPhone: "0501234567" }))).toThrow(StoreError);
    expect(() => recordPhoneAudit(db, event({ action: "DROP_TABLE" as never }))).toThrow(StoreError);
    expect(countPhoneHistoryRows(db, USER_A)).toBe(0);
  });

  it("finds the verified owner of a number and ignores unverified or excluded accounts", () => {
    db.prepare("UPDATE profiles SET phone_e164 = ?, phone_verified_at = ? WHERE user_id = ?").run(
      PHONE,
      new Date(NOW).toISOString(),
      USER_A,
    );
    // B stores the same number but never verified it: B must not be an owner.
    db.prepare("UPDATE profiles SET phone_e164 = ? WHERE user_id = ?").run(PHONE, USER_B);
    expect(findVerifiedPhoneOwner(db, PHONE, USER_B)).toBe(USER_A);
    expect(findVerifiedPhoneOwner(db, PHONE, USER_A)).toBeNull();
    expect(findVerifiedPhoneOwner(db, OTHER_PHONE, USER_B)).toBeNull();
    expect(readProfilePhone(db, USER_A)?.phoneE164).toBe(PHONE);
    expect(readPhoneState(db, USER_B)).toEqual({ phoneE164: PHONE, phoneVerifiedAt: null });
    expect(readProfilePhone(db, "missing-user")).toBeNull();
  });

  it("backfills existing profile phones and OTP challenges once, without deleting data", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chate-phone-backfill-"));
    const partialDir = path.join(dir, "partial-migrations");
    const fullDir = path.join(dir, "all-migrations");
    const db2 = openDatabase(path.join(dir, "backfill.sqlite"));
    try {
      const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
      // Apply 001..007 first, then simulate the upgrade that adds 008.
      mkdirSync(partialDir, { recursive: true });
      mkdirSync(fullDir, { recursive: true });
      for (const file of files) {
        copyFileSync(path.join(MIGRATIONS, file), path.join(fullDir, file));
        if (file < "008") copyFileSync(path.join(MIGRATIONS, file), path.join(partialDir, file));
      }
      migrateDatabase(db2, partialDir);
      db2.prepare("INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)").run(
        USER_A,
        "sub-a",
        "a@example.com",
        "أ",
      );
      db2.prepare("INSERT INTO profiles (user_id, phone_e164, phone_verified_at) VALUES (?, ?, ?)").run(
        USER_A,
        PHONE,
        new Date(NOW).toISOString(),
      );
      const challenge = issueChallenge("123456", "pepper", NOW, null);
      insertChallenge(db2, { userId: USER_A, phoneE164: OTHER_PHONE, challenge, now: NOW });

      expect(migrateDatabase(db2, fullDir)).toEqual(["008_phone_audit.sql", "009_phone_guards_and_indexes.sql"]);
      const rows = readPhoneHistoryForUser(db2, USER_A, 50);
      expect(rows.some((row) => row.action === "OTP_VERIFIED" && row.newPhone === PHONE)).toBe(true);
      expect(rows.some((row) => row.action === "OTP_SENT" && row.newPhone === OTHER_PHONE)).toBe(true);
      expect(rows.every((row) => row.actorType === "system")).toBe(true);
      // Re-running the migration directory is a no-op: the trail is not duplicated.
      expect(migrateDatabase(db2, fullDir)).toEqual([]);
      expect(readPhoneHistoryForUser(db2, USER_A, 50)).toHaveLength(rows.length);
    } finally {
      if (db2.isOpen) db2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("database-level phone guards (migration 009)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openMigrated();
    seedUser(db, USER_A);
    seedUser(db, USER_B);
  });

  afterEach(() => {
    if (db.isOpen) db.close();
  });

  it("grants at most five attempt slots per challenge, even when claimed in a burst", () => {
    const challenge = issueChallenge("123456", "pepper", NOW, null);
    const id = insertChallenge(db, { userId: USER_A, phoneE164: PHONE, challenge, now: NOW });
    const claimed: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      const slot = claimAttempt(db, id, 5);
      if (slot != null) claimed.push(slot);
    }
    expect(claimed).toEqual([1, 2, 3, 4, 5]);
    expect(claimAttempt(db, id, 5)).toBeNull();
    const row = db.prepare("SELECT attempts FROM otp_challenges WHERE id = ?").get(id) as { attempts: number };
    expect(row.attempts).toBe(5);
  });

  it("rejects a second verified owner for the same number at the database level", () => {
    db.prepare("UPDATE profiles SET phone_e164 = ?, phone_verified_at = ? WHERE user_id = ?").run(
      PHONE,
      new Date(NOW).toISOString(),
      USER_A,
    );
    expect(() =>
      db.prepare("UPDATE profiles SET phone_e164 = ?, phone_verified_at = ? WHERE user_id = ?").run(
        PHONE,
        new Date(NOW).toISOString(),
        USER_B,
      ),
    ).toThrow(/PHONE_ALREADY_VERIFIED/);
    // The same account may re-confirm its own number.
    expect(() =>
      db.prepare("UPDATE profiles SET phone_verified_at = ? WHERE user_id = ?").run(
        new Date(NOW + 1000).toISOString(),
        USER_A,
      ),
    ).not.toThrow();
  });

  it("exposes a read-only legacy-duplicate view for the admin", () => {
    const rows = db.prepare("SELECT phone_e164, accounts FROM admin_phone_duplicates").all();
    expect(rows).toEqual([]);
  });
});

describe("phone history domain helpers", () => {
  it("labels every action and actor in Arabic", () => {
    for (const action of PHONE_ACTIONS) expect(phoneActionLabel(action).length).toBeGreaterThan(2);
    expect(phoneActionLabel("UNKNOWN_EVENT")).toBe("حركة غير معروفة");
    expect(phoneStatusLabel({ phoneE164: null, phoneVerifiedAt: null })).toBe("لا يوجد رقم");
    expect(phoneStatusLabel({ phoneE164: PHONE, phoneVerifiedAt: null })).toBe("بانتظار التوثيق");
    expect(isPhoneVerified({ phoneE164: PHONE, phoneVerifiedAt: new Date(NOW).toISOString() })).toBe(true);
    expect(isPhoneVerified({ phoneE164: PHONE, phoneVerifiedAt: null })).toBe(false);
  });

  it("accepts only safe same-origin return paths", () => {
    expect(safeNextPath("/workspace")).toBe("/workspace");
    expect(safeNextPath("/history?page=2")).toBe("/history?page=2");
    expect(safeNextPath("/workspace#results")).toBe("/workspace#results");
    expect(safeNextPath("https://evil.example/x")).toBe("/workspace");
    expect(safeNextPath("//evil.example/x")).toBe("/workspace");
    expect(safeNextPath("\\evil.example")).toBe("/workspace");
    expect(safeNextPath("javascript:alert(1)")).toBe("/workspace");
    expect(safeNextPath("")).toBe("/workspace");
    expect(safeNextPath(null, "/history")).toBe("/history");
    expect(safeNextPath("x".repeat(600))).toBe("/workspace");
    expect(verifyPhoneHref("/workspace")).toBe("/verify-phone?next=%2Fworkspace");
    expect(verifyPhoneHref(null)).toBe("/verify-phone");
  });

  it("formats event times in Riyadh time and survives bad input", () => {
    expect(formatPhoneEventTime(new Date(NOW).toISOString())).not.toBe("—");
    expect(formatPhoneEventTime("not-a-date")).toBe("—");
  });
});
