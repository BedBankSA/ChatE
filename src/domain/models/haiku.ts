import { AppError } from "@/domain/errors";

export const HAIKU_MODEL_ID = "claude-haiku-5-5";
export const HAIKU_URL = "https://api.anthropic.com/v1/messages";
export const HAIKU_EFFORT = "medium" as const;
export const HAIKU_LIVE_CALLS_ENABLED = true;

export type HaikuText = { type: "text"; text: string };
export type HaikuImage = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
export type HaikuContent = HaikuText | HaikuImage;

export type HaikuBody = {
  model: typeof HAIKU_MODEL_ID;
  max_tokens: number;
  thinking: { type: "adaptive" };
  output_config: { effort: typeof HAIKU_EFFORT };
  system: string;
  messages: [{ role: "user"; content: HaikuContent[] }];
};

export function haikuMaxTokens(inputTokens: number): number {
  return Math.max(0, Math.min(128_000, 1_000_000 - inputTokens));
}

export function buildHaikuRequest(input: {
  maxTokens: number;
  system: string;
  content: HaikuContent[];
}): HaikuBody {
  const body: HaikuBody = {
    model: HAIKU_MODEL_ID,
    max_tokens: input.maxTokens,
    thinking: { type: "adaptive" },
    output_config: { effort: HAIKU_EFFORT },
    system: input.system,
    messages: [{ role: "user", content: input.content }],
  };
  const record = body as unknown as Record<string, unknown>;
  if ("temperature" in record || "top_p" in record || "top_k" in record) {
    throw new AppError("معاملات المعاينة مرفوضة لـ Haiku", "HAIKU_SAMPLING", 400);
  }
  return body;
}

export function haikuCostUsd(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}): number {
  const high = usage.inputTokens > 100_000;
  const perMillion = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  const cost =
    perMillion(usage.inputTokens, high ? 0.5 : 0.1) +
    perMillion(usage.outputTokens, high ? 2.5 : 0.5) +
    perMillion(usage.cacheReadTokens ?? 0, high ? 0.05 : 0.01) +
    perMillion(usage.cacheWrite5mTokens ?? 0, high ? 0.625 : 0.125) +
    perMillion(usage.cacheWrite1hTokens ?? 0, high ? 1 : 0.2);
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export async function postHaiku(
  body: HaikuBody,
  deps: { fetchImpl: typeof fetch; apiKey: string; allowLive: boolean },
): Promise<{ status: number; body: unknown }> {
  if (!HAIKU_LIVE_CALLS_ENABLED || !deps.allowLive) {
    throw new AppError("استدعاء Haiku الحي متوقف في هذا البناء", "HAIKU_LIVE_DISABLED", 409);
  }
  if (!deps.apiKey.trim()) throw new AppError("مفتاح Anthropic غير مهيأ على الخادم.", "ANTHROPIC_UNCONFIGURED", 503);
  const response = await deps.fetchImpl(HAIKU_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": deps.apiKey,
      "anthropic-version": "2026-10-21",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}
