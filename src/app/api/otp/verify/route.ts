import { OTP_MAX_ATTEMPTS, verifyChallenge } from "@/domain/auth/otp";
import { publicError } from "@/domain/errors";
import { getDatabase } from "@/server/db/runtime";
import { runtimeEnv } from "@/server/db/settings";
import { immediateTransaction } from "@/server/db/transaction";
import { rateLimitResponse, readJson } from "@/server/guard";
import { readComparisonSession } from "@/server/google-session";
import { jsonError, jsonOk } from "@/server/http";
import { otpPepper } from "@/server/otp/config";
import { claimAttempt, consumeChallenge, latestChallenge, setVerifiedPhone } from "@/server/otp/service";
import { findVerifiedPhoneOwner, readProfilePhone, recordPhoneAudit } from "@/server/phone/audit";
import { readClientMeta } from "@/server/phone/request";

const ANONYMOUS_MESSAGE = "يلزم تسجيل الدخول قبل تأكيد رمز التحقق";
const STORE_MESSAGE = "تعذر تأكيد رمز التحقق.";
const CODE_PATTERN = /^\d{4,8}$/;
/** A number already verified by another account can never be claimed here. */
const PHONE_TAKEN_MESSAGE = "هذا الرقم مرتبط بحساب آخر موثّق. عدّل رقم الجوال ثم أعد المحاولة.";

/**
 * POST /api/otp/verify — verifies the newest unconsumed challenge, then:
 *   1) re-checks the target number is not verified by another account (race-safe
 *      inside the same immediate transaction that consumes the code),
 *   2) writes profiles.phone_e164/phone_verified_at,
 *   3) appends OTP_VERIFIED and, when the number actually changed,
 *      PHONE_CHANGED_BY_USER to the permanent phone_history trail.
 */
export async function POST(request: Request) {
  const body = await readJson(request);
  const session = await readComparisonSession(request);
  if (!session) return jsonError(ANONYMOUS_MESSAGE, "anonymous", 401);
  // Per-IP ceiling on top of the per-challenge attempt cap. Distributed
  // guessing is throttled even when it rotates accounts/challenges.
  const limited = rateLimitResponse(request, "otp_verify", { capacity: 20, refillPerMinute: 10 });
  if (limited) return limited;
  const code = readCode(body.code);
  if (!code) return jsonError("أدخل رمز التحقق المكوّن من ٤ إلى ٨ أرقام.", "OTP_CODE", 422);
  let db;
  try {
    db = getDatabase();
  } catch {
    return jsonError(STORE_MESSAGE, "store", 500);
  }
  let pepper: string;
  try {
    pepper = otpPepper(runtimeEnv());
  } catch (error) {
    const pub = publicError(error);
    return jsonError(pub.message, pub.code, pub.status);
  }
  const now = Date.now();
  let stored;
  try {
    stored = latestChallenge(db, session.userId);
  } catch {
    return jsonError(STORE_MESSAGE, "store", 500);
  }
  if (!stored) return jsonError("لا يوجد رمز تحقق نشط. اطلب رمزًا جديدًا.", "OTP_MISSING", 403);
  // Free pre-checks that do not consume an attempt slot.
  if (now > stored.challenge.expiresAt) {
    return jsonError("انتهت صلاحية رمز التحقق. اطلب رمزًا جديدًا.", "OTP_EXPIRED", 403);
  }
  if (stored.challenge.attempts >= OTP_MAX_ATTEMPTS) {
    return failureResponse("attempts", stored.challenge.attempts);
  }
  // Claim one attempt slot atomically BEFORE hashing the submitted code. A plain
  // read-then-increment let parallel requests all observe "attempts = 4" and
  // bypass the five-guess cap; the conditional UPDATE grants at most 5 slots.
  let attemptSlot: number | null;
  try {
    attemptSlot = claimAttempt(db, stored.id, OTP_MAX_ATTEMPTS);
  } catch {
    return jsonError(STORE_MESSAGE, "store", 500);
  }
  if (attemptSlot == null) return failureResponse("attempts", OTP_MAX_ATTEMPTS);
  const result = verifyChallenge(stored.challenge, code, pepper, now);
  if (!result.ok) {
    if (result.reason === "mismatch") {
      recordFailedAttempt(db, session.userId, stored.phoneE164, attemptSlot, request);
    }
    return failureResponse(result.reason, attemptSlot);
  }
  const verifiedAt = new Date(now).toISOString();
  const client = readClientMeta(request);
  let outcome: { committed: boolean; taken: boolean; changed: boolean };
  try {
    outcome = immediateTransaction<{ committed: boolean; taken: boolean; changed: boolean }>(db, () => {
      // Ownership re-check inside the write transaction: two accounts racing for
      // the same number can never both end up verified.
      const owner = findVerifiedPhoneOwner(db, stored.phoneE164, session.userId);
      if (owner) {
        recordPhoneAudit(db, {
          userId: session.userId,
          oldPhone: readProfilePhone(db, session.userId)?.phoneE164 ?? null,
          newPhone: stored.phoneE164,
          action: "FAILED_OTP_ATTEMPT",
          phoneVerified: false,
          actorType: "user",
          actorUserId: session.userId,
          ...client,
          metadata: { reason: "phone_taken" },
          now: new Date(now),
        });
        return { commit: true, value: { committed: false, taken: true, changed: false } };
      }
      // Consume + persist atomically; the conditional consume makes a concurrent
      // double-submit land on exactly one committed profile update.
      if (!consumeChallenge(db, stored.id, now)) {
        return { commit: false, value: { committed: false, taken: false, changed: false } };
      }
      const previousPhone = readProfilePhone(db, session.userId)?.phoneE164 ?? null;
      setVerifiedPhone(db, session.userId, stored.phoneE164, verifiedAt);
      recordPhoneAudit(db, {
        userId: session.userId,
        oldPhone: previousPhone,
        newPhone: stored.phoneE164,
        action: "OTP_VERIFIED",
        phoneVerified: true,
        actorType: "user",
        actorUserId: session.userId,
        ...client,
        metadata: { attempts: result.challenge.attempts },
        now: new Date(now),
      });
      const changed = Boolean(previousPhone && previousPhone !== stored.phoneE164);
      if (changed) {
        recordPhoneAudit(db, {
          userId: session.userId,
          oldPhone: previousPhone,
          newPhone: stored.phoneE164,
          action: "PHONE_CHANGED_BY_USER",
          phoneVerified: true,
          actorType: "user",
          actorUserId: session.userId,
          ...client,
          metadata: { source: "otp_verify" },
          now: new Date(now),
        });
      }
      return { commit: true, value: { committed: true, taken: false, changed } };
    });
  } catch {
    return jsonError(STORE_MESSAGE, "store", 500);
  }
  if (outcome.taken) return jsonError(PHONE_TAKEN_MESSAGE, "PHONE_TAKEN", 409);
  if (!outcome.committed) return jsonError("استُخدم رمز التحقق مسبقًا. اطلب رمزًا جديدًا.", "OTP_MISSING", 403);
  // Contract stays { verified: true } for the initial flow; the customer dashboard
  // only needs the extra flag when a number actually changed.
  return outcome.changed ? jsonOk({ verified: true, changed: true }) : jsonOk({ verified: true });
}

/** Failure-path audit is best-effort: the response is already rate-limited. */
function recordFailedAttempt(
  db: ReturnType<typeof getDatabase>,
  userId: string,
  phoneE164: string,
  attempts: number,
  request: Request,
): void {
  try {
    recordPhoneAudit(db, {
      userId,
      oldPhone: readProfilePhone(db, userId)?.phoneE164 ?? null,
      newPhone: phoneE164,
      action: "FAILED_OTP_ATTEMPT",
      phoneVerified: false,
      actorType: "user",
      actorUserId: userId,
      ...readClientMeta(request),
      metadata: { attempts },
      now: new Date(),
    });
  } catch {
    // Never let the audit append change the verification answer.
  }
}

function failureResponse(reason: string, attempts: number): Response {
  if (reason === "attempts" || (reason === "mismatch" && attempts >= OTP_MAX_ATTEMPTS)) {
    return jsonError("تجاوزت عدد محاولات التحقق المسموح. اطلب رمزًا جديدًا.", "OTP_ATTEMPTS", 429);
  }
  if (reason === "expired") return jsonError("انتهت صلاحية رمز التحقق. اطلب رمزًا جديدًا.", "OTP_EXPIRED", 403);
  if (reason === "consumed") return jsonError("استُخدم رمز التحقق مسبقًا. اطلب رمزًا جديدًا.", "OTP_MISSING", 403);
  const remainingAttempts = Math.max(OTP_MAX_ATTEMPTS - attempts, 1);
  return jsonError("رمز التحقق غير صحيح.", "OTP_MISMATCH", 403, { remainingAttempts });
}

function readCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CODE_PATTERN.test(trimmed) ? trimmed : null;
}
