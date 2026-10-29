/**
 * Saudi mobile normalization contract (pure domain helper, no Node-only imports):
 * the browser sends ONE free-form phone field and the server always stores E.164
 * (+9665XXXXXXXX). Customers may type the national form (0564106506 / 564106506),
 * the international form (+9665..., 00966..., 966...), a redundant international
 * prefix (e.g. 96650564106506) or Arabic-Indic digits; spaces, dashes, parentheses,
 * dots, letters and a leading "+" are stripped before the candidate is validated.
 */

export const SAUDI_MOBILE_INVALID_MESSAGE = "رقم الجوال يجب أن يكون رقماً سعودياً صالحاً يبدأ بـ 05";

export type NormalizedSaudiMobile =
  | { ok: true; e164: string; rawNational: string; local: string; international: string }
  | { ok: false; message: string };

/** Stored national number: 9 digits starting with 5 (the trunk zero is dropped). */
const NATIONAL_MOBILE = /^5[0-9]{8}$/;
/** Local dialing form customers type: 05 followed by the same 8 digits. */
const LOCAL_MOBILE = /^05[0-9]{8}$/;

/** A real phone body is far shorter; anything above this is rejected before parsing. */
const MAX_INPUT_LENGTH = 64;

const SAUDI_COUNTRY_CODE = "966";

/**
 * Longest prefix first: "009660"/"9660" already carry the trunk zero, so they
 * must win over "00966"/"966" for the same digit string.
 */
const INTERNATIONAL_PREFIXES = ["009660", "00966", "9660", "966"];
/** Prefixes whose leftover digits may still hide a redundant local mobile form. */
const REDUNDANT_PREFIXES = new Set(["00966", "966"]);
const LOCAL_PREFIX = "05";

/** Arabic-Indic digits U+0660-U+0669 and Persian/Extended digits U+06F0-U+06F9. */
const ARABIC_INDIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

function invalid(): NormalizedSaudiMobile {
  // One opaque message for every rejection: the caller never has to explain a format.
  return { ok: false, message: SAUDI_MOBILE_INVALID_MESSAGE };
}

function valid(national: string): NormalizedSaudiMobile {
  return {
    ok: true,
    e164: "+" + SAUDI_COUNTRY_CODE + national,
    rawNational: national,
    local: "0" + national,
    international: SAUDI_COUNTRY_CODE + national,
  };
}

/** Converts Arabic-Indic and Persian digits to ASCII so one digit regex handles both. */
function toAsciiDigits(input: string): string {
  return input.replace(ARABIC_INDIC_DIGITS, (digit) => {
    const code = digit.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String.fromCharCode(0x30 + (code - base));
  });
}

export function normalizeSaudiMobile(input: string): NormalizedSaudiMobile {
  // The route passes untrusted JSON: non-string, empty and oversized values fail
  // closed here instead of throwing inside the request handler.
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_INPUT_LENGTH) return invalid();

  // Letters, punctuation, spaces and the leading "+" are noise; only digits remain.
  const digits = toAsciiDigits(input).replace(/\D/g, "");
  if (!digits) return invalid();

  for (const prefix of INTERNATIONAL_PREFIXES) {
    if (!digits.startsWith(prefix)) continue;
    const candidate = digits.slice(prefix.length);
    if (NATIONAL_MOBILE.test(candidate)) return valid(candidate);
    // Lenient redundant-prefix fallback (owner-supplied "96650564106506"): the
    // leftover must end with a complete local mobile, and its last 9 digits are
    // the national number. Anything else stays rejected.
    if (
      REDUNDANT_PREFIXES.has(prefix) &&
      candidate.length >= 10 &&
      candidate.length <= 11 &&
      LOCAL_MOBILE.test(candidate.slice(-10))
    ) {
      return valid(candidate.slice(-9));
    }
  }

  if (digits.startsWith(LOCAL_PREFIX)) {
    // National dialing form: strip the leading trunk zero only ("05" + 8 digits
    // becomes the 9-digit national number "5" + 8 digits).
    const candidate = digits.slice(1);
    if (NATIONAL_MOBILE.test(candidate)) return valid(candidate);
  }

  // National number typed without a prefix (the "+966" is added by the store).
  if (NATIONAL_MOBILE.test(digits)) return valid(digits);
  return invalid();
}
