import { EMPTY_QUESTION_MESSAGE, MAX_COMPARISON_MODELS, MODEL_LIMIT_MESSAGE } from "@/domain/workspace-start";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_ATTACHMENT_IDS = 5;

export type ComparisonInput = {
  question: string;
  evidenceMode: "native" | "unified";
  answerModelIds: string[];
  idempotencyKey: string;
  /** Owned file ids to attach; validated as UUIDs and deduplicated (order kept). */
  attachmentIds: string[];
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
  // Trim and deduplicate before counting: selecting a model twice must never
  // consume the comparison budget, and surrounding whitespace must not turn a
  // duplicate id into a second run.
  const answerModelIds: string[] = [];
  for (const id of body.answerModelIds) {
    if (typeof id !== "string" || !id.trim()) {
      return { ok: false, message: "قائمة النماذج غير صالحة.", code: "models", status: 400 };
    }
    const trimmed = id.trim();
    if (!answerModelIds.includes(trimmed)) answerModelIds.push(trimmed);
  }
  if (answerModelIds.length > MAX_COMPARISON_MODELS) {
    return { ok: false, message: MODEL_LIMIT_MESSAGE, code: "models", status: 400 };
  }
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!UUID.test(idempotencyKey)) return { ok: false, message: "مفتاح منع التكرار غير صالح.", code: "idempotency", status: 400 };
  const attachmentIds = parseAttachmentIds(body.attachmentIds);
  if (!attachmentIds.ok) return attachmentIds;
  return {
    ok: true,
    value: {
      question,
      evidenceMode,
      answerModelIds,
      idempotencyKey,
      attachmentIds: attachmentIds.value,
    },
  };
}

function parseAttachmentIds(
  raw: unknown,
): { ok: true; value: string[] } | { ok: false; message: string; code: string; status: number } {
  if (raw == null) return { ok: true, value: [] };
  const invalid = { ok: false as const, message: "قائمة الملفات المرفقة غير صالحة.", code: "attachments", status: 400 };
  if (!Array.isArray(raw)) return invalid;
  if (raw.length > MAX_ATTACHMENT_IDS) {
    return { ok: false, message: "أقصى عدد للمرفقات خمسة.", code: "attachments", status: 400 };
  }
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !UUID.test(value)) return invalid;
    if (!ids.includes(value)) ids.push(value);
  }
  return { ok: true, value: ids };
}
