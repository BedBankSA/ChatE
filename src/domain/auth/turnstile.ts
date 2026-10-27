import { AppError } from "@/domain/errors";

export const TURNSTILE_TTL_MS = 5 * 60 * 1000;
export const TURNSTILE_SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileRemote = {
  success: boolean;
  action?: string;
  hostname?: string;
  challenge_ts?: string;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function assertTurnstileConfig(input: {
  nodeEnv: string;
  secret: string | undefined;
  hostnames: string[];
}): void {
  if (!input.secret) throw new AppError("تحقق Turnstile غير مهيأ", "TURNSTILE_UNCONFIGURED", 503);
  if (input.nodeEnv === "production" && input.hostnames.some((host) => LOCAL_HOSTS.has(host.split(":")[0] ?? host))) {
    throw new AppError("نطاقات الإنتاج لا تشمل الجهاز المحلي", "TURNSTILE_LOCALHOST", 503);
  }
}

export function evaluateTurnstile(input: {
  token: string | null;
  expectedAction: string;
  requestHostname: string;
  expectedHostnames: string[];
  now: number;
  remote: TurnstileRemote | null;
  alreadyUsed: boolean;
}): { ok: true } | { ok: false; code: string } {
  if (!input.token) return { ok: false, code: "missing" };
  if (!input.expectedHostnames.includes(input.requestHostname)) return { ok: false, code: "hostname" };
  if (!input.remote?.success) return { ok: false, code: "remote" };
  if (input.remote.action !== input.expectedAction) return { ok: false, code: "action" };
  if (!input.remote.hostname || !input.expectedHostnames.includes(input.remote.hostname)) {
    return { ok: false, code: "hostname" };
  }
  if (input.alreadyUsed) return { ok: false, code: "reused" };
  if (!input.remote.challenge_ts) return { ok: false, code: "expired" };
  const issued = Date.parse(input.remote.challenge_ts);
  if (!Number.isFinite(issued) || input.now - issued > TURNSTILE_TTL_MS || issued - input.now > 60_000) {
    return { ok: false, code: "expired" };
  }
  return { ok: true };
}

export type TurnstileFailure = { ok: false; code: string; status: number; message: string };

const RETRY_MESSAGE = "تعذر التحقق الأمني. أعد المحاولة.";

export function turnstileTokenProblem(token: unknown): "missing" | "shape" | null {
  if (typeof token !== "string" || token.length === 0) return "missing";
  if (token.length > 2048) return "shape";
  return null;
}

export function readTurnstileToken(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined;
  return (body as Record<string, unknown>)["cf-turnstile-response"];
}

export async function siteverify(input: {
  secret: string | undefined;
  token: string;
  remoteIp?: string;
  fetchImpl: typeof fetch;
}): Promise<TurnstileRemote & { "error-codes"?: string[] }> {
  if (!input.secret) throw new AppError("تحقق Turnstile غير مهيأ", "TURNSTILE_UNCONFIGURED", 503);
  const problem = turnstileTokenProblem(input.token);
  if (problem) throw new AppError(RETRY_MESSAGE, "TURNSTILE_TOKEN", 403);
  const body = new URLSearchParams({ secret: input.secret, response: input.token });
  if (input.remoteIp) body.set("remoteip", input.remoteIp);
  let response: Response;
  try {
    response = await input.fetchImpl(TURNSTILE_SITEVERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AppError("تعذر الاتصال بخدمة التحقق. أعد المحاولة.", "TURNSTILE_REMOTE", 403);
  }
  if (!response.ok) throw new AppError("تعذر الاتصال بخدمة التحقق. أعد المحاولة.", "TURNSTILE_REMOTE", 403);
  return (await response.json()) as TurnstileRemote & { "error-codes"?: string[] };
}

export async function verifyTurnstileRequest(input: {
  token: unknown;
  expectedAction: string;
  requestHostname: string;
  expectedHostnames: string[];
  secret: string | undefined;
  nodeEnv: string;
  now: number;
  remoteIp?: string;
  alreadyUsed: boolean;
  fetchImpl: typeof fetch;
}): Promise<{ ok: true; token: string } | TurnstileFailure> {
  try {
    assertTurnstileConfig({
      nodeEnv: input.nodeEnv,
      secret: input.secret,
      hostnames: input.expectedHostnames,
    });
  } catch (error) {
    if (error instanceof AppError) return { ok: false, code: error.code, status: error.statusCode, message: error.message };
    return { ok: false, code: "TURNSTILE_UNCONFIGURED", status: 503, message: "تحقق Turnstile غير مهيأ" };
  }
  if (input.expectedHostnames.length === 0) {
    return { ok: false, code: "TURNSTILE_HOSTS", status: 503, message: "نطاقات التحقق غير مهيأة" };
  }
  const problem = turnstileTokenProblem(input.token);
  if (problem === "missing" || problem === "shape") {
    return { ok: false, code: problem, status: 403, message: RETRY_MESSAGE };
  }
  if (input.alreadyUsed) return { ok: false, code: "reused", status: 403, message: "انتهت صلاحية التحقق. أعد المحاولة." };
  const token = input.token as string;
  let remote: TurnstileRemote & { "error-codes"?: string[] };
  try {
    remote = await siteverify({
      secret: input.secret,
      token,
      remoteIp: input.remoteIp,
      fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    if (error instanceof AppError) return { ok: false, code: error.code, status: error.statusCode, message: error.message };
    return { ok: false, code: "TURNSTILE_REMOTE", status: 403, message: "تعذر الاتصال بخدمة التحقق. أعد المحاولة." };
  }
  if (remote["error-codes"]?.includes("timeout-or-duplicate")) {
    return { ok: false, code: "reused", status: 403, message: "انتهت صلاحية التحقق. أعد المحاولة." };
  }
  const verdict = evaluateTurnstile({
    token,
    expectedAction: input.expectedAction,
    requestHostname: input.requestHostname,
    expectedHostnames: input.expectedHostnames,
    now: input.now,
    remote,
    alreadyUsed: false,
  });
  if (!verdict.ok) return { ok: false, code: verdict.code, status: 403, message: RETRY_MESSAGE };
  return { ok: true, token };
}
