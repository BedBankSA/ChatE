import { verifyTurnstileRequest } from "@/domain/auth/turnstile";
import { AppError } from "@/domain/errors";

const usedTokens = new Set<string>();

function hostnameOf(value: string | null): string {
  return (value ?? "").split(",")[0]?.trim().split(":")[0]?.toLowerCase() ?? "";
}

export function requestHostname(request: Request): string {
  return hostnameOf(request.headers.get("x-forwarded-host") ?? request.headers.get("host"));
}

export function requestClientIp(request: Request): string | undefined {
  const cloudflare = request.headers.get("cf-connecting-ip")?.trim();
  if (cloudflare) return cloudflare;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || undefined;
}

export function turnstileHostnames(): string[] {
  return (process.env.TURNSTILE_EXPECTED_HOSTNAMES ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

export async function requireTurnstile(input: {
  request: Request;
  token: unknown;
  expectedAction: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<void> {
  const token = typeof input.token === "string" ? input.token : "";
  const verdict = await verifyTurnstileRequest({
    token: input.token,
    expectedAction: input.expectedAction,
    requestHostname: requestHostname(input.request),
    expectedHostnames: turnstileHostnames(),
    secret: process.env.TURNSTILE_SECRET_KEY,
    nodeEnv: process.env.NODE_ENV ?? "development",
    now: input.now ?? Date.now(),
    remoteIp: requestClientIp(input.request),
    alreadyUsed: token.length > 0 && usedTokens.has(token),
    fetchImpl: input.fetchImpl ?? fetch,
  });
  if (!verdict.ok) throw new AppError(verdict.message, verdict.code, verdict.status);
  usedTokens.add(verdict.token);
}
