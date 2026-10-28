import { profileGate, type Profile } from "@/domain/auth/profile";

export const PHONE_VERIFICATION_MESSAGE =
  "استخدام النماذج ينتظر توثيق الجوال. التحقق بالرسائل ينتظر إعداد مزود الإرسال، ولم يُوثَّق الرقم.";

export const PHONE_UNVERIFIED_MESSAGE = "استخدام النماذج ينتظر توثيق الجوال. أكمل التحقق قبل الإرسال.";

function hasText(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

/**
 * True when the deployment can actually deliver an OTP SMS. Kept in the pure
 * domain layer (no imports from src/server/**) because the profile page and the
 * model gate both read it; the send route still fails closed independently.
 *
 * Legacy precedence mirrors the adapter: a non-empty OTP_PROVIDER wins over
 * SMS_PROVIDER. The historical gate only counted OTP_PROVIDER=http plus a URL,
 * so that shape is preserved here (the legacy fake stub is not a real gateway).
 */
export function otpProviderConfigured(env: Record<string, string | undefined>): boolean {
  const legacyProvider = env.OTP_PROVIDER?.trim().toLowerCase();
  if (legacyProvider) return legacyProvider === "http" && hasText(env.OTP_HTTP_URL);

  // Blank/unset NODE_ENV fails closed as production, mirroring the adapter:
  // the dev mock must never be assumed usable in an unlabelled deployment.
  const nodeEnv = env.NODE_ENV?.trim() || "production";
  const provider = env.SMS_PROVIDER?.trim().toLowerCase();
  switch (provider) {
    case "4jawaly":
      // 4jawaly uses HTTP Basic auth, so both halves of the credential and the
      // approved sender id are required before the gate opens.
      return hasText(env.SMS_API_KEY) && hasText(env.SMS_API_SECRET) && hasText(env.SMS_SENDER_ID);
    case "taqnyat":
    case "unifonic":
      return hasText(env.SMS_API_KEY) && hasText(env.SMS_SENDER_ID);
    case "generic":
      // A generic gateway may be pointed at SMS_ENDPOINT or, for backwards
      // compatibility, the legacy OTP_HTTP_URL.
      return hasText(env.SMS_ENDPOINT) || hasText(env.OTP_HTTP_URL);
    case "mock":
      // The dev mock never sends a real SMS and is refused in production.
      return nodeEnv !== "production";
    default:
      return false;
  }
}

export function modelUseBlock(
  profile: Profile,
  otpConfigured: boolean,
): { message: string; code: string; status: number } | null {
  const gate = profileGate(profile);
  if (!gate.locked) return null;
  if (gate.reason === "suspended") return { message: "الحساب موقوف.", code: "suspended", status: 403 };
  if (gate.reason === "phone") {
    if (!otpConfigured) return { message: PHONE_VERIFICATION_MESSAGE, code: "OTP_UNCONFIGURED", status: 503 };
    return { message: PHONE_UNVERIFIED_MESSAGE, code: "profile_incomplete", status: 403 };
  }
  return { message: "يلزم إكمال الملف قبل استخدام النماذج.", code: "profile_incomplete", status: 403 };
}
