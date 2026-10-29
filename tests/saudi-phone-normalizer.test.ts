import { describe, expect, it } from "vitest";
import { SAUDI_MOBILE_INVALID_MESSAGE, normalizeSaudiMobile } from "@/domain/auth/saudi-phone";

/** Every accepted spelling below is the same Saudi mobile: 0564106506. */
const EXPECTED = {
  ok: true,
  e164: "+966564106506",
  rawNational: "564106506",
  local: "0564106506",
  international: "966564106506",
};

const ACCEPTED_FORMATS = [
  // national without the trunk zero
  "564106506",
  // national with the trunk zero
  "0564106506",
  // international with plus and 00 dialing prefixes
  "+966564106506",
  "00966564106506",
  // international prefix followed by a redundant trunk zero
  "+9660564106506",
  "009660564106506",
  // international prefix without the plus sign
  "966564106506",
  // punctuation is stripped: spaces, parentheses, dashes
  "+966 (56) 410-6506",
  // Arabic-Indic digits (U+0660-U+0669)
  "٠٥٦٤١٠٦٥٠٦",
  // Persian/Extended Arabic-Indic digits (U+06F0-U+06F9)
  "۰۵۶۴۱۰۶۵۰۶",
  // Arabic-Indic digits in the international form
  "٠٠٩٦٦٥٦٤١٠٦٥٠٦",
  // redundant prefix supplied by the owner: 966 + 05 + national number
  "96650564106506",
];

const ACCEPTED_WITH_WHITESPACE = [" 056 410 6506 ", "\t0564106506\n"];

/**
 * Every row fails with the same opaque Arabic message. "+966 (56) 410-6506 ext 9"
 * is a deliberate rejection: punctuation and letters are stripped, but the
 * trailing digit 9 survives, so the number is 13 digits and can never be the
 * 9-digit national mobile. The tests document the rule instead of guessing.
 */
const REJECTED_FORMATS = [
  "",
  "   ",
  "abc",
  "5",
  "050123456", // 8 digits after the trunk zero
  "05012345678", // 11 national digits
  "+12025550143", // US number
  "+447700900123", // UK number
  "9665012345678", // 966 + 10 digits that do not start with 05
  "9669990505641065", // arbitrary long prefix + a local-looking tail is NOT accepted
  "+966 (56) 410-6506 ext 9",
  "+" + "9".repeat(40),
  "00971501234567", // UAE country code
  "0564106506 1", // stray digit after a valid national number
  "12345678901234567890", // unknown long garbage
  "٥٠١٢٣٤٥٦٧٨٩", // Arabic-Indic digits with the wrong prefix
];

describe("normalizeSaudiMobile accepted formats", () => {
  it.each(ACCEPTED_FORMATS)("normalizes %s to +966564106506", (input) => {
    expect(normalizeSaudiMobile(input)).toEqual(EXPECTED);
  });

  it.each(ACCEPTED_WITH_WHITESPACE)("ignores surrounding whitespace around %j", (input) => {
    expect(normalizeSaudiMobile(input)).toEqual(EXPECTED);
  });
});

describe("normalizeSaudiMobile rejected formats", () => {
  it.each(REJECTED_FORMATS)("rejects %j with the contract message", (input) => {
    expect(normalizeSaudiMobile(input)).toEqual({
      ok: false,
      message: SAUDI_MOBILE_INVALID_MESSAGE,
    });
  });

  it("keeps the exact contract message", () => {
    expect(SAUDI_MOBILE_INVALID_MESSAGE).toBe("رقم الجوال يجب أن يكون رقماً سعودياً صالحاً يبدأ بـ 05");
    expect(normalizeSaudiMobile("050123456")).toEqual({
      ok: false,
      message: "رقم الجوال يجب أن يكون رقماً سعودياً صالحاً يبدأ بـ 05",
    });
  });

  it("does not throw on non-string caller input", () => {
    for (const value of [undefined, null, 966564106506, {}, ["0564106506"]]) {
      expect(normalizeSaudiMobile(value as unknown as string)).toEqual({
        ok: false,
        message: SAUDI_MOBILE_INVALID_MESSAGE,
      });
    }
  });

  it("rejects raw input longer than 64 characters before normalizing", () => {
    const padded = "+966564106506" + " ".repeat(64);
    expect(padded.length).toBeGreaterThan(64);
    expect(normalizeSaudiMobile(padded).ok).toBe(false);
  });
});
