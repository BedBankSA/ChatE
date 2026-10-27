export const USER_SORT_FIELDS = [
  "id", "name", "email", "phone", "city", "age", "registeredAt", "lastActivity",
  "status", "questions", "apiCalls", "tokens", "quotaUsed", "quotaRemaining",
] as const;

export const USER_SEARCH_FIELDS = ["all", "id", "name", "email", "city", "phone"] as const;

export const USER_QUERY_KEYS = [
  "range", "from", "to", "q", "qField", "status", "phone", "ageMin", "ageMax",
  "registeredFrom", "registeredTo", "activeFrom", "activeTo", "questionsMin", "questionsMax",
  "callsMin", "callsMax", "tokensMin", "tokensMax", "quotaUsedMin", "quotaUsedMax",
  "quotaRemainingMin", "quotaRemainingMax", "phoneVerified", "sort", "dir", "page", "pageSize",
] as const;

export type UserSortField = (typeof USER_SORT_FIELDS)[number];
export type UserSearchField = (typeof USER_SEARCH_FIELDS)[number];
export type AccountFilter = "active" | "suspended_temporary" | "suspended_indefinite";

export type UserQuery = {
  q: string;
  qField: UserSearchField;
  statuses: AccountFilter[];
  phone: string | null;
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
  phoneVerified: "any" | "yes" | "no";
  sort: UserSortField;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
};

const E164 = /^\+[1-9]\d{6,14}$/;

export function parseUserQuery(params: URLSearchParams): { ok: true; query: UserQuery } | { ok: false; message: string } {
  for (const key of params.keys()) {
    if (!USER_QUERY_KEYS.includes(key as (typeof USER_QUERY_KEYS)[number])) return { ok: false, message: "حقل التصفية غير مسموح" };
  }
  const sort = params.get("sort") ?? "registeredAt";
  if (!USER_SORT_FIELDS.includes(sort as UserSortField)) return { ok: false, message: "حقل الترتيب غير مسموح" };
  const dir = params.get("dir") ?? "desc";
  if (dir !== "asc" && dir !== "desc") return { ok: false, message: "اتجاه الترتيب غير مسموح" };
  const qField = params.get("qField") ?? "all";
  if (!USER_SEARCH_FIELDS.includes(qField as UserSearchField)) return { ok: false, message: "عمود البحث غير مسموح" };
  const statuses = parseStatuses(params.get("status"));
  if (!statuses.ok) return statuses;
  const phoneVerified = params.get("phoneVerified") ?? "any";
  if (phoneVerified !== "any" && phoneVerified !== "yes" && phoneVerified !== "no") return { ok: false, message: "تصفية التحقق غير مسموحة" };
  const page = parsePage(params.get("page"), 1, 1, 10_000);
  const pageSize = parsePage(params.get("pageSize"), 20, 1, 100);
  if (!page.ok) return page;
  if (!pageSize.ok) return pageSize;
  const numbers = {
    ageMin: optionalInt(params.get("ageMin")),
    ageMax: optionalInt(params.get("ageMax")),
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
  };
  for (const value of Object.values(numbers)) {
    if (!value.ok) return value;
  }
  const dates = {
    registeredFrom: optionalDate(params.get("registeredFrom")),
    registeredTo: optionalDate(params.get("registeredTo")),
    activeFrom: optionalDate(params.get("activeFrom")),
    activeTo: optionalDate(params.get("activeTo")),
  };
  for (const value of Object.values(dates)) {
    if (!value.ok) return value;
  }
  const phone = optionalPhone(params.get("phone"));
  if (!phone.ok) return phone;
  return {
    ok: true,
    query: {
      q: (params.get("q") ?? "").trim().slice(0, 200),
      qField: qField as UserSearchField,
      statuses: statuses.value,
      phone: phone.value,
      ageMin: numbers.ageMin.value,
      ageMax: numbers.ageMax.value,
      registeredFrom: dates.registeredFrom.value,
      registeredTo: dates.registeredTo.value,
      activeFrom: dates.activeFrom.value,
      activeTo: dates.activeTo.value,
      questionsMin: numbers.questionsMin.value,
      questionsMax: numbers.questionsMax.value,
      callsMin: numbers.callsMin.value,
      callsMax: numbers.callsMax.value,
      tokensMin: numbers.tokensMin.value,
      tokensMax: numbers.tokensMax.value,
      quotaUsedMin: numbers.quotaUsedMin.value,
      quotaUsedMax: numbers.quotaUsedMax.value,
      quotaRemainingMin: numbers.quotaRemainingMin.value,
      quotaRemainingMax: numbers.quotaRemainingMax.value,
      phoneVerified,
      sort: sort as UserSortField,
      dir,
      page: page.value,
      pageSize: pageSize.value,
    },
  };
}

export function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function e164Query(value: string): string | null {
  const compact = value.replace(/[\s-]/g, "");
  return E164.test(compact) ? compact : null;
}

function parseStatuses(value: string | null): { ok: true; value: AccountFilter[] } | { ok: false; message: string } {
  if (!value) return { ok: true, value: [] };
  const allowed: AccountFilter[] = ["active", "suspended_temporary", "suspended_indefinite"];
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.some((item) => !allowed.includes(item as AccountFilter))) return { ok: false, message: "حالة الحساب غير مسموحة" };
  return { ok: true, value: items as AccountFilter[] };
}

function parsePage(value: string | null, fallback: number, min: number, max: number): { ok: true; value: number } | { ok: false; message: string } {
  if (!value) return { ok: true, value: fallback };
  if (!/^\d+$/.test(value)) return { ok: false, message: "رقم الصفحة غير صالح" };
  const parsed = Number(value);
  if (parsed < min || parsed > max) return { ok: false, message: "رقم الصفحة خارج المدى" };
  return { ok: true, value: parsed };
}

function optionalInt(value: string | null): { ok: true; value: number | null } | { ok: false; message: string } {
  if (!value) return { ok: true, value: null };
  if (!/^-?\d+$/.test(value)) return { ok: false, message: "المرشح الرقمي غير صالح" };
  return { ok: true, value: Number(value) };
}

function optionalDate(value: string | null): { ok: true; value: string | null } | { ok: false; message: string } {
  if (!value) return { ok: true, value: null };
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return { ok: false, message: "التاريخ غير صالح" };
  return { ok: true, value: new Date(parsed).toISOString() };
}

function optionalPhone(value: string | null): { ok: true; value: string | null } | { ok: false; message: string } {
  if (!value) return { ok: true, value: null };
  const phone = e164Query(value);
  if (!phone) return { ok: false, message: "بحث الجوال يكون على E.164" };
  return { ok: true, value: phone };
}
