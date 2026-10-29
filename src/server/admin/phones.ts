import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  emptyAdminPhones,
  parsePhoneListQuery,
  PhoneQueryError,
  type AdminPhoneCustomer,
  type AdminPhoneEvent,
  type AdminPhonesView,
  type PhoneListQuery,
} from "@/domain/admin/phones";
import { normalizeSaudiMobile } from "@/domain/auth/saudi-phone";
import { e164Query, likeContains } from "@/domain/admin/user-query";
import { nullableText, numberField, textField } from "@/server/db/rows";

export type AdminPhonesInput = {
  params: URLSearchParams;
  notice: string | null;
  email: string;
  actorId: string;
};

const EVENTS_LIMIT = 50;

/**
 * Read model for /admin/phones: phone-verification counts, the customer list
 * (filterable to "stuck" = unverified) and the append-only phone history.
 * Every identifier/value is bound; only allowlisted ORDER BY columns are used.
 */
export function buildAdminPhones(db: DatabaseSync, input: AdminPhonesInput): AdminPhonesView {
  let query: PhoneListQuery;
  let loadError: string | null = null;
  try {
    query = parsePhoneListQuery(input.params);
  } catch (error) {
    loadError = error instanceof PhoneQueryError ? error.message : "تعذر قراءة مرشحات السجل.";
    query = parsePhoneListQuery(new URLSearchParams());
  }
  try {
    const counts = readCounts(db);
    const customers = readCustomers(db, query);
    const events = readEvents(db, query);
    return {
      email: input.email,
      actorId: input.actorId,
      counts,
      customers: customers.rows,
      customerTotal: customers.total,
      events,
      page: query.page,
      pageSize: query.pageSize,
      q: query.q,
      status: query.status,
      action: query.action,
      userId: query.userId,
      notice: input.notice,
      loadError,
    };
  } catch {
    return emptyAdminPhones({
      email: input.email,
      actorId: input.actorId,
      notice: input.notice,
      loadError: "تعذر قراءة قاعدة سجل الأرقام.",
    });
  }
}

function readCounts(db: DatabaseSync): { total: number; verified: number; unverified: number; duplicatePhones: number } {
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN p.phone_verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified
      FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
    `)
    .get() as Record<string, SQLOutputValue> | undefined;
  const total = row ? numberField(row, "total") : 0;
  const verified = row && typeof row.verified === "number" ? row.verified : 0;
  const duplicateRow = db.prepare("SELECT COUNT(*) AS n FROM admin_phone_duplicates").get() as
    | Record<string, SQLOutputValue>
    | undefined;
  return {
    total,
    verified,
    unverified: Math.max(0, total - verified),
    duplicatePhones: duplicateRow ? numberField(duplicateRow, "n") : 0,
  };
}

function readCustomers(db: DatabaseSync, query: PhoneListQuery): { rows: AdminPhoneCustomer[]; total: number } {
  const { where, params } = customerFilters(query);
  const totalRow = db
    .prepare(`
      SELECT COUNT(*) AS total
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      ${where}
    `)
    .get(...params) as Record<string, SQLOutputValue> | undefined;
  const total = totalRow ? numberField(totalRow, "total") : 0;
  const offset = (query.page - 1) * query.pageSize;
  const rows = db
    .prepare(`
      SELECT u.id, u.name, u.email, u.status, u.created_at, u.last_activity_at,
             p.phone_e164, p.phone_verified_at
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      ${where}
      ORDER BY (p.phone_verified_at IS NOT NULL) ASC, u.created_at DESC, u.id ASC
      LIMIT ? OFFSET ?
    `)
    .all(...params, query.pageSize, offset) as Record<string, SQLOutputValue>[];
  return { rows: rows.map(mapCustomer), total };
}

function customerFilters(query: PhoneListQuery): { where: string; params: SQLOutputValue[] } {
  const clauses: string[] = [];
  const params: SQLOutputValue[] = [];
  if (query.status === "unverified") clauses.push("p.phone_verified_at IS NULL");
  if (query.status === "verified") clauses.push("p.phone_verified_at IS NOT NULL");
  if (query.userId) {
    clauses.push("u.id = ?");
    params.push(query.userId);
  }
  if (query.q) {
    const like = likeContains(query.q);
    const parts = ["u.name LIKE ? ESCAPE '\\'", "u.email LIKE ? ESCAPE '\\'", "u.id = ?"];
    params.push(like, like, query.q);
    const phones = new Set<string>();
    const e164 = e164Query(query.q);
    if (e164) phones.add(e164);
    const normalized = normalizeSaudiMobile(query.q);
    if (normalized.ok) phones.add(normalized.e164);
    for (const phone of phones) {
      parts.push("p.phone_e164 = ?");
      params.push(phone);
    }
    parts.push("IFNULL(p.phone_e164, '') LIKE ? ESCAPE '\\'");
    params.push(like);
    clauses.push(`(${parts.join(" OR ")})`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function readEvents(db: DatabaseSync, query: PhoneListQuery): AdminPhoneEvent[] {
  const clauses: string[] = [];
  const params: SQLOutputValue[] = [];
  if (query.userId) {
    clauses.push("h.user_id = ?");
    params.push(query.userId);
  }
  if (query.action) {
    clauses.push("h.action = ?");
    params.push(query.action);
  }
  if (query.q) {
    const like = likeContains(query.q);
    const normalized = normalizeSaudiMobile(query.q);
    const parts = [
      "h.new_phone LIKE ? ESCAPE '\\'",
      "IFNULL(h.old_phone, '') LIKE ? ESCAPE '\\'",
      "u.name LIKE ? ESCAPE '\\'",
      "u.email LIKE ? ESCAPE '\\'",
    ];
    params.push(like, like, like, like);
    if (normalized.ok) {
      parts.push("h.new_phone = ?");
      params.push(normalized.e164);
    }
    clauses.push(`(${parts.join(" OR ")})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`
      SELECT h.id, h.user_id, h.old_phone, h.new_phone, h.action, h.phone_verified,
             h.actor_type, h.actor_user_id, h.ip, h.created_at,
             u.name AS user_name, u.email AS user_email
      FROM phone_history h
      LEFT JOIN users u ON u.id = h.user_id
      ${where}
      ORDER BY h.created_at DESC, h.rowid DESC
      LIMIT ${EVENTS_LIMIT}
    `)
    .all(...params) as Record<string, SQLOutputValue>[];
  return rows.map(mapEvent);
}

function mapCustomer(row: Record<string, SQLOutputValue>): AdminPhoneCustomer {
  return {
    id: textField(row, "id"),
    name: textField(row, "name"),
    email: textField(row, "email"),
    phone: nullableText(row, "phone_e164"),
    phoneVerifiedAt: nullableText(row, "phone_verified_at"),
    accountStatus: textField(row, "status"),
    registeredAt: textField(row, "created_at"),
    lastActivityAt: textField(row, "last_activity_at"),
  };
}

function mapEvent(row: Record<string, SQLOutputValue>): AdminPhoneEvent {
  return {
    id: textField(row, "id"),
    userId: textField(row, "user_id"),
    userName: nullableText(row, "user_name"),
    userEmail: nullableText(row, "user_email"),
    oldPhone: nullableText(row, "old_phone"),
    newPhone: textField(row, "new_phone"),
    action: textField(row, "action"),
    phoneVerified: numberField(row, "phone_verified") === 1,
    actorType: textField(row, "actor_type"),
    actorUserId: nullableText(row, "actor_user_id"),
    ip: nullableText(row, "ip"),
    createdAt: textField(row, "created_at"),
  };
}