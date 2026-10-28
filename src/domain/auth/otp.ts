import { createHash, timingSafeEqual } from "node:crypto";
import { AppError } from "@/domain/errors";

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_SENDS = 3;
export const OTP_WINDOW_MS = 15 * 60 * 1000;

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

export class HttpOtpProvider implements OtpProvider {
  readonly name = "http";
  constructor(
    private readonly url: string,
    private readonly authorization: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(input: { to: string; code: string }): Promise<void> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.authorization ? { authorization: this.authorization } : {}),
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new AppError("تعذر إرسال رمز التحقق", "OTP_PROVIDER", 502);
  }
}

export function createOtpProvider(env: {
  nodeEnv: string;
  provider: string | undefined;
  httpUrl: string | undefined;
  httpAuthorization?: string;
}): OtpProvider {
  if (env.nodeEnv === "production") {
    if (env.provider !== "http" || !env.httpUrl) {
      throw new AppError("مزود الرسائل غير مهيأ", "OTP_FAIL_CLOSED", 503);
    }
    return new HttpOtpProvider(env.httpUrl, env.httpAuthorization ?? "");
  }
  if (env.provider === "fake") return new FakeOtpProvider();
  if (env.provider === "http" && env.httpUrl) return new HttpOtpProvider(env.httpUrl, env.httpAuthorization ?? "");
  throw new AppError("مزود الرسائل غير مهيأ", "OTP_FAIL_CLOSED", 503);
}
