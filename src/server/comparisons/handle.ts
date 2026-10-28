import { planRuns } from "@/domain/comparison/plan";
import { parseComparisonBody } from "@/domain/comparison/input";
import { modelUseBlock, otpProviderConfigured } from "@/domain/auth/model-gate";
import { publicError } from "@/domain/errors";
import { recordAcceptedComparison } from "@/server/admin/operations";
import { readStoredProfile } from "@/server/db/profiles";
import { readQuotaLimits } from "@/server/db/quota";
import { getDatabase } from "@/server/db/runtime";
import { gateTurnstile, readJson } from "@/server/guard";
import { jsonError, jsonOk } from "@/server/http";
import { readComparisonSession } from "@/server/google-session";
import { createComparison, readComparison } from "@/server/comparisons/store";
import { scheduleComparison } from "@/server/comparisons/execute";

const ANONYMOUS_MESSAGE = "يلزم تسجيل الدخول قبل إرسال المقارنة";

export async function postComparison(request: Request): Promise<Response> {
  const body = await readJson(request);
  const session = await readComparisonSession(request);
  if (!session) return jsonError(ANONYMOUS_MESSAGE, "anonymous", 401);
  let db;
  try {
    db = getDatabase();
  } catch {
    return jsonError("تعذر فتح قاعدة المقارنات.", "store", 500);
  }
  const profile = readStoredProfile(db, session.userId);
  if (!profile) return jsonError("أعد تسجيل الدخول لحفظ الحساب قبل إرسال المقارنة.", "account_missing", 401);
  const blocked = modelUseBlock(profile, otpProviderConfigured(process.env));
  if (blocked) return jsonError(blocked.message, blocked.code, blocked.status);
  const parsed = parseComparisonBody(body);
  if (!parsed.ok) return jsonError(parsed.message, parsed.code, parsed.status);
  const turnstile = await gateTurnstile(request, body, "comparison");
  if (turnstile) return turnstile;
  let runs;
  try {
    runs = planRuns({
      question: parsed.value.question,
      evidenceMode: parsed.value.evidenceMode,
      evidenceText: "",
      attachments: [],
      answerModelIds: parsed.value.answerModelIds,
      decisionModelIds: [],
      evalModelIds: [],
      safetyModelIds: [],
      speechModelIds: [],
      router: false,
      decision: null,
      behavior: null,
      speechText: null,
      profile: { name: profile.name ?? "", email: profile.email ?? "", phone: profile.phoneE164 ?? "" },
      userId: session.userId,
    });
  } catch (error) {
    const pub = publicError(error);
    return jsonError(pub.message, pub.code, pub.status);
  }
  let created;
  try {
    created = createComparison(db, {
      userId: session.userId,
      idempotencyKey: parsed.value.idempotencyKey,
      question: parsed.value.question,
      evidenceMode: parsed.value.evidenceMode,
      runs,
      limits: readQuotaLimits(process.env),
    });
  } catch {
    return jsonError("تعذر حفظ المقارنة.", "store", 500);
  }
  if (!created.ok) return jsonError(created.message, created.code, 429);
  if (!created.duplicate) {
    try {
      recordAcceptedComparison(db, {
        userId: session.userId,
        comparisonId: created.comparison.id,
        occurredAt: new Date().toISOString(),
      });
    } catch {
      // Counters are best effort; a statistics failure must not fail an
      // otherwise accepted comparison.
    }
  }
  if (!created.duplicate || created.comparison.status === "queued" || created.comparison.status === "running") {
    scheduleComparison(created.comparison.id);
  }
  return jsonOk(created.comparison);
}

export async function getComparison(request: Request, comparisonId: string): Promise<Response> {
  const session = await readComparisonSession(request);
  if (!session) return jsonError(ANONYMOUS_MESSAGE, "anonymous", 401);
  if (!/^[0-9a-f-]{36}$/i.test(comparisonId)) return jsonError("المقارنة غير موجودة.", "not_found", 404);
  let db;
  try {
    db = getDatabase();
  } catch {
    return jsonError("تعذر فتح قاعدة المقارنات.", "store", 500);
  }
  const comparison = readComparison(db, session.userId, comparisonId);
  if (!comparison) return jsonError("المقارنة غير موجودة.", "not_found", 404);
  if (comparison.status === "queued" || comparison.status === "running") scheduleComparison(comparison.id);
  return jsonOk(comparison);
}
