import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  AdminQueryError,
  e164Query,
  likeContains,
  parseUserQuery,
  type UserListQuery,
} from "@/domain/admin/user-query";
import { nullableText, numberField } from "@/server/db/rows";

// Re-exported so the admin overview keeps one import surface for query errors.
export { AdminQueryError, parseUserQuery };
export type { UserListQuery };

const SORTS: Record<string, string> = {
  id: "id",
  name: "name",
  email: "email",
  phone: "phone",
  city: "city",
  age: "age",
  registeredAt: "registered_at",
  lastActivity: "last_activity_at",
  status: "status_label",
  questions: "questions_in_range",
  apiCalls: "api_calls",
  tokens: "tokens",
  quotaUsed: "quota_used",
  quotaRemaining: "quota_remaining",
};

export type AdminUserRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  phoneVerified: boolean;
  city: string | null;
  age: number | null;
  ageLabel: "user-entered";
  registeredAt: string;
  lastActivityAt: string;
  status: string;
  suspendedUntil: string | null;
  questionsInRange: number;
  apiCalls: number;
  tokens: number | null;
  quotaUsed: number | null;
  quotaReserved: number | null;
  quotaLimit: number | null;
  quotaRemaining: number | null;
};

const INNER_SQL = `
SELECT
  u.id AS id,
  u.name AS name,
  u.email AS email,
  p.phone_e164 AS phone,
  CASE WHEN p.phone_verified_at IS NULL THEN 0 ELSE 1 END AS phone_verified,
  p.city AS city,
  p.age AS age,
  u.created_at AS registered_at,
  u.last_activity_at AS last_activity_at,
  CASE
    WHEN u.status = 'suspended' AND u.suspended_until IS NOT NULL AND u.suspended_until <= ? THEN 'active'
    WHEN u.status = 'suspended' AND u.suspended_until IS NOT NULL THEN 'temporary'
    WHEN u.status = 'suspended' THEN 'indefinite'
    ELSE 'active'
  END AS status_label,
  u.suspended_until AS suspended_until,
  (
    SELECT COUNT(*) FROM operation_stats s
    WHERE s.user_id = u.id AND s.operation_type = 'question' AND s.occurred_at >= ? AND s.occurred_at < ?
  ) AS questions_in_range,
  (
    SELECT COUNT(*) FROM operation_stats s
    WHERE s.user_id = u.id AND s.operation_type = 'generation' AND s.occurred_at >= ? AND s.occurred_at < ?
  ) AS api_calls,
  (
    SELECT SUM(
      COALESCE(s.input_tokens, 0) + COALESCE(s.output_tokens, 0)
      + CASE WHEN s.reasoning_included_in_output = 1 THEN 0 ELSE COALESCE(s.reasoning_tokens, 0) END
    )
    FROM operation_stats s
    WHERE s.user_id = u.id
      AND s.occurred_at >= ? AND s.occurred_at < ?
      AND (s.input_tokens IS NOT NULL OR s.output_tokens IS NOT NULL OR s.reasoning_tokens IS NOT NULL)
  ) AS tokens,
  q.used_units AS quota_used,
  q.reserved_units AS quota_reserved,
  q.limit_units AS quota_limit,
  CASE
    WHEN q.limit_units IS NULL THEN NULL
    ELSE q.limit_units - q.used_units - q.reserved_units
  END AS quota_remaining
FROM users u
LEFT JOIN profiles p ON p.user_id = u.id
LEFT JOIN quota_accounts q ON q.id = ('user:' || u.id)
`;

export function queryUsers(db: DatabaseSync, query: UserListQuery): { rows: AdminUserRow[]; total: number; page: number; pageSize: number } {
  const { where, params } = filters(query);
  const innerParams = [query.nowIso, query.from, query.to, query.from, query.to, query.from, query.to];
  const order = `ORDER BY ${orderColumn(query)} ${query.dir.toUpperCase()} NULLS LAST, id ASC`;
  const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM (${INNER_SQL}) listed ${where}`).get(...innerParams, ...params);
  const total = totalRow ? numberField(totalRow, "total") : 0;
  const offset = (query.page - 1) * query.pageSize;
  const rows = db.prepare(`
    SELECT * FROM (${INNER_SQL}) listed
    ${where}
    ${order}
    LIMIT ? OFFSET ?
  `).all(...innerParams, ...params, query.pageSize, offset);
  return { rows: rows.map(mapUser), total, page: query.page, pageSize: query.pageSize };
}

export function queryUser(db: DatabaseSync, userId: string, query: UserListQuery): AdminUserRow | null {
  const innerParams = [query.nowIso, query.from, query.to, query.from, query.to, query.from, query.to];
  const row = db.prepare(`SELECT * FROM (${INNER_SQL}) listed WHERE id = ?`).get(...innerParams, userId);
  return row ? mapUser(row) : null;
}

export function userAudit(db: DatabaseSync, userId: string): {
  id: string;
  actorId: string;
  action: string;
  at: string;
  reason: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  quotaLimit: number | null;
}[] {
  const rows = db.prepare(`
    SELECT id, admin_user_id, action, created_at, metadata
    FROM admin_audit_events
    WHERE target = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(userId);
  return rows.map((row) => {
    const metadata = parseMetadata(row.metadata);
    return {
      id: text(row, "id"),
      actorId: text(row, "admin_user_id"),
      action: text(row, "action"),
      at: text(row, "created_at"),
      reason: typeof metadata.reason === "string" ? metadata.reason : null,
      fromStatus: typeof metadata.fromStatus === "string" ? metadata.fromStatus : null,
      toStatus: typeof metadata.toStatus === "string" ? metadata.toStatus : null,
      quotaLimit: typeof metadata.quotaLimit === "number" ? metadata.quotaLimit : null,
    };
  });
}

/** Only allowlisted identifiers reach the ORDER BY clause; nothing typed is interpolated. */
function orderColumn(query: UserListQuery): string {
  const column = SORTS[query.sort];
  if (!column) throw new AdminQueryError("حقل الترتيب غير مسموح.");
  return column;
}

function filters(query: UserListQuery): { where: string; params: SQLOutputValue[] } {
  const clauses: string[] = [];
  const params: SQLOutputValue[] = [];
  if (query.q) addSearch(query, clauses, params);
  if (query.statuses.length) addStatus(query.statuses, clauses, params);
  if (query.phoneVerified) {
    clauses.push("phone_verified = ?");
    params.push(query.phoneVerified === "yes" ? 1 : 0);
  }
  addRange(clauses, params, "age", query.ageMin, query.ageMax);
  addRange(clauses, params, "registered_at", query.registeredFrom, query.registeredTo);
  addRange(clauses, params, "last_activity_at", query.activeFrom, query.activeTo);
  addRange(clauses, params, "questions_in_range", query.questionsMin, query.questionsMax);
  addRange(clauses, params, "api_calls", query.callsMin, query.callsMax);
  addRange(clauses, params, "tokens", query.tokensMin, query.tokensMax);
  addRange(clauses, params, "quota_used", query.quotaUsedMin, query.quotaUsedMax);
  addRange(clauses, params, "quota_remaining", query.quotaRemainingMin, query.quotaRemainingMax);
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function addSearch(query: UserListQuery, clauses: string[], params: SQLOutputValue[]): void {
  const like = likeContains(query.q);
  if (query.qField === "name" || query.qField === "email" || query.qField === "city") {
    clauses.push(`${query.qField} LIKE ? ESCAPE '\\'`);
    params.push(like);
    return;
  }
  if (query.qField === "id") {
    clauses.push("id = ?");
    params.push(query.q);
    return;
  }
  if (query.qField === "phone") {
    const phone = e164Query(query.q);
    if (!phone) {
      // A non-E.164 string cannot match a stored E.164 number. Without this
      // guard the LIKE pattern degenerates to '%%' and matches every user.
      clauses.push("1 = 0");
      return;
    }
    clauses.push("(phone = ? OR phone LIKE ? ESCAPE '\\')");
    params.push(phone, `${phone}%`);
    return;
  }
  const parts = ["name LIKE ? ESCAPE '\\'", "email LIKE ? ESCAPE '\\'", "IFNULL(city, '') LIKE ? ESCAPE '\\'", "id = ?"];
  params.push(like, like, like, query.q);
  if (query.q.startsWith("+")) {
    parts.push("IFNULL(phone, '') LIKE ? ESCAPE '\\'");
    params.push(`${query.q}%`);
  }
  clauses.push(`(${parts.join(" OR ")})`);
}

function addStatus(statuses: string[], clauses: string[], params: SQLOutputValue[]): void {
  const labels = statuses.flatMap((status) => (status === "suspended" ? ["temporary", "indefinite"] : [status]));
  clauses.push(`status_label IN (${labels.map(() => "?").join(", ")})`);
  params.push(...labels);
}

function addRange(clauses: string[], params: SQLOutputValue[], column: string, min: number | string | null, max: number | string | null): void {
  if (min != null) {
    clauses.push(`${column} >= ?`);
    params.push(min);
  }
  if (max != null) {
    clauses.push(`${column} <= ?`);
    params.push(max);
  }
}

function mapUser(row: Record<string, SQLOutputValue>): AdminUserRow {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    email: text(row, "email"),
    phone: nullableText(row, "phone"),
    phoneVerified: numberField(row, "phone_verified") === 1,
    city: nullableText(row, "city"),
    age: optionalNumber(row, "age"),
    ageLabel: "user-entered",
    registeredAt: text(row, "registered_at"),
    lastActivityAt: text(row, "last_activity_at"),
    status: text(row, "status_label"),
    suspendedUntil: nullableText(row, "suspended_until"),
    questionsInRange: numberField(row, "questions_in_range"),
    apiCalls: numberField(row, "api_calls"),
    tokens: optionalNumber(row, "tokens"),
    quotaUsed: optionalNumber(row, "quota_used"),
    quotaReserved: optionalNumber(row, "quota_reserved"),
    quotaLimit: optionalNumber(row, "quota_limit"),
    quotaRemaining: optionalNumber(row, "quota_remaining"),
  };
}

function text(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function optionalNumber(row: Record<string, SQLOutputValue>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" ? value : null;
}

function parseMetadata(value: SQLOutputValue | undefined): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
