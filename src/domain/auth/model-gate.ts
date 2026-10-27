import { profileGate, type Profile } from "@/domain/auth/profile";

export const PHONE_VERIFICATION_MESSAGE =
  "استخدام النماذج ينتظر توثيق الجوال. التحقق بالرسائل ينتظر إعداد مزود الإرسال، ولم يُوثَّق الرقم.";

export const PHONE_UNVERIFIED_MESSAGE = "استخدام النماذج ينتظر توثيق الجوال. أكمل التحقق قبل الإرسال.";

export function otpProviderConfigured(env: NodeJS.ProcessEnv): boolean {
  return env.OTP_PROVIDER === "http" && Boolean(env.OTP_HTTP_URL?.trim());
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
