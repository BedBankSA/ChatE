import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { AdminCommand } from "@/domain/admin/command";
import { endUserSessions } from "@/server/account-access";
import { immediateTransaction } from "@/server/db/transaction";
import { userQuotaId } from "@/server/db/quota-ids";
import { findVerifiedPhoneOwner, readProfilePhone, recordPhoneAudit } from "@/server/phone/audit";

export function applyAdminAction(
  db: DatabaseSync,
  actorId: string,
  command: AdminCommand,
  now: Date,
): { ok: true; changed: boolean } | { ok: false } {
  if (command.type !== "quota" && command.userId === actorId) return { ok: false };
  return immediateTransaction(db, () => applyInside(db, actorId, command, now));
}

function applyInside(
  db: DatabaseSync,
  actorId: string,
  command: AdminCommand,
  now: Date,
): { commit: boolean; value: { ok: true; changed: boolean } | { ok: false } } {
  if (command.type === "quota") return setQuota(db, actorId, command.userId, command.limit);
  if (command.type === "restore") return restore(db, actorId, command.userId, now);
  if (command.type === "role") return setRole(db, actorId, command.userId, command.role);
  if (command.type === "phone") return setPhone(db, actorId, command.userId, command.phone, now);
  if (command.type === "unverify") return unverifyPhone(db, actorId, command.userId, now);
  return suspend(db, actorId, command.userId, command.mode, now);
}

function setRole(
  db: DatabaseSync,
  actorId: string,
  userId: string,
  role: "admin" | "user",
): { commit: boolean; value: { ok: true; changed: boolean } | { ok: false } } {
  const row = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as Record<string, SQLOutputValue> | undefined;
  if (!row || typeof row.role !== "string") return { commit: false, value: { ok: false } };
  if (row.role === role) return { commit: true, value: { ok: true, changed: false } };
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
  writeAudit(db, actorId, "role", userId, { fromRole: row.role, toRole: role });
  return { commit: true, value: { ok: true, changed: true } };
}

function suspend(
  db: DatabaseSync,
  actorId: string,
  userId: string,
  mode: "indefinite" | "7d",
  now: Date,
): { commit: boolean; value: { ok: true; changed: boolean } | { ok: false } } {
  const snap = readSnap(db, userId);
  if (!snap) return { commit: false, value: { ok: false } };
  const nowIso = now.toISOString();
  const until = mode === "7d" ? new Date(now.getTime() + 7 * 86_400_000).toISOString() : null;
  const next = until ? "temporary" : "indefinite";
  const current = statusLabel(snap.status, snap.until, nowIso);
  if (current === next && snap.until === until) return { commit: true, value: { ok: true, changed: false } };
  db.prepare(`
    UPDATE users
    SET status = 'suspended', suspended_until = ?, suspension_reason = ?
    WHERE id = ?
  `).run(until, next === "temporary" ? "إيقاف لسبعة أيام" : "إيقاف غير محدد", userId);
  endUserSessions(db, userId, nowIso);
  writeAudit(db, actorId, "suspend", userId, { fromStatus: current, toStatus: next, until });
  return { commit: true, value: { ok: true, changed: true } };
}

function restore(
  db: DatabaseSync,
  actorId: string,
  userId: string,
  now: Date,
): { commit: boolean; value: { ok: true; changed: boolean } | { ok: false } } {
  const snap = readSnap(db, userId);
  if (!snap) return { commit: false, value: { ok: false } };
  const current = statusLabel(snap.status, snap.until, now.toISOString());
  if (snap.status === "active" && snap.until == null) return { commit: true, value: { ok: true, changed: false } };
  db.prepare(`
    UPDATE users
    SET status = 'active', suspended_until = NULL, suspension_reason = NULL
    WHERE id = ?
  `).run(userId);
  writeAudit(db, actorId, "restore", userId, { fromStatus: current, toStatus: "active", until: null });
  return { commit: true, value: { ok: true, changed: true } };
}

function setQuota(
  db: DatabaseSync,
  actorId: string,
  userId: string,
  limit: number,
): { commit: boolean; value: { ok: true; changed: boolean } | { ok: false } } {
  if (!readSnap(db, userId)) return { commit: false, value: { ok: false } };
  const id = userQuotaId(userId);
  const row = db.prepare("SELECT used_units, reserved_units, limit_units FROM quota_accounts WHERE id = ?").get(id) as Record<string, SQLOutputValue> | undefined;
  const used = numeric(row?.used_units);
  const reserved = numeric(row?.reserved_units);
  if (limit < used + reserved) return { commit: false, value: { ok: false } };
  const current = typeof row?.limit_units === "number" ? row.limit_units : null;
  if (current === limit) return { commit: true, value: { ok: true, changed: false } };
  if (!row) {
    db.prepare(`
      INSERT INTO quota_accounts (id, scope, user_id, limit_units, used_units, reserved_units, in_flight)
      VALUES (?, 'user', ?, ?, 0, 0, 0)
    `).run(id, userId, limit);
  } else {
    db.prepare("UPDATE quota_accounts SET limit_units = ? WHERE id = ?").run(limit, id);
  }
  writeAudit(db, actorId, "quota", userId, { quotaLimit: limit });
  return { commit: true, value: { ok: true, changed: true } };
}

/**
 * Admin phone change: stores the new number UNVERIFIED and appends
 * PHONE_CHANGED_BY_ADMIN. Clearing verification is deliberate: only the
 * customer receiving the SMS can prove ownership of the new number.
 */
function setPhone(
  db: DatabaseSync,
  actorId: string,
  userId: string,
  phone: string,
  now: Date,
): { commit: boolean; value: { ok: true; changed: boolean } | { ok: false } } {
  if (!readSnap(db, userId)) return { commit: false, value: { ok: false } };
  const current = readProfilePhone(db, userId);
  const oldPhone = current?.phoneE164 ?? null;
  if (oldPhone === phone && !current?.phoneVerifiedAt) return { commit: true, value: { ok: true, changed: false } };
  // A number verified by another account cannot be assigned by an admin either.
  if (findVerifiedPhoneOwner(db, phone, userId)) return { commit: false, value: { ok: false } };
  db.prepare(`
    INSERT INTO profiles (user_id, phone_e164, phone_verified_at, updated_at)
    VALUES (?, ?, NULL, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      phone_e164 = excluded.phone_e164,
      phone_verified_at = NULL,
      updated_at = excluded.updated_at
  `).run(userId, phone, now.toISOString());
  recordPhoneAudit(db, {
    userId,
    oldPhone,
    newPhone: phone,
    action: "PHONE_CHANGED_BY_ADMIN",
    phoneVerified: false,
    actorType: "admin",
    actorUserId: actorId,
    metadata: { source: "admin_action" },
    now,
  });
  writeAudit(db, actorId, "phone", userId, { oldPhone, newPhone: phone });
  return { commit: true, value: { ok: true, changed: true } };
}

/** Clears verification for a stuck account without changing the number. */
function unverifyPhone(
  db: DatabaseSync,
  actorId: string,
  userId: string,
  now: Date,
): { commit: boolean; value: { ok: true; changed: boolean } | { ok: false } } {
  if (!readSnap(db, userId)) return { commit: false, value: { ok: false } };
  const current = readProfilePhone(db, userId);
  if (!current?.phoneE164 || !current.phoneVerifiedAt) return { commit: true, value: { ok: true, changed: false } };
  db.prepare("UPDATE profiles SET phone_verified_at = NULL, updated_at = ? WHERE user_id = ?").run(
    now.toISOString(),
    userId,
  );
  recordPhoneAudit(db, {
    userId,
    oldPhone: current.phoneE164,
    newPhone: current.phoneE164,
    action: "PHONE_CHANGED_BY_ADMIN",
    phoneVerified: false,
    actorType: "admin",
    actorUserId: actorId,
    metadata: { source: "admin_unverify" },
    now,
  });
  writeAudit(db, actorId, "unverify", userId, { phone: current.phoneE164 });
  return { commit: true, value: { ok: true, changed: true } };
}

function readSnap(db: DatabaseSync, userId: string): { status: string; until: string | null } | null {
  const row = db.prepare("SELECT status, suspended_until FROM users WHERE id = ?").get(userId) as Record<string, SQLOutputValue> | undefined;
  if (!row || typeof row.status !== "string") return null;
  return { status: row.status, until: typeof row.suspended_until === "string" ? row.suspended_until : null };
}

function statusLabel(status: string, until: string | null, nowIso: string): string {
  if (status !== "suspended") return "active";
  if (!until) return "indefinite";
  return until <= nowIso ? "active" : "temporary";
}

function writeAudit(
  db: DatabaseSync,
  actorId: string,
  action: string,
  target: string,
  metadata: Record<string, string | number | null>,
): void {
  db.prepare(`
    INSERT INTO admin_audit_events (id, admin_user_id, action, target, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), actorId, action, target, JSON.stringify(metadata));
}

function numeric(value: SQLOutputValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}
