import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Phone UX contract (server side): the browser sends ONE phone field that must
 * already carry the international dialing prefix, for example "+966501234567".
 * The server has no trusted default country, so a national-only number such as
 * "0501234567" is rejected instead of being guessed. The client shows the same
 * hint next to the input.
 *
 * This lives in the OTP server scope because libphonenumber-js is already a
 * dependency and the domain helper normalizePhone(country, nationalNumber)
 * expects the country separately — the UI deliberately asks for one field.
 */
export function parseInternationalPhone(input: string): { ok: true; e164: string } | { ok: false } {
  const trimmed = input.trim();
  // "+" plus at most 15 digits can never exceed 17 characters; longer input is
  // rejected before the parser runs so a hostile body cannot burn CPU here.
  if (!trimmed.startsWith("+") || trimmed.length < 8 || trimmed.length > 20) return { ok: false };
  try {
    const parsed = parsePhoneNumberFromString(trimmed);
    if (!parsed?.isValid()) return { ok: false };
    const e164 = parsed.number;
    if (!/^\+[1-9]\d{6,14}$/.test(e164)) return { ok: false };
    return { ok: true, e164 };
  } catch {
    // Unknown region metadata or malformed input must never reach the route as
    // an exception; it is simply an invalid phone number.
    return { ok: false };
  }
}
