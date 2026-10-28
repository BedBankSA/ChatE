import { AppError } from "@/domain/errors";

/**
 * Pepper for the OTP challenge hash. A dedicated OTP_PEPPER wins; otherwise the
 * existing session secret is used so an already-configured deployment can
 * verify phones without a new variable. With neither configured the flow fails
 * closed instead of hashing codes with an empty pepper.
 */
export function otpPepper(env: Record<string, string | undefined> = process.env): string {
  const dedicated = env.OTP_PEPPER?.trim();
  if (dedicated) return dedicated;
  const fallback = env.SESSION_SECRET?.trim();
  if (fallback) return fallback;
  throw new AppError("التحقق بالرسائل غير مهيأ على الخادم.", "OTP_FAIL_CLOSED", 503);
}
