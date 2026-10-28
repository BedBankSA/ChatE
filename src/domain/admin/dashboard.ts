import { externalAlertResult } from "@/domain/admin/alerts";
import { otpProviderConfigured } from "@/domain/auth/model-gate";
import { PRESENCE_NOTE } from "@/domain/admin/presence";
import { removeSecretValues, stripPrivateKeys } from "@/domain/admin/privacy";
import { SERVICE_IDS, type ServiceId } from "@/domain/admin/services";
import { MANAGER_TIME_ZONE, formatInstant } from "@/domain/admin/measure";

export const PROVIDER_UNAVAILABLE = "لا قراءة حية من المزود في هذه الصفحة.";
export const SECRETS_EMPTY = "لا نسخ أسرار مخزنة. التعديل غير موصول، ولا يُعرض المفتاح.";
export const SECRETS_PARTIAL = "يظهر آخر أربعة أحرف فقط. النص الكامل غير معروض، والتعديل غير موصول.";

const SECRET_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "SESSION_SECRET",
  "TURNSTILE_SECRET_KEY",
  "OTP_HTTP_AUTHORIZATION",
  "OTP_PEPPER",
  "SMS_API_KEY",
  "SMS_API_SECRET",
] as const;

const NOTICES: Record<string, string> = {
  saved: "تم حفظ الإجراء.",
  rejected: "تعذر تنفيذ الإجراء.",
};

export type AdminMetric = {
  id: string;
  label: string;
  value: number | null;
  previous: number | null;
  source: "local" | "unavailable";
  detail: string;
};

export type AdminUserView = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  phoneVerified: boolean;
  city: string | null;
  status: string;
  questionsInRange: number;
  apiCalls: number;
  tokens: number | null;
  quotaLimit: number | null;
  quotaRemaining: number | null;
};

export type AdminAuditItem = {
  id: string;
  actorId: string;
  action: string;
  target: string;
  at: string;
};

export type AdminSecretVersion = {
  service: string;
  environment: string;
  version: number;
  state: string;
  lastFour: string | null;
};

export type AdminServiceState = {
  service: string;
  purpose: string;
  configured: boolean;
};

export type AdminDashboardData = {
  email: string;
  actorId: string;
  rangeKey: "today" | "7d" | "30d" | "custom";
  query: string;
  metrics: AdminMetric[];
  users: AdminUserView[];
  userTotal: number;
  page: number;
  pageSize: number;
  audit: AdminAuditItem[];
  alerts: { kind: string; message: string }[];
  externalAlertReason: string;
  providerReason: string;
  secretsNote: string;
  secretVersions: AdminSecretVersion[];
  services: AdminServiceState[];
  presenceNote: string;
  notice: string | null;
  loadError: string | null;
};

export function serviceConfigured(service: ServiceId, env: Record<string, string | undefined>): boolean {
  if (service === "openrouter") return Boolean(env.OPENROUTER_API_KEY?.trim());
  if (service === "turnstile") return Boolean(env.TURNSTILE_SECRET_KEY?.trim());
  if (service === "google") return Boolean(env.GOOGLE_CLIENT_ID?.trim());
  // One predicate for the page, the model gate and the OTP route: a workable
  // SMS_PROVIDER (or legacy OTP_PROVIDER=http) means OTP can deliver a code.
  if (service === "otp") return otpProviderConfigured(env);
  return SERVICE_IDS.includes(service);
}

export function secretValues(env: Record<string, string | undefined>): string[] {
  return SECRET_ENV.map((key) => env[key]?.trim() ?? "").filter((value) => value.length >= 8);
}

export function publishAdminOverview(data: AdminDashboardData, secrets: string[]): AdminDashboardData {
  const stripped = stripPrivateKeys(data);
  return JSON.parse(removeSecretValues(JSON.stringify(stripped), secrets)) as AdminDashboardData;
}

export function noticeText(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  return NOTICES[raw] ?? null;
}

export function toSearchParams(query: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === "notice" || key === "email") continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") params.set(key, first);
  }
  return params;
}

export function adminHref(input: { rangeKey: string; query: string; page?: number }): string {
  const params = new URLSearchParams();
  params.set("range", input.rangeKey);
  if (input.query) params.set("q", input.query);
  if (input.page && input.page > 1) params.set("page", String(input.page));
  return `/admin?${params.toString()}`;
}

export function metricText(metric: AdminMetric): string {
  if (metric.source === "unavailable" || metric.value == null) return "غير متاح";
  return new Intl.NumberFormat("ar", { numberingSystem: "latn", maximumFractionDigits: 2 }).format(metric.value);
}

export function countText(value: number | null): string {
  if (value == null) return "غير متاح";
  return new Intl.NumberFormat("ar", { numberingSystem: "latn", maximumFractionDigits: 0 }).format(value);
}

export function accountStatusLabel(status: string): string {
  if (status === "temporary") return "موقوف مؤقتًا";
  if (status === "indefinite") return "موقوف";
  if (status === "active") return "نشط";
  return "غير معروف";
}

export function auditActionLabel(action: string): string {
  if (action === "suspend") return "إيقاف";
  if (action === "restore") return "تفعيل";
  if (action === "quota") return "تعديل الحصة";
  if (action === "view") return "عرض";
  return "إجراء";
}

export function formatWhen(iso: string): string {
  if (Number.isNaN(Date.parse(iso))) return "—";
  return formatInstant(iso, MANAGER_TIME_ZONE);
}

export function emptyDashboard(input: {
  email: string;
  actorId: string;
  notice: string | null;
  loadError: string;
}): AdminDashboardData {
  return {
    email: input.email,
    actorId: input.actorId,
    rangeKey: "7d",
    query: "",
    metrics: [{ id: "questions", label: "الأسئلة", value: null, previous: null, source: "unavailable", detail: "تعذر القراءة" }],
    users: [],
    userTotal: 0,
    page: 1,
    pageSize: 20,
    audit: [],
    alerts: [],
    externalAlertReason: externalAlertResult().reason,
    providerReason: PROVIDER_UNAVAILABLE,
    secretsNote: SECRETS_EMPTY,
    secretVersions: [],
    services: [],
    presenceNote: PRESENCE_NOTE,
    notice: input.notice,
    loadError: input.loadError,
  };
}
