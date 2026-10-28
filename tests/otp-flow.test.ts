import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/domain/errors";
import {
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  OTP_WINDOW_MS,
  hashOtp,
  issueChallenge,
  verifyChallenge,
} from "@/domain/auth/otp";
import { PHONE_UNVERIFIED_MESSAGE, PHONE_VERIFICATION_MESSAGE, modelUseBlock } from "@/domain/auth/model-gate";
import { migrateDatabase, openDatabase } from "@/server/db/index";
import { otpPepper } from "@/server/otp/config";
import { parseInternationalPhone } from "@/server/otp/phone";
import {
  consumeChallenge,
  countRecentSends,
  hasVerifiedPhone,
  incrementAttempts,
  insertChallenge,
  latestAnyChallenge,
  latestChallenge,
  setVerifiedPhone,
} from "@/server/otp/service";

const MIGRATIONS = path.join(process.cwd(), "migrations");
const PEPPER = "unit-test-pepper";
const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const PHONE = "+966501234567";

function openMigrated(filePath = ":memory:"): DatabaseSync {
  const db = openDatabase(filePath);
  migrateDatabase(db, MIGRATIONS);
  return db;
}

function seedUser(db: DatabaseSync, id = USER_ID): void {
  db.prepare("INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)").run(
    id,
    "sub-" + id,
    id + "@example.com",
    "مستخدم",
  );
  db.prepare("INSERT INTO profiles (user_id) VALUES (?)").run(id);
}

function insertAt(db: DatabaseSync, now: number, code = "123456"): string {
  const challenge = issueChallenge(code, PEPPER, now, null);
  return insertChallenge(db, { userId: USER_ID, phoneE164: PHONE, challenge, now });
}

describe("OTP challenge domain rules", () => {
  it("hashes codes with the pepper and accepts only the matching code once", () => {
    const challenge = issueChallenge("123456", PEPPER, NOW, null);
    expect(challenge.codeHash).toBe(hashOtp("123456", PEPPER));
    expect(challenge.codeHash).not.toBe(hashOtp("123456", "another-pepper"));
    expect(challenge.expiresAt).toBe(NOW + OTP_TTL_MS);
    expect(challenge.attempts).toBe(0);
    expect(challenge.sendCount).toBe(1);
    expect(challenge.consumed).toBe(false);

    const wrong = verifyChallenge(challenge, "000000", PEPPER, NOW + 1000);
    expect(wrong).toMatchObject({ ok: false, reason: "mismatch" });
    if (wrong.ok) return;
    expect(wrong.challenge.attempts).toBe(1);
    expect(wrong.challenge.consumed).toBe(false);

    const passed = verifyChallenge(wrong.challenge, "123456", PEPPER, NOW + 1000);
    expect(passed.ok).toBe(true);
    if (!passed.ok) return;
    expect(passed.challenge.consumed).toBe(true);

    expect(verifyChallenge(passed.challenge, "123456", PEPPER, NOW + 1000)).toMatchObject({
      ok: false,
      reason: "consumed",
    });
  });

  it("rejects a code hashed under a different pepper", () => {
    const challenge = issueChallenge("123456", PEPPER, NOW, null);
    const result = verifyChallenge(challenge, "123456", "wrong-pepper", NOW + 1);
    expect(result).toMatchObject({ ok: false, reason: "mismatch" });
  });

  it("counts sends inside the rolling window and resets after it", () => {
    const first = issueChallenge("111111", PEPPER, NOW, null);
    expect(first.sendCount).toBe(1);
    const second = issueChallenge("222222", PEPPER, NOW + 1000, first);
    expect(second.sendCount).toBe(2);
    expect(second.windowStartedAt).toBe(NOW);
    const third = issueChallenge("333333", PEPPER, NOW + 2000, second);
    expect(third.sendCount).toBe(3);

    let fourthError: unknown;
    try {
      issueChallenge("444444", PEPPER, NOW + 3000, third);
    } catch (error) {
      fourthError = error;
    }
    expect(fourthError).toBeInstanceOf(AppError);
    expect(fourthError).toMatchObject({ code: "OTP_RESEND", statusCode: 429 });

    const afterWindow = issueChallenge("555555", PEPPER, NOW + OTP_WINDOW_MS, third);
    expect(afterWindow.sendCount).toBe(1);
    expect(afterWindow.windowStartedAt).toBe(NOW + OTP_WINDOW_MS);
  });

  it("locks verification after the attempts cap and rejects an expired challenge", () => {
    let challenge = issueChallenge("123456", PEPPER, NOW, null);
    for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
      const failed = verifyChallenge(challenge, "000000", PEPPER, NOW + 1);
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      expect(failed.reason).toBe("mismatch");
      expect(failed.challenge.attempts).toBe(attempt + 1);
      challenge = failed.challenge;
    }
    const capped = verifyChallenge(challenge, "123456", PEPPER, NOW + 2);
    expect(capped).toMatchObject({ ok: false, reason: "attempts" });

    const expiring = issueChallenge("123456", PEPPER, NOW, null);
    expect(verifyChallenge(expiring, "123456", PEPPER, expiring.expiresAt).ok).toBe(true);
    const expired = issueChallenge("123456", PEPPER, NOW, null);
    expect(verifyChallenge(expired, "123456", PEPPER, expired.expiresAt + 1)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });
});

describe("international phone parsing", () => {
  it("accepts one international field with a dialing prefix", () => {
    expect(parseInternationalPhone("+966501234567")).toEqual({ ok: true, e164: "+966501234567" });
    expect(parseInternationalPhone("  +966512345678 ")).toEqual({ ok: true, e164: "+966512345678" });
    expect(parseInternationalPhone("+12025550143")).toEqual({ ok: true, e164: "+12025550143" });
  });

  it("rejects national-only, malformed and overlong input", () => {
    expect(parseInternationalPhone("0501234567").ok).toBe(false);
    expect(parseInternationalPhone("966501234567").ok).toBe(false);
    expect(parseInternationalPhone("+96650123").ok).toBe(false);
    expect(parseInternationalPhone("++966501234567").ok).toBe(false);
    expect(parseInternationalPhone("+999999999999").ok).toBe(false);
    expect(parseInternationalPhone("").ok).toBe(false);
    expect(parseInternationalPhone("+" + "9".repeat(40)).ok).toBe(false);
  });
});

describe("OTP pepper configuration", () => {
  it("prefers OTP_PEPPER, falls back to SESSION_SECRET and fails closed", () => {
    expect(otpPepper({ OTP_PEPPER: "pepper-a", SESSION_SECRET: "session-b" })).toBe("pepper-a");
    expect(otpPepper({ SESSION_SECRET: "session-b" })).toBe("session-b");
    expect(() => otpPepper({})).toThrow(AppError);
  });
});

describe("OTP challenge store", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openMigrated();
    seedUser(db);
  });

  afterEach(() => {
    if (db.isOpen) db.close();
  });

  it("inserts and reads back the latest challenge with ISO timestamps", () => {
    expect(latestChallenge(db, USER_ID)).toBeNull();
    const challenge = issueChallenge("123456", PEPPER, NOW, null);
    const id = insertChallenge(db, { userId: USER_ID, phoneE164: PHONE, challenge, now: NOW });
    const stored = latestChallenge(db, USER_ID);
    expect(stored).toMatchObject({ id, userId: USER_ID, phoneE164: PHONE, createdAt: NOW });
    expect(stored?.challenge).toMatchObject({
      codeHash: hashOtp("123456", PEPPER),
      expiresAt: NOW + OTP_TTL_MS,
      attempts: 0,
      sendCount: 1,
      consumed: false,
    });
  });

  it("tracks attempts and consumes a challenge exactly once", () => {
    const id = insertAt(db, NOW);
    expect(incrementAttempts(db, id)).toBe(1);
    expect(incrementAttempts(db, id)).toBe(2);
    expect(latestChallenge(db, USER_ID)?.challenge.attempts).toBe(2);
    expect(consumeChallenge(db, id, NOW + 1000)).toBe(true);
    expect(consumeChallenge(db, id, NOW + 2000)).toBe(false);
    expect(latestChallenge(db, USER_ID)).toBeNull();
    expect(latestAnyChallenge(db, USER_ID)?.challenge.consumed).toBe(true);
    expect(incrementAttempts(db, id)).toBe(2);
  });

  it("counts only sends inside the window and treats user ids as data", () => {
    insertAt(db, NOW - OTP_WINDOW_MS - 1_000);
    insertAt(db, NOW - 2_000);
    insertAt(db, NOW - 1_000);
    expect(countRecentSends(db, USER_ID, NOW - OTP_WINDOW_MS)).toBe(2);
    expect(countRecentSends(db, USER_ID, NOW - 60_000)).toBe(2);
    expect(latestChallenge(db, "' OR 1=1 --")).toBeNull();
    expect(countRecentSends(db, "' OR 1=1 --", 0)).toBe(0);
  });

  it("enforces the send limit across a database restart", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chate-otp-"));
    const file = path.join(dir, "otp.sqlite");
    let reopened: DatabaseSync | null = null;
    try {
      const first = openMigrated(file);
      seedUser(first);
      for (let index = 0; index < 3; index += 1) {
        insertAt(first, NOW - 1_000 + index);
      }
      first.close();

      reopened = openDatabase(file);
      expect(countRecentSends(reopened, USER_ID, NOW - OTP_WINDOW_MS)).toBe(3);
      const challenge = issueChallenge("123456", PEPPER, NOW, null);
      expect(() =>
        insertChallenge(reopened as DatabaseSync, {
          userId: USER_ID,
          phoneE164: PHONE,
          challenge,
          now: NOW,
        }),
      ).not.toThrow();
    } finally {
      if (reopened?.isOpen) reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a verified phone once without transferring it between users", () => {
    expect(hasVerifiedPhone(db, USER_ID)).toBe(false);
    setVerifiedPhone(db, USER_ID, PHONE, new Date(NOW).toISOString());
    expect(hasVerifiedPhone(db, USER_ID)).toBe(true);
    const row = db
      .prepare("SELECT phone_e164, phone_verified_at FROM profiles WHERE user_id = ?")
      .get(USER_ID) as { phone_e164: string; phone_verified_at: string };
    expect(row.phone_e164).toBe(PHONE);
    expect(row.phone_verified_at).toBe(new Date(NOW).toISOString());

    const otherUser = "33333333-3333-4333-8333-333333333333";
    seedUser(db, otherUser);
    expect(hasVerifiedPhone(db, otherUser)).toBe(false);
    expect(() => setVerifiedPhone(db, USER_ID, "0501234567", new Date(NOW).toISOString())).toThrow();
  });
});

describe("model access gate stays closed until the phone is verified", () => {
  const unverified = {
    name: "مستخدم",
    email: "user@example.com",
    phoneE164: null,
    phoneVerifiedAt: null,
    age: null,
    city: null,
    status: "active" as const,
  };

  it("maps an unwired provider to 503 and a wired provider to 403 profile_incomplete", () => {
    expect(modelUseBlock(unverified, false)).toEqual({
      message: PHONE_VERIFICATION_MESSAGE,
      code: "OTP_UNCONFIGURED",
      status: 503,
    });
    expect(modelUseBlock(unverified, true)).toEqual({
      message: PHONE_UNVERIFIED_MESSAGE,
      code: "profile_incomplete",
      status: 403,
    });
  });

  it("does not unlock model use for a stored but unverified phone", () => {
    expect(modelUseBlock({ ...unverified, phoneE164: PHONE }, true)).toMatchObject({
      code: "profile_incomplete",
      status: 403,
    });
    expect(
      modelUseBlock({ ...unverified, phoneE164: PHONE, phoneVerifiedAt: new Date(NOW).toISOString() }, true),
    ).toBeNull();
    expect(modelUseBlock({ ...unverified, status: "suspended" }, true)).toEqual({
      message: "الحساب موقوف.",
      code: "suspended",
      status: 403,
    });
  });
});
