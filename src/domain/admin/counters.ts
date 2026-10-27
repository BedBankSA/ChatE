export type InvocationType = "generation" | "embedding" | "rerank" | "classification" | "speech";

export function invocationType(taskType: string | null | undefined): InvocationType {
  if (taskType === "تضمين") return "embedding";
  if (taskType === "إعادة ترتيب") return "rerank";
  if (taskType === "كلام") return "speech";
  if (taskType === "تقييم" || taskType === "تصنيف" || taskType === "قرار") return "classification";
  return "generation";
}

export function operationKey(kind: string, stableId: string): string {
  return `${kind}:${stableId}`;
}

export function countedTokens(input: {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  reasoningIncludedInOutput: boolean;
}): number | null {
  const { inputTokens, outputTokens, reasoningTokens, reasoningIncludedInOutput } = input;
  if (inputTokens == null && outputTokens == null && reasoningTokens == null) return null;
  const reasoning = reasoningIncludedInOutput ? 0 : reasoningTokens ?? 0;
  return (inputTokens ?? 0) + (outputTokens ?? 0) + reasoning;
}

export function redactErrorCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const upper = input.trim().toUpperCase();
  if (upper.includes("SK-") || upper.includes("BEARER")) return "REDACTED";
  const token = upper.replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!token) return "PROVIDER";
  return token.slice(0, 64);
}

export function errorClass(code: string | null): "rate_limit" | "auth" | "service" | null {
  if (!code) return null;
  if (code === "RATE_LIMIT" || code === "429") return "rate_limit";
  if (code === "AUTH" || code === "PROVIDER_AUTH") return "auth";
  if (code === "SERVICE" || code === "PROVIDER_UNAVAILABLE" || code === "HTTP") return "service";
  return null;
}

export function percentile(sortedAscending: number[], p: number): number | null {
  if (sortedAscending.length < 20) return null;
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index] ?? null;
}
