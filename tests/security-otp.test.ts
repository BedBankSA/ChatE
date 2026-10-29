import { describe, expect, it, vi } from "vitest";
import {
  FakeOtpProvider,
  HttpOtpProvider,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_SENDS,
  OTP_TTL_MS,
  OTP_WINDOW_MS,
  createOtpProvider,
  hashOtp,
  issueChallenge,
  verifyChallenge,
  type OtpChallenge,
} from "@/domain/auth/otp";
import { AppError } from "@/domain/errors";
import { otpPepper } from "@/server/otp/config";

const PEPPER = "test-otp-pepper";

function challenge(patch: Partial<OtpChallenge> = {}): OtpChallenge {
  return { ...issueChallenge("123456", PEPPER, 1_000, null), ...patch };
}

describe("OTP challenge hashing and lifetime", () => {
  it("stores only a peppered hash, never the code", () => {
    const hash = hashOtp("123456", PEPPER);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain("123456");
    expect(hash).not.toBe(hashOtp("123456", "other-pepper"));
    expect(hash).toBe(hashOtp("123456", PEPPER));
  });

  it("expires after the documented TTL", () => {
    const issued = challenge();
    const expired = verifyChallenge(issued, "123456", PEPPER, issued.expiresAt + 1);
    expect(expired).toMatchObject({ ok: false, reason: "expired" });
    expect(expired.challenge.consumed).toBe(false);
    expect(OTP_TTL_MS).toBe(5 * 60 * 1000);
  });
});

describe("OTP verification limits", () => {
  it("accepts the right code once and never twice", () => {
    const issued = challenge();
    const first = verifyChallenge(issued, "123456", PEPPER, 1_100);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.challenge.consumed).toBe(true);
    expect(verifyChallenge(first.challenge, "123456", PEPPER, 1_200)).toMatchObject({
      ok: false,
      reason: "consumed",
    });
  });

  it("counts every wrong attempt and locks at the maximum", () => {
    let current = challenge();
    for (let attempt = 1; attempt <= OTP_MAX_ATTEMPTS; attempt += 1) {
      const result = verifyChallenge(current, "000000", PEPPER, 1_100 + attempt);
      expect(result.ok).toBe(false);
      expect(result.challenge.attempts).toBe(attempt);
      current = result.challenge;
    }
    expect(verifyChallenge(current, "123456", PEPPER, 1_200)).toMatchObject({
      ok: false,
      reason: "attempts",
    });
  });

  it("does not leak whether the code or the challenge state was wrong", () => {
    const result = verifyChallenge(challenge({ attempts: OTP_MAX_ATTEMPTS }), "123456", PEPPER, 1_100);
    expect(result).toMatchObject({ ok: false, reason: "attempts" });
  });
});

describe("OTP resend window", () => {
  it("blocks a fourth send inside the 15-minute window", () => {
    let previous = challenge({ sendCount: OTP_MAX_SENDS, windowStartedAt: 1_000 });
    expect(() => issueChallenge("654321", PEPPER, 1_000 + OTP_WINDOW_MS - 1, previous)).toThrow(AppError);
    expect(previous.sendCount).toBe(OTP_MAX_SENDS);
  });

  it("starts a fresh window and counter after it elapses", () => {
    const previous = challenge({ sendCount: OTP_MAX_SENDS, windowStartedAt: 1_000 });
    const next = issueChallenge("654321", PEPPER, 1_000 + OTP_WINDOW_MS + 1, previous);
    expect(next.sendCount).toBe(1);
    expect(next.windowStartedAt).toBe(1_000 + OTP_WINDOW_MS + 1);
  });

  it("increments the send counter for a resend inside the window", () => {
    const first = issueChallenge("111111", PEPPER, 1_000, null);
    const second = issueChallenge("222222", PEPPER, 2_000, first);
    expect(second.sendCount).toBe(2);
    expect(second.windowStartedAt).toBe(1_000);
  });
});

describe("OTP provider configuration fails closed", () => {
  it("refuses the fake provider in production", () => {
    expect(() =>
      createOtpProvider({ nodeEnv: "production", provider: "fake", httpUrl: "https://sms.example" }),
    ).toThrow(AppError);
    expect(() =>
      createOtpProvider({ nodeEnv: "production", provider: "http", httpUrl: "" }),
    ).toThrow(AppError);
  });

  it("uses the fake provider only outside production", () => {
    expect(createOtpProvider({ nodeEnv: "development", provider: "fake", httpUrl: undefined })).toBeInstanceOf(
      FakeOtpProvider,
    );
    expect(() =>
      createOtpProvider({ nodeEnv: "development", provider: "unset", httpUrl: undefined }),
    ).toThrow(AppError);
  });

  it("posts the code only to the configured HTTP provider, with authorization", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
      url = String(input);
      init = requestInit;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    // The factory is asserted separately: it rejects an unconfigured provider.
    expect(
      createOtpProvider({
        nodeEnv: "production",
        provider: "http",
        httpUrl: "https://sms.example/send",
        httpAuthorization: "Bearer provider-token",
      }),
    ).toBeInstanceOf(HttpOtpProvider);
    const provider = new HttpOtpProvider("https://sms.example/send", "Bearer provider-token", fetchImpl);
    await provider.send({ to: "+966501234567", code: "123456" });
    expect(url).toBe("https://sms.example/send");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer provider-token");
    expect(String(init?.body)).toBe(JSON.stringify({ to: "+966501234567", code: "123456" }));
    expect(String(init?.body)).not.toContain("Bearer provider-token");
  });

  it("maps provider failures to a 502 without echoing the provider body", async () => {
    const provider = new HttpOtpProvider(
      "https://sms.example/send",
      "",
      (async () =>
        new Response(JSON.stringify({ error: "secret upstream detail" }), { status: 500 })) as typeof fetch,
    );
    await expect(provider.send({ to: "+966501234567", code: "123456" })).rejects.toMatchObject({
      code: "OTP_PROVIDER",
      statusCode: 502,
    });
  });
});

describe("OTP pepper configuration", () => {
  it("prefers a dedicated pepper and falls back to the session secret", () => {
    expect(otpPepper({ OTP_PEPPER: "dedicated", SESSION_SECRET: "session" })).toBe("dedicated");
    expect(otpPepper({ SESSION_SECRET: "session" })).toBe("session");
  });

  it("fails closed when neither value is configured", () => {
    expect(() => otpPepper({})).toThrow(AppError);
    vi.stubEnv("OTP_PEPPER", "");
    vi.stubEnv("SESSION_SECRET", "");
    try {
      expect(() => otpPepper()).toThrow(AppError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
