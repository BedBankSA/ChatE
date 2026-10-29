import { AppError } from "@/domain/errors";

export const HAIKU_MODEL_ID = "claude-haiku-5-5";
export const HAIKU_URL = "https://api.anthropic.com/v1/messages";
export const HAIKU_EFFORT = "medium" as const;
/** Anthropic Messages API version requested by the direct adapter. */
export const ANTHROPIC_VERSION = "2023-06-01";
/** Bytes cap for one streamed Anthropic reply (defensive; a provider cannot pin memory). */
export const HAIKU_STREAM_MAX_BYTES = 2_000_000;

/**
 * The direct Anthropic adapter is live when the server holds an API key and the
 * operator has not explicitly disabled paid calls. HAIKU_LIVE_CALLS remains a
 * kill switch:
 *   - "0"      -> off even when a key exists
 *   - "1"      -> on (kept for backwards compatibility with older deployments)
 *   - unset    -> on iff ANTHROPIC_API_KEY is present
 * The key is server-only; nothing here is imported by a client component.
 */
export function haikuLiveCallsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  // A key is always required; HAIKU_LIVE_CALLS=0 stays an explicit kill switch.
  if (!env.ANTHROPIC_API_KEY?.trim()) return false;
  return env.HAIKU_LIVE_CALLS?.trim() !== "0";
}

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

/**
 * Direct Anthropic call for the comparison pipeline. The request is sent with
 * stream:true and the SSE events are assembled server-side into the same
 * message shape interpretAnthropic already understands, so the UI keeps its
 * existing polling protocol (one persisted run per model) while the provider
 * transport is a real stream. A JSON response (older gateways, unit tests, or
 * an endpoint that ignores stream:true) is still accepted as a fallback.
 */
export async function postHaiku(
  body: HaikuBody,
  deps: { fetchImpl: typeof fetch; apiKey: string; allowLive: boolean; env?: Record<string, string | undefined> },
): Promise<{ status: number; body: unknown }> {
  if (!haikuLiveCallsEnabled(deps.env) || !deps.allowLive) {
    throw new AppError("استدعاء Haiku الحي متوقف في هذا البناء", "HAIKU_LIVE_DISABLED", 409);
  }
  if (!deps.apiKey.trim()) throw new AppError("مفتاح Anthropic غير مهيأ على الخادم.", "ANTHROPIC_UNCONFIGURED", 503);
  const response = await deps.fetchImpl(HAIKU_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": deps.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(120_000),
  });
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (response.status === 200 && response.body && contentType.includes("text/event-stream")) {
    return { status: 200, body: await collectAnthropicStream(response.body) };
  }
  const payload: unknown = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

/**
 * Parses Anthropic's SSE frames (message_start / content_block_delta /
 * message_delta / error) into one message object. Text deltas are concatenated
 * in arrival order; usage counters are merged so cost and finish handling stay
 * identical to the non-streaming path.
 */
async function collectAnthropicStream(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const usage: Record<string, number> = {};
  let buffer = "";
  let bytes = 0;
  let text = "";
  let model = HAIKU_MODEL_ID;
  let stopReason: string | null = null;
  const streamErrors: string[] = [];

  const mergeUsage = (value: unknown): void => {
    const record = asRecord(value);
    if (!record) return;
    for (const [key, raw] of Object.entries(record)) {
      if (typeof raw === "number" && Number.isFinite(raw)) usage[key] = raw;
    }
  };

  const handleLine = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw) return;
    let event: Record<string, unknown> | null = null;
    try {
      event = asRecord(JSON.parse(raw));
    } catch {
      event = null;
    }
    if (!event) return;
    const type = typeof event.type === "string" ? event.type : "";
    const message = asRecord(event.message);
    if (type === "message_start" && message) {
      if (typeof message.model === "string") model = message.model;
      mergeUsage(message.usage);
      return;
    }
    if (type === "content_block_delta") {
      const delta = asRecord(event.delta);
      if (delta?.type === "text_delta" && typeof delta.text === "string") text += delta.text;
      return;
    }
    if (type === "message_delta") {
      const delta = asRecord(event.delta);
      if (delta && typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
      mergeUsage(event.usage);
      return;
    }
    if (type === "error") {
      const errorRecord = asRecord(event.error);
      streamErrors.push(
        errorRecord && typeof errorRecord.message === "string"
          ? errorRecord.message
          : "خطأ غير معروف من المزود",
      );
    }
  };

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value) continue;
      bytes += chunk.value.byteLength;
      if (bytes > HAIKU_STREAM_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AppError("رد Haiku أطول من الحد المسموح.", "HAIKU_STREAM_LIMIT", 502);
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        handleLine(buffer.slice(0, index).replace(/\r$/, ""));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) handleLine(buffer.replace(/\r$/, ""));
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled stream may already be released.
    }
  }

  if (streamErrors.length > 0) {
    throw new AppError(`تعذر بث رد Haiku: ${streamErrors[0].slice(0, 160)}`, "HAIKU_STREAM", 502);
  }
  return {
    id: "haiku-stream",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    usage,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
