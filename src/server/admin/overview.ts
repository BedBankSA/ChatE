import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { evaluateAlerts, externalAlertResult, isAlertKind, type AlertInput, type AlertThreshold } from "@/domain/admin/alerts";
import {
  PROVIDER_UNAVAILABLE,
  SECRETS_EMPTY,
  SECRETS_PARTIAL,
  publishAdminOverview,
  secretValues,
  serviceConfigured,
  type AdminAuditItem,
  type AdminDashboardData,
  type AdminMetric,
  type AdminSecretVersion,
  type AdminServiceState,
  type AdminUserView,
} from "@/domain/admin/dashboard";
import { PRESENCE_NOTE } from "@/domain/admin/presence";
import { resolveRange, type TimeRange } from "@/domain/admin/range";
import { SERVICE_IDS, servicePurpose } from "@/domain/admin/services";
import { isAdmin } from "@/domain/auth/access";
import { adminAllowlist } from "@/domain/admin/access";
import { AdminQueryError, parseUserQuery, queryUsers, type AdminUserRow } from "@/server/admin/users";
import { SHARED_QUOTA_ID } from "@/server/db/quota-ids";

export type OverviewInput = {
  now: Date;
  params: URLSearchParams;
  email: string;
  actorId: string;
  notice: string | null;
  env: Record<string, string | undefined>;
};

// Counters, account fields, and secret status only. No question, answer, or file text.
export function buildAdminOverview(db: DatabaseSync, input: OverviewInput): AdminDashboardData {
  const range = reportRange(input.params, input.now);
  const nowIso = input.now.toISOString();
  const users = usersSection(db, input.params, range, nowIso, input.env);
  const versions = secretVersions(db);
  const draft: AdminDashboardData = {
    email: input.email,
    actorId: input.actorId,
    rangeKey: range.key,
    query: users.query,
    metrics: metricsOf(db, range),
    users: users.users,
    userTotal: users.userTotal,
    page: users.page,
    pageSize: users.pageSize,
    audit: auditItems(db),
    alerts: alertItems(db, range),
    externalAlertReason: externalAlertResult().reason,
    providerReason: PROVIDER_UNAVAILABLE,
    secretsNote: versions.length ? SECRETS_PARTIAL : SECRETS_EMPTY,
    secretVersions: versions,
    services: serviceStates(input.env),
    presenceNote: PRESENCE_NOTE,
    notice: input.notice,
    loadError: users.loadError,
  };
  return publishAdminOverview(draft, secretValues(input.env));
}

function reportRange(params: URLSearchParams, now: Date): TimeRange {
  const resolved = resolveRange({ key: params.get("range"), from: params.get("from"), to: params.get("to"), now });
  if (resolved.ok) return resolved.range;
  const fallback = resolveRange({ key: "7d", from: null, to: null, now });
  if (!fallback.ok) throw new Error("RANGE");
  return fallback.range;
}

function usersSection(db: DatabaseSync, params: URLSearchParams, range: TimeRange, nowIso: string, env: Record<string, string | undefined>): {
  users: AdminUserView[];
  userTotal: number;
  page: number;
  pageSize: number;
  query: string;
  loadError: string | null;
} {
  const parsed = userQuery(params, range, nowIso);
  const listed = queryUsers(db, parsed.query);
  return {
    users: listed.rows.map((row) => toView(row, env)),
    userTotal: listed.total,
    page: listed.page,
    pageSize: listed.pageSize,
    query: parsed.query.q,
    loadError: parsed.loadError,
  };
}

function userQuery(params: URLSearchParams, range: TimeRange, nowIso: string): {
  query: ReturnType<typeof parseUserQuery>;
  loadError: string | null;
} {
  const window = { from: range.from, to: range.to };
  try {
    return { query: parseUserQuery(params, window, nowIso), loadError: null };
  } catch (error) {
    const loadError = error instanceof AdminQueryError ? error.message : "تعذر قراءة المستخدمين.";
    return { query: parseUserQuery(new URLSearchParams(), window, nowIso), loadError };
  }
}

function toView(row: AdminUserRow, env: Record<string, string | undefined>): AdminUserView {
  const envAdmin = isAdmin({ googleSub: row.googleSub, email: row.email }, adminAllowlist(env));
  const dbAdmin = row.role === "admin";
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: dbAdmin || envAdmin ? "admin" : "user",
    roleSource: dbAdmin ? "db" : envAdmin ? "env" : "db",
    phone: row.phone,
    phoneVerified: row.phoneVerified,
    city: row.city,
    status: row.status,
    questionsInRange: row.questionsInRange,
    apiCalls: row.apiCalls,
    tokens: row.tokens,
    quotaLimit: row.quotaLimit,
    quotaRemaining: row.quotaRemaining,
  };
}

function metricsOf(db: DatabaseSync, range: TimeRange): AdminMetric[] {
  const questions = opCount(db, "question", range.from, range.to);
  const calls = opCount(db, "generation", range.from, range.to);
  const failures = failedCount(db, range.from, range.to);
  const classes = failureClasses(db, range.from, range.to);
  const tokens = tokenReading(db, range.from, range.to);
  const storage = storageTotals(db);
  return [
    paired("accounts", "الحسابات", countWhere(db, "SELECT COUNT(*) AS n FROM users", []), null, "كل الحسابات المسجلة"),
    paired("questions", "الأسئلة", questions, opCount(db, "question", range.previousFrom, range.previousTo), "عمليات السؤال في المدى"),
    paired("calls", "الاستدعاءات", calls, opCount(db, "generation", range.previousFrom, range.previousTo), "استدعاءات التوليد في المدى"),
    paired("failures", "الأخطاء", failures, failedCount(db, range.previousFrom, range.previousTo), `حد المعدل ${classes.rate}، مصادقة ${classes.auth}، خدمة ${classes.service}`),
    tokens.known > 0
      ? paired("tokens", "الرموز", tokens.value ?? 0, null, "مجموع محلي للرموز المعروفة")
      : missing("tokens", "الرموز", "لا قراءات رموز في هذه الفترة."),
    // No heartbeat route writes the presence table in this build. Reporting a
    // hard zero would claim nobody is online; report the honest state instead.
    missing("presenceRegistered", "حاضرون مسجلون", PRESENCE_UNAVAILABLE),
    missing("presenceAnonymous", "زوار بلا حساب", PRESENCE_UNAVAILABLE),
    paired("storageFiles", "الملفات", storage.files, null, "العدد فقط، بلا أسماء أو محتوى"),
    paired("storageBytes", "حجم التخزين", storage.bytes, null, "بايت، بلا أسماء أو محتوى"),
  ];
}

const PRESENCE_UNAVAILABLE = "لا نبض حضور موصول بهذا البناء.";


function paired(id: string, label: string, value: number, previous: number | null, detail: string): AdminMetric {
  return { id, label, value, previous, source: "local", detail };
}

function missing(id: string, label: string, detail: string): AdminMetric {
  return { id, label, value: null, previous: null, source: "unavailable", detail };
}

function opCount(db: DatabaseSync, type: string, from: string, to: string): number {
  return countWhere(db, `
    SELECT COUNT(*) AS n FROM operation_stats
    WHERE operation_type = ? AND occurred_at >= ? AND occurred_at < ?
  `, [type, from, to]);
}

function failedCount(db: DatabaseSync, from: string, to: string): number {
  return countWhere(db, `
    SELECT COUNT(*) AS n FROM operation_stats
    WHERE status = 'failed' AND occurred_at >= ? AND occurred_at < ?
  `, [from, to]);
}

function failureClasses(db: DatabaseSync, from: string, to: string): { rate: number; auth: number; service: number } {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN error_code IN ('RATE_LIMIT', '429') THEN 1 ELSE 0 END) AS rate,
      SUM(CASE WHEN error_code IN ('AUTH', 'PROVIDER_AUTH') THEN 1 ELSE 0 END) AS auth,
      SUM(CASE WHEN error_code IN ('SERVICE', 'PROVIDER_UNAVAILABLE', 'HTTP') THEN 1 ELSE 0 END) AS service
    FROM operation_stats
    WHERE status = 'failed' AND occurred_at >= ? AND occurred_at < ?
  `).get(from, to) as Record<string, SQLOutputValue> | undefined;
  return { rate: numeric(row?.rate), auth: numeric(row?.auth), service: numeric(row?.service) };
}

function tokenReading(db: DatabaseSync, from: string, to: string): { value: number | null; known: number } {
  const row = db.prepare(`
    SELECT
      SUM(
        COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
        + CASE WHEN reasoning_included_in_output = 1 THEN 0 ELSE COALESCE(reasoning_tokens, 0) END
      ) AS tokens,
      SUM(CASE
        WHEN input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR reasoning_tokens IS NOT NULL THEN 1
        ELSE 0
      END) AS known
    FROM operation_stats
    WHERE occurred_at >= ? AND occurred_at < ?
  `).get(from, to) as Record<string, SQLOutputValue> | undefined;
  const known = numeric(row?.known);
  return { known, value: known > 0 ? numeric(row?.tokens) : null };
}

function storageTotals(db: DatabaseSync): { files: number; bytes: number } {
  const row = db.prepare("SELECT file_count, storage_bytes FROM admin_storage_totals").get() as Record<string, SQLOutputValue> | undefined;
  return { files: numeric(row?.file_count), bytes: numeric(row?.storage_bytes) };
}

function auditItems(db: DatabaseSync): AdminAuditItem[] {
  const rows = db.prepare(`
    SELECT id, admin_user_id, action, target, created_at
    FROM admin_audit_events
    ORDER BY created_at DESC
    LIMIT 20
  `).all() as Record<string, SQLOutputValue>[];
  return rows.flatMap((row) => {
    if (typeof row.id !== "string" || typeof row.admin_user_id !== "string" || typeof row.action !== "string") return [];
    if (typeof row.target !== "string" || typeof row.created_at !== "string") return [];
    return [{ id: row.id, actorId: row.admin_user_id, action: row.action, target: row.target, at: row.created_at }];
  });
}

function alertItems(db: DatabaseSync, range: TimeRange): { kind: string; message: string }[] {
  return evaluateAlerts(alertInput(db, range), readThresholds(db)).map((item) => ({ kind: item.kind, message: item.message }));
}

function alertInput(db: DatabaseSync, range: TimeRange): AlertInput {
  return {
    quotaRemainingRatio: sharedRatio(db),
    rateLimitCount: countWhere(db, `
      SELECT COUNT(*) AS n FROM operation_stats
      WHERE occurred_at >= ? AND occurred_at < ? AND error_code IN ('RATE_LIMIT', '429')
    `, [range.from, range.to]),
    keyFailed: openRouterKeyFailed(db),
    serviceDown: countWhere(db, `
      SELECT COUNT(*) AS n FROM service_checks
      WHERE last_failure_at IS NOT NULL AND (last_success_at IS NULL OR last_failure_at > last_success_at)
    `, []) > 0,
    currentRequests: countWhere(db, "SELECT COUNT(*) AS n FROM operation_stats WHERE occurred_at >= ? AND occurred_at < ?", [range.from, range.to]),
    previousRequests: countWhere(db, "SELECT COUNT(*) AS n FROM operation_stats WHERE occurred_at >= ? AND occurred_at < ?", [range.previousFrom, range.previousTo]),
    syncFailed: countWhere(db, "SELECT COUNT(*) AS n FROM provider_snapshots WHERE ok = 0", []) > 0,
  };
}

function readThresholds(db: DatabaseSync): AlertThreshold[] {
  const rows = db.prepare("SELECT kind, enabled, threshold, notify_external FROM alert_thresholds").all() as Record<string, SQLOutputValue>[];
  return rows.flatMap((row) => {
    if (typeof row.kind !== "string" || !isAlertKind(row.kind)) return [];
    return [{
      kind: row.kind,
      enabled: row.enabled === 1,
      threshold: typeof row.threshold === "number" ? row.threshold : null,
      notifyExternal: row.notify_external === 1,
    }];
  });
}

function sharedRatio(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT limit_units, used_units, reserved_units FROM quota_accounts WHERE id = ?").get(SHARED_QUOTA_ID) as Record<string, SQLOutputValue> | undefined;
  if (!row || typeof row.limit_units !== "number" || row.limit_units <= 0) return null;
  return (row.limit_units - numeric(row.used_units) - numeric(row.reserved_units)) / row.limit_units;
}

function openRouterKeyFailed(db: DatabaseSync): boolean {
  const row = db.prepare(`
    SELECT last_error_code, last_failure_at, last_success_at
    FROM service_checks WHERE service = 'openrouter'
  `).get() as Record<string, SQLOutputValue> | undefined;
  if (!row || typeof row.last_error_code !== "string") return false;
  if (typeof row.last_success_at !== "string") return true;
  return typeof row.last_failure_at === "string" && row.last_failure_at > row.last_success_at;
}

function serviceStates(env: Record<string, string | undefined>): AdminServiceState[] {
  return SERVICE_IDS.map((service) => ({
    service,
    purpose: servicePurpose(service),
    configured: serviceConfigured(service, env),
  }));
}

function secretVersions(db: DatabaseSync): AdminSecretVersion[] {
  const rows = db.prepare(`
    SELECT service, environment, version, state, last_four
    FROM admin_secret_status
    ORDER BY created_at DESC
    LIMIT 20
  `).all() as Record<string, SQLOutputValue>[];
  return rows.flatMap((row) => {
    if (typeof row.service !== "string" || typeof row.environment !== "string" || typeof row.state !== "string") return [];
    if (typeof row.version !== "number") return [];
    const lastFour = typeof row.last_four === "string" && row.last_four.length <= 4 ? row.last_four : null;
    return [{ service: row.service, environment: row.environment, version: row.version, state: row.state, lastFour }];
  });
}

function countWhere(db: DatabaseSync, sql: string, params: SQLOutputValue[]): number {
  const row = db.prepare(sql).get(...params) as Record<string, SQLOutputValue> | undefined;
  return numeric(row?.n);
}

function numeric(value: SQLOutputValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}
