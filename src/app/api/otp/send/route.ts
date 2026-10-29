import { randomInt } from "node:crypto";
import {
  issueChallenge,
  OTP_MAX_SENDS,
  OTP_MAX_SENDS_PER_PHONE,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MS,
  OTP_WINDOW_MS,
} from "@/domain/auth/otp";
import { normalizeSaudiMobile } from "@/domain/auth/saudi-phone";
import { publicError } from "@/domain/errors";
import { readStoredProfile } from "@/server/db/profiles";
import { getDatabase } from "@/server/db/runtime";
import { runtimeEnv } from "@/server/db/settings";
import { immediateTransaction } from "@/server/db/transaction";
import { consumeRateLimit, gateTurnstile, readJson } from "@/server/guard";
import { readComparisonSession } from "@/server/google-session";
import { jsonError, jsonOk } from "@/server/http";
import { otpPepper } from "@/server/otp/config";
import {
  countRecentSends,
  countRecentSendsToPhone,
  hasVerifiedPhone,
  insertChallenge,
  latestAnyChallenge,
} from "@/server/otp/service";
import { countPhoneHistoryRows, findVerifiedPhoneOwner, recordPhoneAudit } from "@/server/phone/audit";
import { readClientMeta } from "@/server/phone/request";
import { createSmsSender } from "@/server/sms/adapter";

const ANONYMOUS_MESSAGE = "يلزم تسجيل الدخول قبل إرسال رمز التحقق";
const RESEND_MESSAGE = "تجاوزت حد إعادة إرسال الرمز. حاول بعد انتهاء المدة المحددة.";
const STORE_MESSAGE = "تعذر حفظ رمز التحقق.";
const PROVIDER_MESSAGE = "تعذر إرسال رمز التحقق. أعد المحاولة لاحقًا.";
/** One phone belongs to one verified account; the customer must pick another number. */
const PHONE_TAKEN_MESSAGE = "هذا الرقم مرتبط بحساب آخر موثّق. استخدم رقمًا مختلفًا أو تواصل مع الدعم.";

/**
 * POST /api/otp/send — one endpoint for both phone flows:
 *
 *  - initial verification (unverified customer): sends a code to the typed
 *    number and logs INITIAL_ENTRY (first number ever) + OTP_SENT.
 *  - phone change (already verified customer): a *different* number is allowed
 *    and goes through the same Turnstile, ownership and rate-limit checks; the
 *    verified phone is only replaced after /api/otp/verify succeeds.
 *
 * The old contract is preserved for backward compatibility: a verified customer
 * sending no phone gets { sent: false, verified: true } without an SMS call.
 */
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
  let alreadyVerified = Boolean(profile.phoneVerifiedAt);
  if (!alreadyVerified) {
    try {
      alreadyVerified = hasVerifiedPhone(db, session.userId);
    } catch {
      return jsonError(STORE_MESSAGE, "store", 500);
    }
  }
  const requestedRaw = typeof body.phone === "string" ? body.phone : "";
  // Backward-compatible no-op: a verified customer with no new phone to send to.
  if (alreadyVerified && requestedRaw.trim() === "") return jsonOk({ sent: false, verified: true });
  // Verified customers cannot open the SMS path before Turnstile either.
  const blocked = await gateTurnstile(request, body, "otp");
  if (blocked) return blocked;
  // One free-form phone field: national/international spellings all normalize to E.164.
  const phone = normalizeSaudiMobile(requestedRaw);
  if (!phone.ok) return jsonError(phone.message, "OTP_PHONE", 422);
  // Same number already verified: nothing to send, nothing to charge.
  if (alreadyVerified && profile.phoneE164 === phone.e164) return jsonOk({ sent: false, verified: true });
  const changeMode = alreadyVerified;
  const client = readClientMeta(request);
  const now = Date.now();
  let recentSends: number;
  let recentPhoneSends: number;
  let latest;
  try {
    recentSends = countRecentSends(db, session.userId, now - OTP_WINDOW_MS);
    recentPhoneSends = countRecentSendsToPhone(db, phone.e164, now - OTP_WINDOW_MS);
    latest = latestAnyChallenge(db, session.userId);
  } catch {
    return jsonError(STORE_MESSAGE, "store", 500);
  }
  if (recentSends >= OTP_MAX_SENDS || recentPhoneSends >= OTP_MAX_SENDS_PER_PHONE) {
    const windowStarted = latest?.challenge.windowStartedAt ?? now;
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStarted + OTP_WINDOW_MS - now) / 1000));
    return jsonError(RESEND_MESSAGE, "OTP_RESEND", 429, { retryAfterSeconds });
  }
  // Bounded number-lookup brake. PHONE_TAKEN is a necessary UX answer, but it
  // must not become a high-rate oracle for "is this number verified elsewhere".
  // The per-user SMS cap alone does not bound it because a rejected owner check
  // never inserts a challenge row.
  const probe = consumeRateLimit(`otp_owner:${session.userId}`, { capacity: 10, refillPerMinute: 5 });
  if (!probe.allowed) {
    return jsonError("عدد المحاولات كبير. انتظر قليلًا ثم أعد المحاولة.", "rate_limit", 429, {
      retryAfterSeconds: probe.retryAfterSeconds,
    });
  }
  // Verified-number ownership: never let one account claim another's number.
  try {
    if (findVerifiedPhoneOwner(db, phone.e164, session.userId)) {
      return jsonError(PHONE_TAKEN_MESSAGE, "PHONE_TAKEN", 409);
    }
  } catch {
    return jsonError(STORE_MESSAGE, "store", 500);
  }
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
    challenge = issueChallenge(code, pepper, now, latest?.challenge ?? null);
  } catch (error) {
    const pub = publicError(error);
    return jsonError(pub.message, pub.code, pub.status);
  }
  let challengeId: string;
  try {
    challengeId = insertChallenge(db, { userId: session.userId, phoneE164: phone.e164, challenge, now });
  } catch {
    return jsonError(STORE_MESSAGE, "store", 500);
  }
  try {
    // The adapter owns the carrier wire format (e.g. 9665... without "+").
    await provider.send({ to: phone.e164, code });
  } catch {
    // Never surface a provider body or error text to the browser. Also release
    // the reserved challenge row: a carrier failure must not burn one of the
    // three sends the customer is allowed in the rolling window.
    try {
      db.prepare("DELETE FROM otp_challenges WHERE id = ?").run(challengeId);
    } catch {
      // The row will expire on its own; the customer can still resend.
    }
    return jsonError(PROVIDER_MESSAGE, "OTP_PROVIDER", 502);
  }
  // The carrier accepted the message: append the permanent trail. Both events
  // are written in one transaction so the history can never show a send that
  // was rolled back (or a first entry without its send).
  const currentPhone = profile.phoneE164;
  try {
    immediateTransaction(db, () => {
      const firstPhoneRecord = countPhoneHistoryRows(db, session.userId) === 0 && !currentPhone;
      if (firstPhoneRecord) {
        recordPhoneAudit(db, {
          userId: session.userId,
          oldPhone: null,
          newPhone: phone.e164,
          action: "INITIAL_ENTRY",
          phoneVerified: false,
          actorType: "user",
          actorUserId: session.userId,
          ...client,
          metadata: { source: "otp_send" },
          now: new Date(now),
        });
      }
      recordPhoneAudit(db, {
        userId: session.userId,
        oldPhone: currentPhone,
        newPhone: phone.e164,
        action: "OTP_SENT",
        phoneVerified: false,
        actorType: "user",
        actorUserId: session.userId,
        ...client,
        metadata: changeMode ? { source: "phone_change", requestedNewPhone: true } : { source: "initial" },
        now: new Date(now),
      });
      return { commit: true, value: undefined };
    });
  } catch {
    return jsonError(STORE_MESSAGE, "store", 500);
  }
  return jsonOk({
    sent: true,
    expiresInSeconds: OTP_TTL_MS / 1000,
    cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
    change: changeMode,
    // The normalized target the gateway actually received; the browser shows
    // the stored E.164 form instead of echoing back unnormalized input.
    targetPhone: phone.e164,
  });
}
