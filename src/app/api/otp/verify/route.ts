import { OTP_MAX_ATTEMPTS, verifyChallenge } from "@/domain/auth/otp";
import { publicError } from "@/domain/errors";
import { getDatabase } from "@/server/db/runtime";
import { immediateTransaction } from "@/server/db/transaction";
import { readJson } from "@/server/guard";
import { readComparisonSession } from "@/server/google-session";
import { jsonError, jsonOk } from "@/server/http";
import { otpPepper } from "@/server/otp/config";
import { consumeChallenge, incrementAttempts, latestChallenge, setVerifiedPhone } from "@/server/otp/service";

const ANONYMOUS_MESSAGE = "يلزم تسجيل الدخول قبل تأكيد رمز التحقق";
const STORE_MESSAGE = "تعذر تأكيد رمز التحقق.";
const CODE_PATTERN = /^\d{4,8}$/;

export async function POST(request: Request) {
  const body = await readJson(request);
  const session = await readComparisonSession(request);
  if (!session) return jsonError(ANONYMOUS_MESSAGE, "anonymous", 401);
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
    pepper = otpPepper(process.env);
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
  const result = verifyChallenge(stored.challenge, code, pepper, now);
  if (!result.ok) {
    let attempts = result.challenge.attempts;
    if (result.reason === "mismatch") {
      try {
        attempts = incrementAttempts(db, stored.id);
      } catch {
        return jsonError(STORE_MESSAGE, "store", 500);
      }
    }
    return failureResponse(result.reason, attempts);
  }
  // Consume the challenge and persist the verified phone atomically; the
  // conditional consume makes a concurrent double-submit land on exactly one
  // committed profile update.
  const verifiedAt = new Date(now).toISOString();
  let committed: boolean;
  try {
    committed = immediateTransaction(db, () => {
      if (!consumeChallenge(db, stored.id, now)) return { commit: false, value: false };
      setVerifiedPhone(db, session.userId, stored.phoneE164, verifiedAt);
      return { commit: true, value: true };
    });
  } catch {
    return jsonError(STORE_MESSAGE, "store", 500);
  }
  if (!committed) return jsonError("استُخدم رمز التحقق مسبقًا. اطلب رمزًا جديدًا.", "OTP_MISSING", 403);
  return jsonOk({ verified: true });
}

function failureResponse(reason: string, attempts: number): Response {
  if (reason === "attempts" || (reason === "mismatch" && attempts >= OTP_MAX_ATTEMPTS)) {
    return jsonError("تجاوزت عدد محاولات التحقق المسموح. اطلب رمزًا جديدًا.", "OTP_ATTEMPTS", 429);
  }
  if (reason === "expired") return jsonError("انتهت صلاحية رمز التحقق. اطلب رمزًا جديدًا.", "OTP_EXPIRED", 403);
  if (reason === "consumed") return jsonError("استُخدم رمز التحقق مسبقًا. اطلب رمزًا جديدًا.", "OTP_MISSING", 403);
  const remainingAttempts = Math.max(OTP_MAX_ATTEMPTS - attempts, 1);
  return Response.json(
    { ok: false, data: null, error: { message: "رمز التحقق غير صحيح.", code: "OTP_MISMATCH", remainingAttempts } },
    { status: 403 },
  );
}

function readCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CODE_PATTERN.test(trimmed) ? trimmed : null;
}
