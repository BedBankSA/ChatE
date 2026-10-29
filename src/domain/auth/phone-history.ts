/**
 * Phone & activation audit contract (pure domain: no DB, no Node imports).
 *
 * Every mutation of a customer's phone number, and every activation attempt,
 * is appended to the `phone_history` table (migrations/008_phone_audit.sql).
 * These labels are shared by the customer dashboard and the admin audit view so
 * both surfaces describe the same event the same way.
 */

export const PHONE_ACTIONS = [
  "INITIAL_ENTRY",
  "OTP_SENT",
  "OTP_VERIFIED",
  "PHONE_CHANGED_BY_USER",
  "PHONE_CHANGED_BY_ADMIN",
  "FAILED_OTP_ATTEMPT",
] as const;

export type PhoneAction = (typeof PHONE_ACTIONS)[number];

export type PhoneActorType = "user" | "admin" | "system";

export const PHONE_ACTION_LABELS: Record<PhoneAction, string> = {
  INITIAL_ENTRY: "إدخال أولي للرقم",
  OTP_SENT: "إرسال رمز التحقق",
  OTP_VERIFIED: "توثيق رمز التحقق",
  PHONE_CHANGED_BY_USER: "تغيير الرقم بواسطة العميل",
  PHONE_CHANGED_BY_ADMIN: "تغيير الرقم بواسطة المشرف",
  FAILED_OTP_ATTEMPT: "محاولة رمز خاطئة",
};

export const PHONE_ACTOR_LABELS: Record<PhoneActorType, string> = {
  user: "العميل",
  admin: "المشرف",
  system: "النظام",
};

const PHONE_ACTION_SET = new Set<string>(PHONE_ACTIONS);

export function isPhoneAction(value: unknown): value is PhoneAction {
  return typeof value === "string" && PHONE_ACTION_SET.has(value);
}

export function phoneActionLabel(action: string): string {
  return isPhoneAction(action) ? PHONE_ACTION_LABELS[action] : "حركة غير معروفة";
}

export function phoneActorLabel(actor: string): string {
  return actor === "admin" ? PHONE_ACTOR_LABELS.admin : actor === "system" ? PHONE_ACTOR_LABELS.system : PHONE_ACTOR_LABELS.user;
}

/** The only two facts the gate needs: which number, and whether it is verified. */
export type PhoneState = {
  phoneE164: string | null;
  phoneVerifiedAt: string | null;
};

export function isPhoneVerified(state: PhoneState | null | undefined): boolean {
  return Boolean(state?.phoneE164 && state.phoneVerifiedAt);
}

export function phoneStatusLabel(state: PhoneState | null | undefined): string {
  if (!state?.phoneE164) return "لا يوجد رقم";
  return state.phoneVerifiedAt ? "موثّق" : "بانتظار التوثيق";
}

export const VERIFY_PHONE_PATH = "/verify-phone";

/** Safe internal return path. Absolute, protocol-relative and backslash targets are rejected. */
export function safeNextPath(raw: unknown, fallback = "/workspace"): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > 512) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const base = new URL("http://chate.local");
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin) return fallback;
    if (!parsed.pathname.startsWith("/") || parsed.pathname.startsWith("//")) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

/** Link to the verification gate, preserving a safe return path. */
export function verifyPhoneHref(nextPath?: string | null): string {
  if (!nextPath) return VERIFY_PHONE_PATH;
  const safe = safeNextPath(nextPath, "");
  return safe ? `${VERIFY_PHONE_PATH}?next=${encodeURIComponent(safe)}` : VERIFY_PHONE_PATH;
}

const EVENT_TIME_FORMAT = new Intl.DateTimeFormat("ar-SA", {
  timeZone: "Asia/Riyadh",
  calendar: "gregory",
  numberingSystem: "latn",
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatPhoneEventTime(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  try {
    return EVENT_TIME_FORMAT.format(new Date(at));
  } catch {
    return "—";
  }
}
