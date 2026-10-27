import { AppError } from "@/domain/errors";
import { retryDecision } from "@/domain/quota/reserve";
import { acceptReturnedModel } from "@/domain/models/endpoints";
import { HAIKU_MODEL_ID, HAIKU_URL, postHaiku, type HaikuBody } from "@/domain/models/haiku";
import { haikuCostUsd } from "@/domain/models/haiku";
import { interpretFinish } from "@/domain/models/max-quality";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const CALL_TIMEOUT_MS = 120_000;

export type DispatchResult = {
  attempted: boolean;
  status: "completed" | "incomplete" | "failed";
  outputText: string;
  message: string | null;
  errorCode: string | null;
  providerModelId: string | null;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  completionMs: number | null;
};

export type DispatchDeps = {
  fetchImpl: typeof fetch;
  openRouterKey?: string;
  anthropicKey?: string;
  appUrl: string;
};

export async function dispatchModel(
  input: {
    provider: "anthropic" | "openrouter";
    modelId: string;
    endpoint: string;
    request: Record<string, unknown> | null;
  },
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (input.provider === "anthropic") return dispatchHaiku(input.modelId, input.endpoint, input.request, deps);
  return dispatchOpenRouter(input.modelId, input.endpoint, input.request, deps);
}

async function dispatchOpenRouter(
  modelId: string,
  endpoint: string,
  request: Record<string, unknown> | null,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (!modelId.endsWith(":free") || endpoint !== OPENROUTER_CHAT_URL) {
    return failed(false, "المسار المدفوع مرفوض", "PAID_ROUTE");
  }
  if (!request || request.model !== modelId || "models" in request || "provider" in request) {
    return failed(false, "طلب النموذج مرفوض.", "REQUEST_REJECTED");
  }
  if (!deps.openRouterKey?.trim()) return failed(false, "مفتاح المزود المجاني غير مهيأ على الخادم.", "OPENROUTER_UNCONFIGURED");
  return send("openrouter", modelId, endpoint, request, deps.openRouterKey, deps);
}

async function dispatchHaiku(
  modelId: string,
  endpoint: string,
  request: Record<string, unknown> | null,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  if (modelId !== HAIKU_MODEL_ID || endpoint !== HAIKU_URL) {
    return failed(false, "مسار Haiku مرفوض.", "HAIKU_ROUTE");
  }
  const body = haikuBody(request);
  if (!body) return failed(false, "طلب Haiku غير مطابق للشكل الملزم.", "HAIKU_BODY");
  if (!deps.anthropicKey?.trim()) return failed(false, "مفتاح Anthropic غير مهيأ على الخادم.", "ANTHROPIC_UNCONFIGURED");
  const started = Date.now();
  try {
    const response = await postHaiku(body, { fetchImpl: deps.fetchImpl, apiKey: deps.anthropicKey, allowLive: true });
    return interpretAnthropic(modelId, response.status, response.body, Date.now() - started);
  } catch (error) {
    if (error instanceof AppError) return failed(false, error.message, error.code);
    return failed(true, "تعذر الاتصال بـ Anthropic.", "ANTHROPIC_UNAVAILABLE");
  }
}

function haikuBody(request: Record<string, unknown> | null): HaikuBody | null {
  if (!request) return null;
  if (request.model !== HAIKU_MODEL_ID) return null;
  if ("temperature" in request || "top_p" in request || "top_k" in request) return null;
  const output = request.output_config;
  if (!output || typeof output !== "object" || (output as { effort?: unknown }).effort !== "medium") return null;
  const thinking = request.thinking;
  if (thinking != null && (typeof thinking !== "object" || (thinking as { type?: unknown }).type !== "adaptive")) return null;
  return request as unknown as HaikuBody;
}

async function send(
  provider: "openrouter",
  modelId: string,
  endpoint: string,
  request: Record<string, unknown>,
  apiKey: string,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const started = Date.now();
  let lastStatus = 0;
  let lastBody: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await deps.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "http-referer": deps.appUrl,
          "x-title": "ChatE",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      return failed(attempt > 0, "تعذر الاتصال بالمزود المجاني.", "PROVIDER_UNAVAILABLE", Date.now() - started);
    }
    lastStatus = response.status;
    lastBody = await response.json().catch(() => null);
    if (response.status !== 429) break;
    const decision = retryDecision(attempt, 429, retryAfterSeconds(response.headers.get("retry-after")));
    if (!decision.retry) break;
    await wait(decision.waitMs);
  }
  if (provider === "openrouter") return interpretOpenRouter(modelId, lastStatus, lastBody, Date.now() - started);
  return failed(true, "تعذر رد المزود.", "PROVIDER_ERROR", Date.now() - started);
}

function interpretOpenRouter(modelId: string, status: number, body: unknown, completionMs: number): DispatchResult {
  if (status !== 200) return failed(true, providerFailure(status, body), "PROVIDER_ERROR", completionMs);
  const record = asRecord(body);
  const choice = Array.isArray(record?.choices) ? asRecord(record.choices[0]) : null;
  const message = asRecord(choice?.message);
  const text = messageText(message?.content);
  const returned = typeof record?.model === "string" ? record.model : null;
  const accepted = acceptReturnedModel(modelId, returned);
  if (!accepted.ok) return failed(true, "أعاد المزود معرفًا مختلفًا عن النموذج المختار.", "unexpected_model", completionMs);
  const finish = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  const usage = asRecord(record?.usage);
  const verdict = interpretFinish({ finishReason: finish, visibleText: text });
  return {
    attempted: true,
    status: verdict === "incomplete" ? "incomplete" : "completed",
    outputText: text,
    message: verdict === "incomplete" ? "انتهت ميزانية الإكمال قبل اكتمال النص الظاهر." : null,
    errorCode: null,
    providerModelId: accepted.displayModelId,
    finishReason: finish,
    promptTokens: numberOrNull(usage?.prompt_tokens),
    completionTokens: numberOrNull(usage?.completion_tokens),
    costUsd: null,
    completionMs,
  };
}

function interpretAnthropic(modelId: string, status: number, body: unknown, completionMs: number): DispatchResult {
  if (status !== 200) return failed(true, providerFailure(status, body), "ANTHROPIC_ERROR", completionMs);
  const record = asRecord(body);
  const returned = typeof record?.model === "string" ? record.model : null;
  if (returned && returned !== modelId) {
    return failed(true, "أعاد Anthropic معرفًا مختلفًا عن النموذج المختار.", "unexpected_model", completionMs);
  }
  const text = anthropicText(record?.content);
  const finish = typeof record?.stop_reason === "string" ? record.stop_reason : null;
  const usage = asRecord(record?.usage);
  const inputTokens = numberOrNull(usage?.input_tokens);
  const outputTokens = numberOrNull(usage?.output_tokens);
  const verdict = interpretFinish({ finishReason: finish, visibleText: text });
  const cost = inputTokens != null && outputTokens != null
    ? haikuCostUsd({
      inputTokens,
      outputTokens,
      cacheReadTokens: numberOrNull(usage?.cache_read_input_tokens) ?? undefined,
    })
    : null;
  return {
    attempted: true,
    status: verdict === "incomplete" ? "incomplete" : "completed",
    outputText: text,
    message: verdict === "incomplete" ? "انتهت ميزانية الإكمال قبل اكتمال النص الظاهر." : null,
    errorCode: null,
    providerModelId: modelId,
    finishReason: finish,
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    costUsd: cost,
    completionMs,
  };
}

function providerFailure(status: number, body: unknown): string {
  const record = asRecord(body);
  const error = asRecord(record?.error);
  const raw = typeof error?.message === "string" ? error.message : "";
  const detail = scrub(raw);
  if (status === 401 || status === 403) return "رفض المزود الطلب. تحقق من إعداد المفتاح على الخادم.";
  if (detail) return `تعذر رد المزود: ${detail}`;
  return "تعذر رد المزود.";
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const record = asRecord(part);
    return typeof record?.text === "string" ? record.text : "";
  }).join("");
}

function anthropicText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const record = asRecord(part);
    if (record?.type !== "text" || typeof record.text !== "string") return "";
    return record.text;
  }).join("");
}

function failed(
  attempted: boolean,
  message: string,
  errorCode: string,
  completionMs: number | null = null,
): DispatchResult {
  return {
    attempted,
    status: "failed",
    outputText: "",
    message,
    errorCode,
    providerModelId: null,
    finishReason: null,
    promptTokens: null,
    completionTokens: null,
    costUsd: null,
    completionMs,
  };
}

function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds;
  const when = Date.parse(header);
  if (!Number.isFinite(when)) return null;
  return Math.max(0, Math.ceil((when - Date.now()) / 1000));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function scrub(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 240);
}
