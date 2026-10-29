import { createHash, timingSafeEqual } from "node:crypto";
import { AppError } from "@/domain/errors";

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_SENDS = 3;
export const OTP_WINDOW_MS = 15 * 60 * 1000;

/**
 * Browser resend countdown. The server enforces the real 3-per-15-minutes cap
 * from SQLite; this is the recommended wait before offering the button again, so
 * a customer is not told "wait" with no number attached.
 */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/**
 * Per-target-phone ceiling inside the window, across accounts. The per-user cap
 * alone would still let many accounts steer SMS at one victim number; this caps
 * that abuse and the carrier bill.
 */
export const OTP_MAX_SENDS_PER_PHONE = 5;

export type OtpChallenge = {
  codeHash: string;
  expiresAt: number;
  attempts: number;
  sendCount: number;
  windowStartedAt: number;
  consumed: boolean;
};

export type OtpProvider = {
  readonly name: string;
  send(input: { to: string; code: string }): Promise<void>;
};

export function hashOtp(code: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}:${code}`).digest("hex");
}

export function issueChallenge(code: string, pepper: string, now: number, previous: OtpChallenge | null): OtpChallenge {
  if (previous && now - previous.windowStartedAt < OTP_WINDOW_MS && previous.sendCount >= OTP_MAX_SENDS) {
    throw new AppError("تجاوزت حد إعادة الإرسال", "OTP_RESEND", 429);
  }
  const sameWindow = previous && now - previous.windowStartedAt < OTP_WINDOW_MS;
  return {
    codeHash: hashOtp(code, pepper),
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    sendCount: sameWindow ? previous.sendCount + 1 : 1,
    windowStartedAt: sameWindow ? previous.windowStartedAt : now,
    consumed: false,
  };
}

export function verifyChallenge(
  challenge: OtpChallenge,
  code: string,
  pepper: string,
  now: number,
): { ok: true; challenge: OtpChallenge } | { ok: false; reason: string; challenge: OtpChallenge } {
  if (challenge.consumed) return { ok: false, reason: "consumed", challenge };
  if (now > challenge.expiresAt) return { ok: false, reason: "expired", challenge };
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "attempts", challenge };
  const next = { ...challenge, attempts: challenge.attempts + 1 };
  const actual = Buffer.from(hashOtp(code, pepper));
  const expected = Buffer.from(challenge.codeHash);
  const match = actual.length === expected.length && timingSafeEqual(actual, expected);
  if (!match) return { ok: false, reason: "mismatch", challenge: next };
  return { ok: true, challenge: { ...next, consumed: true } };
}

export class FakeOtpProvider implements OtpProvider {
  readonly name = "fake";
  readonly sent: { to: string; code: string }[] = [];
  async send(input: { to: string; code: string }): Promise<void> {
    this.sent.push(input);
  }
}

/** Deadline for one carrier gateway call; a stalled gateway must not pin a request. */
export const OTP_HTTP_TIMEOUT_MS = 10_000;

const OTP_CODE_PATTERN = /^\d{6}$/;
const OTP_E164_PATTERN = /^\+[1-9]\d{6,14}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Configuration problems fail closed (503) so a broken deployment sends nothing. */
function otpConfigError(): AppError {
  return new AppError("مزود الرسائل غير مهيأ", "OTP_FAIL_CLOSED", 503);
}

/**
 * One opaque provider failure (502) for every gateway outcome. The route answers
 * the browser with its own fixed Arabic message, and the gateway response body,
 * request id or carrier error text is never copied into an error, a response or
 * a log line.
 */
function otpProviderError(): AppError {
  return new AppError("تعذر إرسال رمز التحقق", "OTP_PROVIDER", 502);
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

export function isLoopbackOtpHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
}

/**
 * Validates the SMS gateway endpoint before any code can leave the process. The
 * code-bearing request must travel over TLS in every real deployment; plain http
 * is allowed only for a loopback host outside production (the local dev stub).
 * Empty, malformed and credential-bearing URLs fail closed as configuration
 * errors, so a misconfigured deployment never starts hashing codes it cannot
 * deliver.
 */
export function validateOtpHttpUrl(raw: string | undefined, nodeEnv: string): string {
  const candidate = raw?.trim() ?? "";
  if (!candidate) throw otpConfigError();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw otpConfigError();
  }
  // Credentials belong in OTP_HTTP_AUTHORIZATION, never in a URL that a proxy,
  // an error page or a stack trace could print.
  if (url.username || url.password) throw otpConfigError();
  if (url.protocol === "https:") return url.href;
  if (url.protocol === "http:" && nodeEnv !== "production" && isLoopbackOtpHost(url.hostname)) return url.href;
  throw otpConfigError();
}

export type HttpOtpProviderOptions = {
  /** Per-request deadline; defaults to OTP_HTTP_TIMEOUT_MS. Injectable for tests. */
  timeoutMs?: number;
  /** Environment used for the URL policy; defaults to the running process. */
  nodeEnv?: string;
};

export class HttpOtpProvider implements OtpProvider {
  readonly name = "http";
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(
    url: string,
    private readonly authorization: string,
    private readonly fetchImpl: typeof fetch = fetch,
    options: HttpOtpProviderOptions = {},
  ) {
    this.url = validateOtpHttpUrl(url, options.nodeEnv ?? process.env.NODE_ENV ?? "development");
    const timeoutMs = options.timeoutMs ?? OTP_HTTP_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw otpConfigError();
    this.timeoutMs = timeoutMs;
  }

  async send(input: { to: string; code: string }): Promise<void> {
    // Defense in depth: the route validates both values, so a payload outside
    // the documented contract is a programming error and must not hit the wire.
    if (!OTP_E164_PATTERN.test(input.to) || !OTP_CODE_PATTERN.test(input.code)) throw otpProviderError();
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        // Never follow a redirect: an OTP code must not be replayed to a Location
        // chosen by a misconfigured or compromised gateway.
        redirect: "error",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          ...(this.authorization ? { authorization: this.authorization } : {}),
        },
        body: JSON.stringify({ to: input.to, code: input.code }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // DNS/connect failure, deadline or a refused redirect. The original error
      // is dropped so no provider or network detail can reach the caller.
      throw otpProviderError();
    }
    // The gateway body is never trusted or surfaced; discard it on both paths so
    // a large or streaming body cannot exhaust memory or keep a socket open.
    await discardBody(response);
    if (!response.ok) throw otpProviderError();
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that already errored needs no cleanup; the status still decides.
  }
}

export function createOtpProvider(env: {
  nodeEnv: string;
  provider: string | undefined;
  httpUrl: string | undefined;
  httpAuthorization?: string;
}): OtpProvider {
  if (env.nodeEnv === "production") {
    // The fake provider is development-only, and a missing or plain-http endpoint
    // is a deployment bug: both fail closed instead of falling back to a stub.
    if (env.provider !== "http") throw otpConfigError();
    return new HttpOtpProvider(env.httpUrl ?? "", env.httpAuthorization ?? "", fetch, { nodeEnv: env.nodeEnv });
  }
  if (env.provider === "fake") return new FakeOtpProvider();
  if (env.provider === "http") {
    return new HttpOtpProvider(env.httpUrl ?? "", env.httpAuthorization ?? "", fetch, { nodeEnv: env.nodeEnv });
  }
  throw otpConfigError();
}