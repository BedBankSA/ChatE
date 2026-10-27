import type { ModelRecord } from "@/domain/models/catalog";

const EFFORT_ORDER = ["max", "xhigh", "high", "medium", "low", "minimal"] as const;
const SAMPLING_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "repetition_penalty",
  "frequency_penalty",
  "presence_penalty",
] as const;

export type QualitySettings = {
  profile: "MAX_QUALITY_FREE";
  reasoning: Record<string, unknown> | null;
  sampling: Record<string, number>;
  labels: string[];
  notes: string[];
  effortVerification: "verified" | "unverified";
};

export function highestEffort(levels: readonly string[]): string | null {
  for (const level of EFFORT_ORDER) {
    if (levels.includes(level)) return level;
  }
  return null;
}

export function pickSampling(model: ModelRecord): Record<string, number> {
  const sampling: Record<string, number> = {};
  for (const key of SAMPLING_KEYS) {
    const value = model.defaultParameters[key];
    if (typeof value !== "number") continue;
    if (!model.supportedParameters.includes(key)) continue;
    sampling[key] = value;
  }
  return sampling;
}

export function buildMaxQualityFree(model: ModelRecord): QualitySettings {
  if (model.provider === "anthropic") {
    return settings({
      reasoning: null,
      sampling: {},
      labels: [],
      notes: ["MAX_QUALITY_FREE لا يرفع جهد Haiku"],
      effortVerification: "verified",
    });
  }
  if (model.id === "openrouter/free" || model.reasoning == null) {
    return settings({
      reasoning: null,
      sampling: model.id === "openrouter/free" ? pickSampling(model) : {},
      labels: [],
      notes: ["مستوى الجهد غير قابل للتحقق"],
      effortVerification: "unverified",
    });
  }
  const sampling = pickSampling(model);
  const facts = model.reasoning;
  if (Array.isArray(facts.supportedEfforts)) {
    const effort = highestEffort(facts.supportedEfforts);
    if (effort) {
      return settings({
        reasoning: { effort },
        sampling,
        labels: ["أعلى مستوى جهد مدعوم"],
        notes: [`الجهد المطلوب: ${effort}`],
        effortVerification: "verified",
      });
    }
  }
  if (facts.supportedEfforts === "null") {
    return settings({
      reasoning: { effort: "max" },
      sampling,
      labels: ["أعلى مستوى جهد مدعوم"],
      notes: ["القيمة null تعني أن مستويات جهد البوابة مقبولة"],
      effortVerification: "verified",
    });
  }
  const notes = ["مستوى الجهد غير قابل للتحقق"];
  if (facts.mandatory) notes.push("التفكير إلزامي في بيانات القائمة");
  if (facts.supportsMaxTokens && facts.documentedBudget == null) {
    notes.push("ميزانية التفكير الرقمية: لم تُذكر في المصدر الرسمي المقروء");
  }
  return settings({
    reasoning: { enabled: true },
    sampling,
    labels: ["التفكير مفعّل"],
    notes,
    effortVerification: "unverified",
  });
}

function settings(input: Omit<QualitySettings, "profile">): QualitySettings {
  return { profile: "MAX_QUALITY_FREE", ...input };
}

export type CompletionCap =
  | { applicable: false }
  | { applicable: true; exceeded: true; maxTokens: 0; visibleReserve: 0 }
  | { applicable: true; exceeded: false; maxTokens: number; visibleReserve: number };

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

export function completionCap(
  model: ModelRecord,
  inputTokens: number,
  toolTokens = 0,
  mediaTokens = 0,
): CompletionCap {
  const chat = model.outputModalities.length === 1 && model.outputModalities[0] === "text";
  if (!chat || model.contextLength === 0) return { applicable: false };
  const input = inputTokens + toolTokens + mediaTokens;
  if (model.maxPromptTokens != null && input > model.maxPromptTokens) {
    return { applicable: true, exceeded: true, maxTokens: 0, visibleReserve: 0 };
  }
  const room = model.contextLength - input;
  const providerCap = model.maxCompletionTokens > 0 ? model.maxCompletionTokens : room;
  const maxTokens = Math.max(0, Math.min(providerCap, room));
  if (maxTokens <= 0) return { applicable: true, exceeded: true, maxTokens: 0, visibleReserve: 0 };
  const visibleReserve = Math.min(maxTokens, Math.max(256, Math.floor(maxTokens * 0.2)));
  return { applicable: true, exceeded: false, maxTokens, visibleReserve };
}

export function interpretFinish(input: {
  finishReason: string | null;
  visibleText: string;
}): "complete" | "incomplete" {
  if (input.finishReason === "length" || input.finishReason === "max_tokens") return "incomplete";
  if (!input.visibleText.trim()) return "incomplete";
  return "complete";
}
