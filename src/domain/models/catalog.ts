import { haikuLiveCallsEnabled } from "@/domain/models/haiku";

export const CHECKED_AT = "2026-10-27" as const;

/**
 * Model ids that were deliberately retired from the selectable catalog. They
 * stay listed here so a stale client (or a saved comparison) gets a clear
 * MODEL_EXCLUDED error instead of a generic "unknown model".
 */
export const EXCLUDED_MODEL_IDS = [
  "nvidia/nemotron-3-embed-1b:free",
  "nvidia/llama-nemotron-embed-vl-1b-v2:free",
  "nvidia/llama-nemotron-rerank-vl-1b-v2:free",
] as const;

const CHAT = "https://openrouter.ai/api/v1/chat/completions";

export type Availability = "متاح" | "مقيد بشروط المزود" | "غير متاح" | "تجريبي داخلي";

export type EffortFacts = "absent" | "null" | readonly string[];

export type ReasoningFacts = {
  supportedEfforts: EffortFacts;
  supportsMaxTokens: boolean;
  mandatory: boolean;
  defaultEnabled: boolean | null;
  documentedBudget: number | null;
};

export type ModelRecord = {
  id: string;
  displayName: string;
  family: string;
  taskType: string;
  inputModalities: readonly string[];
  outputModalities: readonly string[];
  contextLength: number;
  maxCompletionTokens: number;
  maxPromptTokens: number | null;
  endpoint: string;
  availability: Availability;
  usagePolicy: string;
  checkedAt: typeof CHECKED_AT;
  selectable: boolean;
  policyAllowsTraffic: boolean;
  allowsFileData: boolean;
  requiresUserId: boolean;
  dimensions: number | null;
  supportedParameters: readonly string[];
  defaultParameters: Readonly<Record<string, number | null>>;
  reasoning: ReasoningFacts | null;
  provider: "openrouter" | "anthropic";
  liveNetwork: boolean;
  shortcut: "conversation" | "code" | "light" | null;
};

type Draft = Omit<ModelRecord, "checkedAt" | "selectable" | "provider"> & {
  provider?: ModelRecord["provider"];
};

const absentReasoning = (patch: Partial<ReasoningFacts> = {}): ReasoningFacts => ({
  supportedEfforts: "absent",
  supportsMaxTokens: false,
  mandatory: false,
  defaultEnabled: null,
  documentedBudget: null,
  ...patch,
});

function model(draft: Draft): ModelRecord {
  return {
    ...draft,
    provider: draft.provider ?? "openrouter",
    checkedAt: CHECKED_AT,
    selectable: true,
  };
}

const GEMMA_PARAMS = [
  "include_reasoning",
  "max_tokens",
  "reasoning",
  "response_format",
  "seed",
  "temperature",
  "tool_choice",
  "tools",
  "top_p",
] as const;

/**
 * The approved champion set (one primary model per company). Everything that
 * was not useful for a single-question answer comparison — embeddings, rerank,
 * safety, decision, speech, router, and duplicate model sizes — was removed so
 * GET /api/models, the picker and the default comparison all stay small,
 * predictable, and free of guaranteed-failure cards.
 */
export const MODEL_CATALOG: readonly ModelRecord[] = [
  model({
    id: "google/gemma-4-31b-it:free",
    displayName: "Google: Gemma 4 31B (free)",
    family: "Gemma",
    taskType: "محادثة",
    inputModalities: ["image", "text", "video"],
    outputModalities: ["text"],
    contextLength: 262144,
    maxCompletionTokens: 32768,
    maxPromptTokens: null,
    endpoint: CHAT,
    availability: "متاح",
    usagePolicy: "متاح. المزود يحتفظ بالمطالبات 55 يومًا ولا يدرّب النموذج عليها.",
    policyAllowsTraffic: true,
    allowsFileData: true,
    requiresUserId: true,
    dimensions: null,
    supportedParameters: GEMMA_PARAMS,
    defaultParameters: { temperature: 1, top_p: 0.95, top_k: 64 },
    reasoning: absentReasoning({ defaultEnabled: false }),
    liveNetwork: true,
    shortcut: "conversation",
  }),
  model({
    id: "nvidia/nemotron-3.5-super-vl:free",
    displayName: "NVIDIA: Nemotron 3.5 Super VL (free)",
    family: "NVIDIA",
    taskType: "إجابة",
    inputModalities: ["text", "image", "video"],
    outputModalities: ["text"],
    contextLength: 1000000,
    maxCompletionTokens: 131072,
    maxPromptTokens: 868928,
    endpoint: CHAT,
    availability: "متاح",
    usagePolicy:
      "متاح بقرار المالك بعد قبول شروط تجربة NVIDIA. الصفحة تمنع رفع المعلومات السرية أو البيانات الشخصية، وقد تُستخدم الجلسة لتحسين منتجات NVIDIA.",
    policyAllowsTraffic: true,
    allowsFileData: true,
    requiresUserId: true,
    dimensions: null,
    supportedParameters: [
      "include_reasoning",
      "max_tokens",
      "reasoning",
      "response_format",
      "seed",
      "structured_outputs",
      "temperature",
      "tool_choice",
      "tools",
      "top_p",
    ],
    defaultParameters: {},
    reasoning: absentReasoning(),
    liveNetwork: true,
    shortcut: null,
  }),
  model({
    id: "recursive/flint-v1.0:free",
    displayName: "Recursive: Flint (free)",
    family: "Recursive",
    taskType: "برمجة",
    inputModalities: ["text"],
    outputModalities: ["text"],
    contextLength: 262144,
    maxCompletionTokens: 235929,
    maxPromptTokens: null,
    endpoint: CHAT,
    availability: "متاح",
    usagePolicy: "متاح. لا تحذير على الصفحة. المزود يحتفظ بالمطالبات.",
    policyAllowsTraffic: true,
    allowsFileData: true,
    requiresUserId: false,
    dimensions: null,
    supportedParameters: [
      "include_reasoning",
      "logprobs",
      "max_tokens",
      "reasoning",
      "response_format",
      "seed",
      "stop",
      "temperature",
      "tools",
      "top_logprobs",
      "top_p",
    ],
    defaultParameters: {},
    reasoning: absentReasoning({ mandatory: true }),
    liveNetwork: true,
    shortcut: "code",
  }),
  model({
    id: "cohere/north-mini-code:free",
    displayName: "Cohere: North Mini Code (free)",
    family: "Cohere",
    taskType: "برمجة",
    inputModalities: ["text"],
    outputModalities: ["text"],
    contextLength: 256000,
    maxCompletionTokens: 64000,
    maxPromptTokens: null,
    endpoint: CHAT,
    availability: "متاح",
    usagePolicy: "متاح. المزود يحتفظ بالمطالبات 30 يومًا ولا يدرّب النموذج عليها.",
    policyAllowsTraffic: true,
    allowsFileData: true,
    requiresUserId: false,
    dimensions: null,
    supportedParameters: [
      "frequency_penalty",
      "include_reasoning",
      "max_tokens",
      "presence_penalty",
      "reasoning",
      "seed",
      "stop",
      "temperature",
      "tool_choice",
      "tools",
      "top_k",
      "top_p",
    ],
    defaultParameters: { temperature: null, top_p: null, top_k: null },
    reasoning: absentReasoning(),
    liveNetwork: true,
    shortcut: "light",
  }),
  model({
    id: "claude-haiku-5-5",
    displayName: "Claude Haiku 5.5",
    family: "Claude",
    taskType: "إجابة",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    contextLength: 1000000,
    maxCompletionTokens: 128000,
    maxPromptTokens: null,
    endpoint: "https://api.anthropic.com/v1/messages",
    availability: "متاح",
    usagePolicy: "مدفوع عبر Anthropic مباشرة. الجهد medium. التكلفة منفصلة عن الحصة المجانية.",
    policyAllowsTraffic: true,
    allowsFileData: true,
    requiresUserId: false,
    dimensions: null,
    supportedParameters: [],
    defaultParameters: {},
    reasoning: null,
    provider: "anthropic",
    liveNetwork: true,
    shortcut: null,
  }),
];

const BY_ID = new Map(MODEL_CATALOG.map((item) => [item.id, item]));

export function findModel(id: string): ModelRecord | null {
  return BY_ID.get(id) ?? null;
}

export function listSelectable(): readonly ModelRecord[] {
  return MODEL_CATALOG.filter((item) => item.selectable);
}

export function listPublicModels(env: Record<string, string | undefined> = process.env): readonly PublicModel[] {
  return listSelectable().map((model) => toPublicModel(model, env));
}

export type PublicModel = {
  id: string;
  displayName: string;
  family: string;
  taskType: string;
  inputModalities: readonly string[];
  outputModalities: readonly string[];
  contextLimits: {
    contextLength: number;
    maxCompletionTokens: number;
    maxPromptTokens: number | null;
  };
  endpointType: string;
  availability: Availability;
  usagePolicy: string;
  checkedAt: typeof CHECKED_AT;
  /** True when the provider is server-gated (currently Anthropic Haiku) and live calls are disabled. */
  liveCallsDisabled: boolean;
};

export function toPublicModel(model: ModelRecord, env: Record<string, string | undefined> = process.env): PublicModel {
  return {
    id: model.id,
    displayName: model.displayName,
    family: model.family,
    taskType: model.taskType,
    inputModalities: model.inputModalities,
    outputModalities: model.outputModalities,
    contextLimits: {
      contextLength: model.contextLength,
      maxCompletionTokens: model.maxCompletionTokens,
      maxPromptTokens: model.maxPromptTokens,
    },
    endpointType: model.endpoint,
    availability: model.availability,
    usagePolicy: model.usagePolicy,
    checkedAt: model.checkedAt,
    liveCallsDisabled: model.provider === "anthropic" && !haikuLiveCallsEnabled(env),
  };
}

export const SHORTCUTS = {
  conversation: "google/gemma-4-31b-it:free",
  code: "recursive/flint-v1.0:free",
  light: "cohere/north-mini-code:free",
} as const;

/** Default "مقارنة" preset: the four champions from the free pool plus Haiku. */
export const COMPARISON_PRESET = [
  SHORTCUTS.conversation,
  "nvidia/nemotron-3.5-super-vl:free",
  SHORTCUTS.code,
  SHORTCUTS.light,
  "claude-haiku-5-5",
] as const;
