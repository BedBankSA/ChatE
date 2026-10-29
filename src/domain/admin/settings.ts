/**
 * Pure policy for runtime-editable provider credentials. No imports, no DB,
 * no secrets: the admin UI only ever receives masked hints. Server modules
 * resolve the actual values through src/server/db/settings.ts.
 */

export const SETTING_KEYS = [
  "ANTHROPIC_API_KEY",
  "HAIKU_LIVE_CALLS",
  "OPENROUTER_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "TURNSTILE_EXPECTED_HOSTNAMES",
  "SMS_API_KEY",
  "SMS_API_SECRET",
  "SMS_SENDER_ID",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export type SettingGroup = "anthropic" | "openrouter" | "google" | "turnstile" | "sms";

export type SettingMeta = {
  key: SettingKey;
  group: SettingGroup;
  label: string;
  hint: string;
  minLength: number;
  maxLength: number;
  pattern: RegExp | null;
};

export const SETTING_META: Record<SettingKey, SettingMeta> = {
  ANTHROPIC_API_KEY: {
    key: "ANTHROPIC_API_KEY",
    group: "anthropic",
    label: "مفتاح Anthropic",
    hint: "يبدأ عادةً بـ sk-ant- ويُستخدم لاستدعاء Claude Haiku مباشرة.",
    minLength: 20,
    maxLength: 512,
    pattern: /^\S+$/,
  },
  HAIKU_LIVE_CALLS: {
    key: "HAIKU_LIVE_CALLS",
    group: "anthropic",
    label: "تفعيل استدعاء Haiku الحي",
    hint: "1 = مفعّل، 0 = متوقف. يتطلب مفتاح Anthropic؛ حفظ مفتاح جديد يفعّله تلقائيًا.",
    minLength: 1,
    maxLength: 1,
    pattern: /^[01]$/,
  },
  OPENROUTER_API_KEY: {
    key: "OPENROUTER_API_KEY",
    group: "openrouter",
    label: "مفتاح OpenRouter",
    hint: "مفتاح المزود المجاني لبقية نماذج المقارنة.",
    minLength: 20,
    maxLength: 512,
    pattern: /^\S+$/,
  },
  GOOGLE_CLIENT_ID: {
    key: "GOOGLE_CLIENT_ID",
    group: "google",
    label: "معرّف عميل Google",
    hint: "مثال: 1234567890-abcdef.apps.googleusercontent.com — يُسلَّم للمتصفح من الخادم في كل صفحة.",
    minLength: 10,
    maxLength: 200,
    pattern: /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/,
  },
  GOOGLE_CLIENT_SECRET: {
    key: "GOOGLE_CLIENT_SECRET",
    group: "google",
    label: "سر عميل Google",
    hint: "سر OAuth (GOCSPX-...). يبقى على الخادم ولا يُرسل للمتصفح.",
    minLength: 10,
    maxLength: 200,
    pattern: /^[A-Za-z0-9_-]+$/,
  },
  TURNSTILE_SITE_KEY: {
    key: "TURNSTILE_SITE_KEY",
    group: "turnstile",
    label: "مفتاح موقع Turnstile",
    hint: "المفتاح العام (0x...) الذي يُسلَّم للمتصفح من الخادم.",
    minLength: 10,
    maxLength: 100,
    pattern: /^0x[A-Za-z0-9_-]+$/,
  },
  TURNSTILE_SECRET_KEY: {
    key: "TURNSTILE_SECRET_KEY",
    group: "turnstile",
    label: "سر Turnstile",
    hint: "المفتاح السري للتحقق من الرموز على الخادم.",
    minLength: 10,
    maxLength: 200,
    pattern: /^0x[A-Za-z0-9_-]+$/,
  },
  TURNSTILE_EXPECTED_HOSTNAMES: {
    key: "TURNSTILE_EXPECTED_HOSTNAMES",
    group: "turnstile",
    label: "النطاقات المسموحة",
    hint: "قائمة نطاقات مفصولة بفواصل، مثل chate.bedbank.sa,localhost",
    minLength: 1,
    maxLength: 500,
    pattern: /^[a-z0-9.*:\-]+(,[a-z0-9.*:\-]+)*$/i,
  },
  SMS_API_KEY: {
    key: "SMS_API_KEY",
    group: "sms",
    label: "مفتاح مزود الرسائل",
    hint: "4jawaly: اسم المستخدم/المفتاح. taqnyat/unifonic: الرمز.",
    minLength: 4,
    maxLength: 512,
    pattern: /^\S+$/,
  },
  SMS_API_SECRET: {
    key: "SMS_API_SECRET",
    group: "sms",
    label: "سر مزود الرسائل",
    hint: "كلمة سر 4jawaly (اختياري لبقية المزودين).",
    minLength: 4,
    maxLength: 1024,
    pattern: /^\S+$/,
  },
  SMS_SENDER_ID: {
    key: "SMS_SENDER_ID",
    group: "sms",
    label: "اسم المرسل",
    hint: "الاسم المعتمد لدى المزود، مثل BedBank.",
    minLength: 1,
    maxLength: 32,
    pattern: /^[\p{L}\p{N} ._+\-]+$/u,
  },
};

export const SETTING_GROUPS: ReadonlyArray<{ id: SettingGroup; label: string; note: string }> = [
  { id: "anthropic", label: "Anthropic", note: "Claude Haiku 5.5 — مدفوع، مباشر." },
  { id: "openrouter", label: "OpenRouter", note: "النماذج المجانية الأربعة." },
  { id: "google", label: "Google", note: "دخول Google OAuth: معرّف العميل وسره." },
  { id: "turnstile", label: "Turnstile", note: "حماية النماذج من الطلبات الآلية." },
  { id: "sms", label: "الرسائل (4jawaly / SMS)", note: "توثيق الجوال برمز OTP." },
];

export type SettingValidation = { ok: true; value: string } | { ok: false; message: string };

/**
 * Empty input means "clear the database override" and falls back to the
 * environment. Control characters are rejected so a value can never inject
 * headers, newlines or log lines.
 */
export function validateSettingValue(key: SettingKey, raw: unknown): SettingValidation {
  const meta = SETTING_META[key];
  if (!meta) return { ok: false, message: "مفتاح إعداد غير معروف." };
  if (typeof raw !== "string") return { ok: false, message: "قيمة غير صالحة." };
  const value = raw.trim();
  if (!value) return { ok: true, value: "" };
  if (value.length < meta.minLength) return { ok: false, message: `القيمة أقصر من الحد الأدنى (${meta.minLength} حرفًا).` };
  if (value.length > meta.maxLength) return { ok: false, message: "القيمة أطول من الحد المسموح." };
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, message: "القيمة تحتوي محارف غير مسموحة." };
  if (meta.pattern && !meta.pattern.test(value)) return { ok: false, message: "صيغة القيمة غير صالحة." };
  return { ok: true, value };
}

/** Masks a secret for display: short prefix, bullets, and the last four characters. */
export function maskSecret(value: string): string {
  const text = value.trim();
  if (!text) return "";
  if (text.length <= 8) return "••••••••";
  const prefixLength = text.startsWith("sk-ant-") ? 7 : text.startsWith("sk-or-") ? 6 : text.startsWith("sk-") ? 3 : 2;
  const prefix = text.slice(0, Math.min(prefixLength, text.length - 4));
  return `${prefix}••••••••••••${text.slice(-4)}`;
}

export function lastFour(value: string): string | null {
  const text = value.trim();
  return text.length >= 4 ? text.slice(-4) : null;
}

export type SettingSource = "db" | "env" | "none";

export type SettingView = {
  key: SettingKey;
  label: string;
  group: SettingGroup;
  hint: string;
  configured: boolean;
  source: SettingSource;
  masked: string | null;
  lastFour: string | null;
  updatedAt: string | null;
};

export type AdminSettingsData = {
  email: string;
  groups: typeof SETTING_GROUPS;
  settings: SettingView[];
  notice: string | null;
  testResult: { ok: boolean; label: string; reason: string | null } | null;
};

export const SETTINGS_NOTICES: Record<string, string> = {
  saved: "تم حفظ الإعداد وتطبيقه فورًا في وقت التشغيل.",
  cleared: "أُزيل تجاوز قاعدة البيانات، وعادت القيمة إلى متغيرات البيئة.",
  rejected: "تعذر حفظ الإعداد. تحقق من الصيغة ثم أعد المحاولة.",
  "test-ok": "نجح اختبار الاتصال بالمزود.",
  "test-fail": "فشل اختبار الاتصال. راجع القيمة أو اتصال الخادم ثم أعد المحاولة.",
};

/** Safe, allowlisted live checks the admin settings UI can run. */
export const TESTABLE_SETTING_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "SMS_API_KEY",
  "SMS_API_SECRET",
  "SMS_SENDER_ID",
  "HAIKU_LIVE_CALLS",
]);

export type SettingTestResult = { ok: boolean; message: string };

export function settingsNotice(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw ? SETTINGS_NOTICES[raw] ?? null : null;
}

// ---------- DB-backed admin roles ----------
export const USER_ROLES = ["user", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: unknown): value is UserRole {
  return value === "user" || value === "admin";
}

export function roleLabel(role: UserRole): string {
  return role === "admin" ? "مشرف" : "مستخدم";
}

export const ROLE_LABELS: Record<string, string> = { admin: "مشرف", user: "مستخدم" };
