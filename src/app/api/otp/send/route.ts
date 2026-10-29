import { randomInt } from "node:crypto";
import { issueChallenge, OTP_MAX_SENDS, OTP_TTL_MS, OTP_WINDOW_MS } from "@/domain/auth/otp";
import { normalizeSaudiMobile } from "@/domain/auth/saudi-phone";
import { publicError } from "@/domain/errors";
import { readStoredProfile } from "@/server/db/profiles";
import { getDatabase } from "@/server/db/runtime";
import { runtimeEnv } from "@/server/db/settings";
import { gateTurnstile, readJson } from "@/server/guard";
import { readComparisonSession } from "@/server/google-session";
import { jsonError, jsonOk } from "@/server/http";
import { otpPepper } from "@/server/otp/config";
import { countRecentSends, hasVerifiedPhone, insertChallenge, latestAnyChallenge } from "@/server/otp/service";
import { createSmsSender } from "@/server/sms/adapter";

const ANONYMOUS_MESSAGE = "يلزم تسجيل الدخول قبل إرسال رمز التحقق";
const RESEND_MESSAGE = "تجاوزت حد إعادة إرسال الرمز. حاول بعد ١٥ دقيقة.";
const STORE_MESSAGE = "تعذر حفظ رمز التحقق.";
const PROVIDER_MESSAGE = "تعذر إرسال رمز التحقق. أعد المحاولة لاحقًا.";

export async function POST(request: Request) {
  const body = await readJson(request);
  const session = await readComparisonSession(request);
  if (!session) return jsonError(ANONYMOUS_MESSAGE, "anonymous", 401);
  let db;
  try {
    db = getDatabase();
  } catch {
    return jsonError("تعذر فتح قاعدة التحقق.", "store", 500);
  }
  let profile;
  try {
    profile = readStoredProfile(db, session.userId);
  } catch {
    return jsonError("تعذر قراءة الحساب.", "store", 500);
  }
  if (!profile) return jsonError("أعد تسجيل الدخول لحفظ الحساب قبل توثيق الجوال.", "account_missing", 401);
  // Verified users need no new SMS and no Turnstile token.
  if (profile.phoneVerifiedAt || hasVerifiedPhone(db, session.userId)) {
    return jsonOk({ sent: false, verified: true });
  }
  const blocked = await gateTurnstile(request, body, "otp");
  if (blocked) return blocked;
  // One free-form phone field: the normalizer accepts national/international
  // spellings and returns the stored E.164, or its own Arabic rejection message.
  const phone = normalizeSaudiMobile(typeof body.phone === "string" ? body.phone : "");
  if (!phone.ok) return jsonError(phone.message, "OTP_PHONE", 422);
  const now = Date.now();
  let recentSends;
  try {
    recentSends = countRecentSends(db, session.userId, now - OTP_WINDOW_MS);
  } catch {
    return jsonError(STORE_MESSAGE, "store", 500);
  }
  if (recentSends >= OTP_MAX_SENDS) return jsonError(RESEND_MESSAGE, "OTP_RESEND", 429);
  // The code only ever leaves this process through the SMS provider.
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  let provider;
  let pepper: string;
  try {
    // The adapter resolves SMS_PROVIDER (new) or OTP_PROVIDER (legacy) and fails
    // closed with the same 503 OTP_FAIL_CLOSED when no gateway is configured.
    const runtime = runtimeEnv();
    provider = createSmsSender(runtime);
    pepper = otpPepper(runtime);
  } catch (error) {
    const pub = publicError(error);
    return jsonError(pub.message, pub.code, pub.status);
  }
  let challenge;
  try {
    challenge = issueChallenge(code, pepper, now, latestAnyChallenge(db, session.userId)?.challenge ?? null);
  } catch (error) {
    const pub = publicError(error);
    return jsonError(pub.message, pub.code, pub.status);
  }
  try {
    insertChallenge(db, { userId: session.userId, phoneE164: phone.e164, challenge, now });
  } catch {
    return jsonError(STORE_MESSAGE, "store", 500);
  }
  try {
    // The adapter owns the carrier wire format (e.g. 9665... without "+").
    await provider.send({ to: phone.e164, code });
  } catch {
    // Never surface a provider body or error text to the browser.
    return jsonError(PROVIDER_MESSAGE, "OTP_PROVIDER", 502);
  }
  return jsonOk({ sent: true, expiresInSeconds: OTP_TTL_MS / 1000 });
}
