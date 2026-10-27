import { EMPTY_QUESTION_MESSAGE } from "@/domain/workspace-start";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ComparisonInput = {
  question: string;
  evidenceMode: "native" | "unified";
  answerModelIds: string[];
  idempotencyKey: string;
};

export function parseComparisonBody(
  body: Record<string, unknown>,
): { ok: true; value: ComparisonInput } | { ok: false; message: string; code: string; status: number } {
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return { ok: false, message: EMPTY_QUESTION_MESSAGE, code: "question", status: 422 };
  if (question.length > 8_000) return { ok: false, message: "السؤال أطول من الحد المسموح.", code: "question", status: 422 };
  const evidenceMode = body.evidenceMode === "unified" ? "unified" : body.evidenceMode === "native" || body.evidenceMode == null ? "native" : null;
  if (!evidenceMode) return { ok: false, message: "وضع الأدلة غير معروف.", code: "evidence_mode", status: 400 };
  if (!Array.isArray(body.answerModelIds) || body.answerModelIds.length === 0) {
    return { ok: false, message: "اختر نموذجًا واحدًا على الأقل.", code: "models", status: 400 };
  }
  if (body.answerModelIds.length > 8 || body.answerModelIds.some((id) => typeof id !== "string" || !id.trim())) {
    return { ok: false, message: "قائمة النماذج غير صالحة.", code: "models", status: 400 };
  }
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!UUID.test(idempotencyKey)) return { ok: false, message: "مفتاح منع التكرار غير صالح.", code: "idempotency", status: 400 };
  return {
    ok: true,
    value: {
      question,
      evidenceMode,
      answerModelIds: body.answerModelIds.map((id) => id.trim()),
      idempotencyKey,
    },
  };
}
