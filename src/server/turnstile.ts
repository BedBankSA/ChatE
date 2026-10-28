import type { DatabaseSync } from "node:sqlite";
import { verifyTurnstileRequest } from "@/domain/auth/turnstile";
import { AppError } from "@/domain/errors";
import { replayRemember, replaySeen, tokenDigest } from "@/server/turnstile-replay";

export type TurnstileVerdict = { ok: true } | { ok: false; code: string; status: number; message: string };

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

function safeDatabase(provider: (() => DatabaseSync | undefined) | undefined): DatabaseSync | undefined {
  if (!provider) return undefined;
  try {
    return provider();
  } catch {
    // A store failure degrades to the bounded in-process replay guard.
    return undefined;
  }
}

/** Consumes one verified token. Returns the failure instead of throwing so callers can shape the HTTP error. */
export async function consumeTurnstile(input: {
  request: Request;
  token: unknown;
  expectedAction: string;
  fetchImpl?: typeof fetch;
  now?: number;
  database?: () => DatabaseSync | undefined;
}): Promise<TurnstileVerdict> {
  const rawToken = typeof input.token === "string" ? input.token : "";
  const now = input.now ?? Date.now();
  const hostname = requestHostname(input.request);
  const db = rawToken ? safeDatabase(input.database) : undefined;
  const digest = rawToken ? tokenDigest(rawToken) : "";
  const alreadyUsed = rawToken ? replaySeen(db, digest, now) : false;
  const verdict = await verifyTurnstileRequest({
    token: input.token,
    expectedAction: input.expectedAction,
    requestHostname: hostname,
    expectedHostnames: turnstileHostnames(),
    secret: process.env.TURNSTILE_SECRET_KEY,
    nodeEnv: process.env.NODE_ENV ?? "development",
    now,
    remoteIp: requestClientIp(input.request),
    alreadyUsed,
    fetchImpl: input.fetchImpl ?? fetch,
  });
  if (!verdict.ok) return verdict;
  const remembered = replayRemember(db, {
    digest: tokenDigest(verdict.token),
    action: input.expectedAction,
    hostname,
    nowMs: now,
  });
  if (!remembered) {
    return { ok: false, code: "reused", status: 403, message: "انتهت صلاحية التحقق. أعد المحاولة." };
  }
  return { ok: true };
}

export async function requireTurnstile(input: {
  request: Request;
  token: unknown;
  expectedAction: string;
  fetchImpl?: typeof fetch;
  now?: number;
  database?: () => DatabaseSync | undefined;
}): Promise<void> {
  const verdict = await consumeTurnstile(input);
  if (!verdict.ok) throw new AppError(verdict.message, verdict.code, verdict.status);
}
