import { AppError } from "@/domain/errors";
import {
  EXCLUDED_MODEL_IDS,
  findModel,
  type ModelRecord,
} from "@/domain/models/catalog";
import { buildMaxQualityFree, completionCap, estimateTokens, type QualitySettings } from "@/domain/models/max-quality";

export function assertSelectable(id: string): ModelRecord {
  if ((EXCLUDED_MODEL_IDS as readonly string[]).includes(id)) {
    throw new AppError("النموذج مستبعد من الاختيارات الجديدة", "MODEL_EXCLUDED", 400);
  }
  const model = findModel(id);
  if (!model?.selectable) throw new AppError("النموذج غير مسموح", "MODEL_NOT_ALLOWED", 400);
  if (model.provider === "openrouter" && id !== "openrouter/free" && !id.endsWith(":free")) {
    throw new AppError("المسار المدفوع مرفوض", "PAID_ROUTE", 400);
  }
  return model;
}

export function openRouterChatBody(input: {
  model: ModelRecord;
  messages: unknown[];
  question: string;
  evidenceText: string;
  userId?: string | null;
}): { body: Record<string, unknown>; settings: QualitySettings; maxTokens: number } {
  const model = assertSelectable(input.model.id);
  if (model.provider !== "openrouter" || model.outputModalities[0] !== "text") {
    throw new AppError("هذا النموذج ليس محادثة OpenRouter", "WRONG_ENDPOINT", 400);
  }
  if (!model.id.endsWith(":free") && model.id !== "openrouter/free") {
    throw new AppError("المسار المدفوع مرفوض", "PAID_ROUTE", 400);
  }
  assertLive(model);
  const settings = buildMaxQualityFree(model);
  const cap = completionCap(model, estimateTokens(`${input.question}\n${input.evidenceText}`));
  if (!cap.applicable || cap.exceeded) {
    throw new AppError("السؤال يتجاوز سياق النموذج", "CONTEXT_EXCEEDED", 400);
  }
  const body: Record<string, unknown> = {
    model: model.id,
    messages: input.messages,
    max_tokens: cap.maxTokens,
    ...settings.sampling,
  };
  if (settings.reasoning) body.reasoning = settings.reasoning;
  if (model.requiresUserId && input.userId) body.user = input.userId;
  if ("models" in body || "provider" in body || "temperature" in body && model.id === "claude-haiku-5-5") {
    throw new AppError("مسار غير مسموح", "PAID_ROUTE", 400);
  }
  return { body, settings, maxTokens: cap.maxTokens };
}

function assertLive(model: ModelRecord): void {
  if (!model.policyAllowsTraffic || !model.liveNetwork) {
    throw new AppError("لن يُرسل الطلب بسبب قيود المزود", "POLICY_BLOCKED", 403);
  }
}

export function embeddingBody(model: ModelRecord, input: string): Record<string, unknown> {
  const selected = assertSelectable(model.id);
  assertLive(selected);
  if (selected.outputModalities[0] !== "embeddings" || selected.dimensions == null) {
    throw new AppError("النموذج ليس تضمينًا", "WRONG_ENDPOINT", 400);
  }
  return { model: selected.id, input, dimensions: selected.dimensions };
}

export function rerankBody(model: ModelRecord, query: string, documents: string[]): Record<string, unknown> {
  const selected = assertSelectable(model.id);
  assertLive(selected);
  if (selected.outputModalities[0] !== "rerank") {
    throw new AppError("النموذج ليس إعادة ترتيب", "WRONG_ENDPOINT", 400);
  }
  return { model: selected.id, query, documents };
}

export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export function decisionBody(
  model: ModelRecord,
  state: string,
  questions: Record<string, DecisionQuestion>,
): Record<string, unknown> {
  const selected = assertSelectable(model.id);
  assertLive(selected);
  if (selected.outputModalities[0] !== "decisions") {
    throw new AppError("النموذج ليس قرارًا", "WRONG_ENDPOINT", 400);
  }
  return { model: selected.id, state, questions };
}

export function speechBody(model: ModelRecord, text: string): Record<string, unknown> {
  const selected = assertSelectable(model.id);
  assertLive(selected);
  if (selected.outputModalities[0] !== "speech") {
    throw new AppError("النموذج ليس كلامًا", "WRONG_ENDPOINT", 400);
  }
  return { model: selected.id, input: text };
}

export function planDefaultEmbedding():
  | { ok: true; modelId: string; dimensions: number }
  | { ok: false; modelId: string; code: "policy_blocked" } {
  const model = assertSelectable("nvidia/nemotron-3.5-embed-1b:free");
  if (!model.policyAllowsTraffic || !model.liveNetwork) {
    return { ok: false, modelId: model.id, code: "policy_blocked" };
  }
  return { ok: true, modelId: model.id, dimensions: model.dimensions ?? 0 };
}

export function acceptReturnedModel(requested: string, returned: string | null):
  | { ok: true; displayModelId: string }
  | { ok: false; code: "unexpected_model" } {
  if (requested === "openrouter/free") {
    if (!returned) return { ok: true, displayModelId: requested };
    if (returned !== "openrouter/free" && !returned.endsWith(":free")) {
      return { ok: false, code: "unexpected_model" };
    }
    return { ok: true, displayModelId: returned };
  }
  if (returned && returned !== requested) return { ok: false, code: "unexpected_model" };
  return { ok: true, displayModelId: requested };
}

export function indexCompatible(
  index: { userId: string; modelId: string; dimensions: number; processingVersion: string },
  query: { userId: string; modelId: string; dimensions: number; processingVersion: string },
): boolean {
  return (
    index.userId === query.userId &&
    index.modelId === query.modelId &&
    index.dimensions === query.dimensions &&
    index.processingVersion === query.processingVersion
  );
}
