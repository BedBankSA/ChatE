export const CHAT_SHORTCUT_MODEL = "google/gemma-4-31b-it:free";
export const CODE_SHORTCUT_MODEL = "recursive/flint-v1.0:free";
export const LIGHT_SHORTCUT_MODEL = "cohere/north-mini-code:free";
export const NVIDIA_COMPARISON_MODEL = "nvidia/nemotron-3.5-super-vl:free";
export const HAIKU_COMPARISON_MODEL = "claude-haiku-5-5";
/**
 * The "مقارنة" preset: the four approved free champions (NVIDIA traffic is
 * enabled by owner decision) plus Anthropic Haiku.
 */
export const COMPARISON_MODEL_IDS = [
  CHAT_SHORTCUT_MODEL,
  NVIDIA_COMPARISON_MODEL,
  CODE_SHORTCUT_MODEL,
  LIGHT_SHORTCUT_MODEL,
  HAIKU_COMPARISON_MODEL,
] as const;
/** Hard server-side cap on answer models per comparison request. */
export const MAX_COMPARISON_MODELS = 8;
export const MODEL_LIMIT_MESSAGE = "يمكن مقارنة 8 نماذج على الأكثر في الطلب الواحد.";
export const EMPTY_QUESTION_MESSAGE = "اكتب السؤال في الحقل أولًا.";
export const SENDING_MESSAGE = "جارٍ الإرسال.";
export const REQUEST_FAILED_MESSAGE = "تعذر إكمال الطلب";

export function shortcutModel(kind: "chat" | "code" | "light"): string {
  if (kind === "chat") return CHAT_SHORTCUT_MODEL;
  if (kind === "code") return CODE_SHORTCUT_MODEL;
  return LIGHT_SHORTCUT_MODEL;
}

export function emptyQuestionMessage(question: string): string | null {
  if (question.trim().length > 0) return null;
  return EMPTY_QUESTION_MESSAGE;
}

export function comparisonFailureMessage(body: unknown): string {
  if (!body || typeof body !== "object") return REQUEST_FAILED_MESSAGE;
  const message = (body as { error?: { message?: unknown } }).error?.message;
  if (typeof message !== "string") return REQUEST_FAILED_MESSAGE;
  const trimmed = message.trim();
  return trimmed || REQUEST_FAILED_MESSAGE;
}
