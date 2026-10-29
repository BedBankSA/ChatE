import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isPhoneAction, type PhoneAction, type PhoneActorType } from "@/domain/auth/phone-history";
import { StoreError } from "@/server/db/errors";
import { nullableText, numberField, textField } from "@/server/db/rows";
import { requireInteger, requireText } from "@/server/db/validate";

/** Server-side E.164 shape shared with the OTP store. */
export const PHONE_E164_PATTERN = /^\+[1-9]\d{6,14}$/;

const MAX_IP = 64;
const MAX_USER_AGENT = 400;
const MAX_METADATA = 2000;
const MAX_TIMESTAMP_MS = 9_000_000_000_000_000;

export type PhoneAuditEvent = {
  userId: string;
  oldPhone: string | null;
  newPhone: string;
  action: PhoneAction;
  /** Verification state of newPhone *after* this event. */
  phoneVerified: boolean;
  actorType: PhoneActorType;
  actorUserId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
  now?: Date;
};

export type PhoneHistoryRow = {
  id: string;
  userId: string;
  oldPhone: string | null;
  newPhone: string;
  action: string;
  phoneVerified: boolean;
  actorType: string;
  actorUserId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: string;
  createdAt: string;
};

export type ProfilePhone = {
  phoneE164: string | null;
  phoneVerifiedAt: string | null;
};

function clean(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Control characters are stripped so the audit table cannot be used as a
  // log-injection vehicle if a header ever contains them.
  return trimmed.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) || null;
}

function optionalPhone(value: string | null | undefined): string | null {
  return typeof value === "string" && PHONE_E164_PATTERN.test(value) ? value : null;
}

/**
 * Appends one immutable phone/activation event. This is the only write path to
 * phone_history; the table itself rejects UPDATE/DELETE at the database level.
 *
 * Callers that must never lose the event (verification, admin changes) run this
 * inside the same immediate transaction as the profile mutation.
 */
export function recordPhoneAudit(db: DatabaseSync, event: PhoneAuditEvent): void {
  const userId = requireText(event.userId, "PHONE_AUDIT_USER");
  if (typeof event.newPhone !== "string" || !PHONE_E164_PATTERN.test(event.newPhone)) {
    throw new StoreError("PHONE_AUDIT_PHONE");
  }
  // Runtime guard: the DB CHECK constraint is the last line of defence, but a
  // bug should fail here with an internal code, not a raw SQLite message.
  if (!isPhoneAction(event.action)) throw new StoreError("PHONE_AUDIT_ACTION");
  const actorType: PhoneActorType =
    event.actorType === "admin" ? "admin" : event.actorType === "system" ? "system" : "user";
  const metadata = JSON.stringify(event.metadata ?? {});
  if (metadata.length > MAX_METADATA) throw new StoreError("PHONE_AUDIT_META");
  const now = event.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new StoreError("PHONE_AUDIT_TIME");
  const nowMs = requireInteger(now.getTime(), "PHONE_AUDIT_TIME", 0, MAX_TIMESTAMP_MS);
  db.prepare(`
    INSERT INTO phone_history
      (id, user_id, old_phone, new_phone, action, phone_verified, actor_type, actor_user_id, ip, user_agent, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    userId,
    optionalPhone(event.oldPhone),
    event.newPhone,
    event.action,
    event.phoneVerified ? 1 : 0,
    actorType,
    clean(event.actorUserId, 200),
    typeof event.ip === "string" && event.ip.length > MAX_IP ? event.ip.slice(0, MAX_IP) : clean(event.ip, MAX_IP),
    clean(event.userAgent, MAX_USER_AGENT),
    metadata,
    new Date(nowMs).toISOString(),
  );
}

/** Newest-first history for one customer (customer dashboard and admin drill-down). */
export function readPhoneHistoryForUser(db: DatabaseSync, userId: string, limit = 20): PhoneHistoryRow[] {
  const id = requireText(userId, "PHONE_HISTORY_USER");
  const size = requireInteger(limit, "PHONE_HISTORY_LIMIT", 1, 200);
  const rows = db
    .prepare(`
      SELECT id, user_id, old_phone, new_phone, action, phone_verified, actor_type,
             actor_user_id, ip, user_agent, metadata, created_at
      FROM phone_history
      WHERE user_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
    .all(id, size) as Record<string, SQLOutputValue>[];
  return rows.map(mapHistoryRow);
}

export function countPhoneHistoryRows(db: DatabaseSync, userId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM phone_history WHERE user_id = ?")
    .get(requireText(userId, "PHONE_HISTORY_USER")) as Record<string, SQLOutputValue> | undefined;
  return row ? numberField(row, "total") : 0;
}

/**
 * Race-safe duplicate-phone guard: returns the other account that already has
 * this exact number verified, or null. A number can belong to only one
 * verified account, so a customer can never take over someone else's identity.
 */
export function findVerifiedPhoneOwner(db: DatabaseSync, phoneE164: string, excludeUserId: string): string | null {
  if (typeof phoneE164 !== "string" || !PHONE_E164_PATTERN.test(phoneE164)) {
    throw new StoreError("PHONE_OWNER_PHONE");
  }
  const row = db
    .prepare(`
      SELECT user_id FROM profiles
      WHERE phone_e164 = ? AND phone_verified_at IS NOT NULL AND user_id <> ?
      LIMIT 1
    `)
    .get(phoneE164, requireText(excludeUserId, "PHONE_OWNER_USER")) as Record<string, SQLOutputValue> | undefined;
  return row && typeof row.user_id === "string" ? row.user_id : null;
}

/** Current profile phone facts, or null when the account row is gone. */
export function readProfilePhone(db: DatabaseSync, userId: string): ProfilePhone | null {
  const row = db
    .prepare("SELECT phone_e164, phone_verified_at FROM profiles WHERE user_id = ?")
    .get(requireText(userId, "PROFILE_PHONE_USER")) as Record<string, SQLOutputValue> | undefined;
  if (!row) return null;
  return {
    phoneE164: nullableText(row, "phone_e164"),
    phoneVerifiedAt: nullableText(row, "phone_verified_at"),
  };
}

function mapHistoryRow(row: Record<string, SQLOutputValue>): PhoneHistoryRow {
  return {
    id: textField(row, "id"),
    userId: textField(row, "user_id"),
    oldPhone: nullableText(row, "old_phone"),
    newPhone: textField(row, "new_phone"),
    action: textField(row, "action"),
    phoneVerified: numberField(row, "phone_verified") === 1,
    actorType: textField(row, "actor_type"),
    actorUserId: nullableText(row, "actor_user_id"),
    ip: nullableText(row, "ip"),
    userAgent: nullableText(row, "user_agent"),
    metadata: textField(row, "metadata"),
    createdAt: textField(row, "created_at"),
  };
}
