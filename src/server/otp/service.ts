import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { OtpChallenge } from "@/domain/auth/otp";
import { StoreError } from "@/server/db/errors";
import { changeCount, numberField, textField } from "@/server/db/rows";
import { requireInteger, requireText } from "@/server/db/validate";

/**
 * Persisted OTP challenge. The domain-level OtpChallenge stays storage
 * agnostic, so row identity, target phone and insert time live alongside it.
 */
export type StoredChallenge = {
  id: string;
  userId: string;
  phoneE164: string;
  createdAt: number;
  challenge: OtpChallenge;
};

export const OTP_PHONE_E164 = /^\+[1-9]\d{6,14}$/;

const COLUMNS = "id, user_id, phone_e164, code_hash, expires_at, attempts, send_count, consumed_at, created_at";
const MAX_TIMESTAMP_MS = 9_000_000_000_000_000;

/** Newest challenge for a user that has not been consumed yet (verify target). */
export function latestChallenge(db: DatabaseSync, userId: string): StoredChallenge | null {
  return readChallenge(db, `SELECT ${COLUMNS} FROM otp_challenges WHERE user_id = ? AND consumed_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`, userId);
}

/**
 * Newest challenge regardless of consumption. Used when issuing a resend so the
 * send/window counters continue from the previous code.
 */
export function latestAnyChallenge(db: DatabaseSync, userId: string): StoredChallenge | null {
  return readChallenge(db, `SELECT ${COLUMNS} FROM otp_challenges WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, userId);
}

export function insertChallenge(
  db: DatabaseSync,
  input: { userId: string; phoneE164: string; challenge: OtpChallenge; now: number },
): string {
  const userId = requireText(input.userId, "USER_ID");
  const phoneE164 = requirePhone(input.phoneE164);
  const codeHash = requireText(input.challenge.codeHash, "OTP_HASH", 128);
  const attempts = requireInteger(input.challenge.attempts, "OTP_ATTEMPTS", 0, 1000);
  const sendCount = requireInteger(input.challenge.sendCount, "OTP_SEND_COUNT", 1, 1000);
  const nowMs = requireInteger(input.now, "OTP_NOW", 0, MAX_TIMESTAMP_MS);
  if (!Number.isFinite(input.challenge.expiresAt) || input.challenge.expiresAt <= 0) {
    throw new StoreError("OTP_EXPIRY");
  }
  const id = randomUUID();
  db.prepare(`
    INSERT INTO otp_challenges
      (id, user_id, phone_e164, code_hash, expires_at, attempts, send_count, consumed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    id,
    userId,
    phoneE164,
    codeHash,
    new Date(input.challenge.expiresAt).toISOString(),
    attempts,
    sendCount,
    new Date(nowMs).toISOString(),
  );
  return id;
}

/**
 * Atomically increments the attempt counter and returns the stored value.
 * A single SQL statement is used so parallel wrong-code requests cannot each
 * read the same attempt count and overwrite each other's increment.
 */
export function incrementAttempts(db: DatabaseSync, challengeId: string): number {
  const id = requireText(challengeId, "OTP_ID", 64);
  db.prepare("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL").run(id);
  const row = db.prepare("SELECT attempts FROM otp_challenges WHERE id = ?").get(id) as
    | Record<string, SQLOutputValue>
    | undefined;
  if (!row) throw new StoreError("OTP_ROW");
  return numberField(row, "attempts");
}

/** Marks a challenge single-use. Returns false when it was already consumed. */
export function consumeChallenge(db: DatabaseSync, challengeId: string, nowMs: number): boolean {
  const now = requireInteger(nowMs, "OTP_NOW", 0, MAX_TIMESTAMP_MS);
  const result = db
    .prepare("UPDATE otp_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
    .run(new Date(now).toISOString(), requireText(challengeId, "OTP_ID", 64));
  return changeCount(result) === 1;
}

/**
 * Counts sends inside the rolling window. This is the authoritative resend rate
 * limit: it reads the shared SQLite rows, so it survives server restarts and is
 * enforced across processes.
 */
export function countRecentSends(db: DatabaseSync, userId: string, sinceMs: number): number {
  const since = requireInteger(sinceMs, "OTP_SINCE", 0, MAX_TIMESTAMP_MS);
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM otp_challenges WHERE user_id = ? AND created_at >= ?")
    .get(requireText(userId, "USER_ID"), new Date(since).toISOString());
  if (!row) return 0;
  return numberField(row as Record<string, SQLOutputValue>, "total");
}

/**
 * Marks this user's phone verified. Only the current user's profile row is
 * touched: a shared E.164 (family phone) does not transfer verification between
 * accounts, because verification always follows this user's own challenge.
 */
export function setVerifiedPhone(db: DatabaseSync, userId: string, e164: string, verifiedAtIso: string): void {
  const id = requireText(userId, "USER_ID");
  const phone = requirePhone(e164);
  const verifiedAt = requireIsoTimestamp(verifiedAtIso, "PHONE_VERIFIED_AT");
  db.prepare(`
    INSERT INTO profiles (user_id, phone_e164, phone_verified_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      phone_e164 = excluded.phone_e164,
      phone_verified_at = excluded.phone_verified_at,
      updated_at = excluded.updated_at
  `).run(id, phone, verifiedAt, verifiedAt);
}

export function hasVerifiedPhone(db: DatabaseSync, userId: string): boolean {
  const row = db
    .prepare("SELECT phone_verified_at FROM profiles WHERE user_id = ?")
    .get(requireText(userId, "USER_ID")) as Record<string, SQLOutputValue> | undefined;
  if (!row) return false;
  const verifiedAt = row.phone_verified_at;
  return typeof verifiedAt === "string" && verifiedAt.trim().length > 0;
}

function readChallenge(db: DatabaseSync, sql: string, userId: string): StoredChallenge | null {
  const row = db.prepare(sql).get(requireText(userId, "USER_ID")) as Record<string, SQLOutputValue> | undefined;
  if (!row) return null;
  const expiresAt = Date.parse(textField(row, "expires_at"));
  const createdAt = Date.parse(textField(row, "created_at"));
  if (!Number.isFinite(expiresAt) || !Number.isFinite(createdAt)) throw new StoreError("OTP_ROW");
  const consumedAt = row.consumed_at == null ? null : textField(row, "consumed_at");
  return {
    id: textField(row, "id"),
    userId: textField(row, "user_id"),
    phoneE164: requirePhone(textField(row, "phone_e164")),
    createdAt,
    challenge: {
      codeHash: textField(row, "code_hash"),
      expiresAt,
      attempts: numberField(row, "attempts"),
      sendCount: numberField(row, "send_count"),
      windowStartedAt: createdAt,
      consumed: consumedAt != null,
    },
  };
}

function requirePhone(value: string): string {
  if (typeof value !== "string" || !OTP_PHONE_E164.test(value)) throw new StoreError("PHONE_E164");
  return value;
}

function requireIsoTimestamp(value: string, code: string): string {
  const text = requireText(value, code, 40);
  if (!Number.isFinite(Date.parse(text))) throw new StoreError(code);
  return text;
}
