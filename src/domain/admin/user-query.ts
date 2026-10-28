// Pure validation for the admin user list. No database access and no SQL here:
// the server layer maps this shape onto allowlisted columns and bound params.

export const USER_SORT_FIELDS = [
  "id", "name", "email", "phone", "city", "age", "registeredAt", "lastActivity",
  "status", "questions", "apiCalls", "tokens", "quotaUsed", "quotaRemaining",
] as const;

export const USER_SEARCH_FIELDS = ["all", "id", "name", "email", "city", "phone"] as const;

export const USER_STATUS_FILTERS = ["active", "temporary", "indefinite", "suspended"] as const;

export type UserSortField = (typeof USER_SORT_FIELDS)[number];
export type UserSearchField = (typeof USER_SEARCH_FIELDS)[number];
export type UserStatusFilter = (typeof USER_STATUS_FILTERS)[number];

export class AdminQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminQueryError";
  }
}

export type UserListQuery = {
  q: string;
  qField: UserSearchField;
  statuses: UserStatusFilter[];
  phoneVerified: "yes" | "no" | null;
  ageMin: number | null;
  ageMax: number | null;
  registeredFrom: string | null;
  registeredTo: string | null;
  activeFrom: string | null;
  activeTo: string | null;
  questionsMin: number | null;
  questionsMax: number | null;
  callsMin: number | null;
  callsMax: number | null;
  tokensMin: number | null;
  tokensMax: number | null;
  quotaUsedMin: number | null;
  quotaUsedMax: number | null;
  quotaRemainingMin: number | null;
  quotaRemainingMax: number | null;
  sort: UserSortField;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
  from: string;
  to: string;
  nowIso: string;
};

const E164 = /^\+[1-9]\d{6,14}$/;
const SEARCH_FIELDS = new Set<string>(USER_SEARCH_FIELDS);
const SORT_FIELDS = new Set<string>(USER_SORT_FIELDS);
const STATUSES = new Set<string>(USER_STATUS_FILTERS);

export function parseUserQuery(
  params: URLSearchParams,
  range: { from: string; to: string },
  nowIso: string,
): UserListQuery {
  const qField = params.get("qField") || "all";
  if (!SEARCH_FIELDS.has(qField)) throw new AdminQueryError("حقل البحث غير مسموح.");
  const sort = params.get("sort") || "registeredAt";
  if (!SORT_FIELDS.has(sort)) throw new AdminQueryError("حقل الترتيب غير مسموح.");
  const dir = parseDirection(params.get("dir"));
  const statuses = parseStatuses(params.get("status"));
  const phoneVerified = parsePhoneVerified(params.get("phoneVerified"));
  return {
    q: (params.get("q") ?? "").trim().slice(0, 200),
    qField: qField as UserSearchField,
    statuses,
    phoneVerified,
    ageMin: optionalInt(params.get("ageMin")),
    ageMax: optionalInt(params.get("ageMax")),
    registeredFrom: optionalDate(params.get("registeredFrom")),
    registeredTo: optionalDate(params.get("registeredTo")),
    activeFrom: optionalDate(params.get("activeFrom")),
    activeTo: optionalDate(params.get("activeTo")),
    questionsMin: optionalInt(params.get("questionsMin")),
    questionsMax: optionalInt(params.get("questionsMax")),
    callsMin: optionalInt(params.get("callsMin")),
    callsMax: optionalInt(params.get("callsMax")),
    tokensMin: optionalInt(params.get("tokensMin")),
    tokensMax: optionalInt(params.get("tokensMax")),
    quotaUsedMin: optionalInt(params.get("quotaUsedMin")),
    quotaUsedMax: optionalInt(params.get("quotaUsedMax")),
    quotaRemainingMin: optionalInt(params.get("quotaRemainingMin")),
    quotaRemainingMax: optionalInt(params.get("quotaRemainingMax")),
    sort: sort as UserSortField,
    dir,
    page: boundedInt(params.get("page"), 1, 1, 100_000),
    pageSize: boundedInt(params.get("pageSize"), 20, 1, 100),
    from: range.from,
    to: range.to,
    nowIso,
  };
}

/** Escapes LIKE wildcards so a typed `%` or `_` is a literal, not a pattern. */
export function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Returns the E.164 form of a typed phone query, or null when it is not E.164. */
export function e164Query(value: string): string | null {
  const compact = value.replace(/[\s()-]/g, "");
  return compact.startsWith("+") && E164.test(compact) ? compact : null;
}

function parseDirection(value: string | null): "asc" | "desc" {
  if (!value) return "desc";
  if (value === "asc" || value === "desc") return value;
  throw new AdminQueryError("اتجاه الترتيب غير مسموح.");
}

function parseStatuses(value: string | null): UserStatusFilter[] {
  const statuses = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  for (const status of statuses) {
    if (!STATUSES.has(status)) throw new AdminQueryError("حالة التصفية غير مسموحة.");
  }
  return statuses as UserStatusFilter[];
}

function parsePhoneVerified(value: string | null): "yes" | "no" | null {
  if (!value) return null;
  if (value !== "yes" && value !== "no") throw new AdminQueryError("تصفية التحقق غير مسموحة.");
  return value;
}

function optionalInt(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  if (!/^-?\d+$/.test(value)) throw new AdminQueryError("المدى الرقمي غير صالح.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AdminQueryError("المدى الرقمي غير صالح.");
  return parsed;
}

function boundedInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value == null || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new AdminQueryError("رقم الصفحة غير صالح.");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new AdminQueryError("رقم الصفحة غير صالح.");
  return parsed;
}

function optionalDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new AdminQueryError("التاريخ غير صالح.");
  return new Date(parsed).toISOString();
}
