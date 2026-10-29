import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { otpProviderConfigured } from "@/domain/auth/model-gate";

/**
 * The model gate decides whether an unverified user is told "SMS is not wired"
 * (503 OTP_UNCONFIGURED) or "verify your phone" (403 profile_incomplete), so a
 * half-configured gateway must never open it. These env objects are plain
 * records, which keeps the assertion about the pure helper and not about the
 * process environment.
 */
const FOURJAWALY = {
  NODE_ENV: "production",
  SMS_PROVIDER: "4jawaly",
  SMS_API_KEY: "key",
  SMS_API_SECRET: "secret",
  SMS_SENDER_ID: "BedBank",
} as const;

const TAQNYAT = {
  NODE_ENV: "test",
  SMS_PROVIDER: "taqnyat",
  SMS_API_KEY: "token",
  SMS_SENDER_ID: "BedBank",
} as const;

const UNIFONIC = {
  NODE_ENV: "test",
  SMS_PROVIDER: "unifonic",
  SMS_API_KEY: "token",
  SMS_SENDER_ID: "BedBank",
} as const;

describe("otpProviderConfigured — SMS_PROVIDER gateways", () => {
  it("opens for a fully configured 4jawaly deployment", () => {
    expect(otpProviderConfigured({ ...FOURJAWALY })).toBe(true);
    // Production is exactly the case the gate must answer correctly: a real
    // provider with complete credentials is usable there.
    expect(otpProviderConfigured({ ...FOURJAWALY, NODE_ENV: "production" })).toBe(true);
  });

  it("stays closed for 4jawaly unless key, secret and sender are all present", () => {
    const incomplete = [
      { ...FOURJAWALY, SMS_API_KEY: undefined },
      { ...FOURJAWALY, SMS_API_SECRET: undefined },
      { ...FOURJAWALY, SMS_SENDER_ID: undefined },
      { ...FOURJAWALY, SMS_API_KEY: "   " },
      { ...FOURJAWALY, SMS_API_SECRET: " " },
      { ...FOURJAWALY, SMS_SENDER_ID: "" },
    ];
    for (const env of incomplete) expect(otpProviderConfigured(env), JSON.stringify(env)).toBe(false);
  });

  it("requires a key and a sender id for taqnyat and unifonic", () => {
    expect(otpProviderConfigured({ ...TAQNYAT })).toBe(true);
    expect(otpProviderConfigured({ ...UNIFONIC })).toBe(true);
    for (const provider of ["taqnyat", "unifonic"]) {
      expect(otpProviderConfigured({ NODE_ENV: "test", SMS_PROVIDER: provider })).toBe(false);
      expect(otpProviderConfigured({ NODE_ENV: "test", SMS_PROVIDER: provider, SMS_API_KEY: "token" })).toBe(false);
      expect(
        otpProviderConfigured({ NODE_ENV: "test", SMS_PROVIDER: provider, SMS_SENDER_ID: "BedBank" }),
      ).toBe(false);
    }
    // 4jawaly's secret is not part of the taqnyat/unifonic contract.
    expect(otpProviderConfigured({ ...TAQNYAT, SMS_API_SECRET: undefined })).toBe(true);
  });

  it("requires an endpoint for the generic gateway and accepts the legacy URL fallback", () => {
    expect(
      otpProviderConfigured({ NODE_ENV: "test", SMS_PROVIDER: "generic", SMS_ENDPOINT: "https://sms.example/send" }),
    ).toBe(true);
    expect(
      otpProviderConfigured({ NODE_ENV: "test", SMS_PROVIDER: "generic", OTP_HTTP_URL: "https://sms.example/send" }),
    ).toBe(true);
    expect(otpProviderConfigured({ NODE_ENV: "test", SMS_PROVIDER: "generic" })).toBe(false);
    expect(
      otpProviderConfigured({ NODE_ENV: "test", SMS_PROVIDER: "generic", SMS_ENDPOINT: " ", OTP_HTTP_URL: "" }),
    ).toBe(false);
  });

  it("rejects a missing, blank or unknown SMS_PROVIDER", () => {
    expect(otpProviderConfigured({ NODE_ENV: "test" })).toBe(false);
    expect(otpProviderConfigured({ NODE_ENV: "test", SMS_PROVIDER: "" })).toBe(false);
    expect(otpProviderConfigured({ NODE_ENV: "test", SMS_PROVIDER: "   " })).toBe(false);
    expect(otpProviderConfigured({ NODE_ENV: "test", SMS_PROVIDER: "twilio" })).toBe(false);
  });

  it("counts the dev mock only outside production", () => {
    expect(otpProviderConfigured({ NODE_ENV: "test", SMS_PROVIDER: "mock" })).toBe(true);
    expect(otpProviderConfigured({ NODE_ENV: "development", SMS_PROVIDER: "mock" })).toBe(true);
    // A blank/unset NODE_ENV is treated as production (fail closed), exactly
    // like the adapter: the dev mock is never assumed usable there.
    expect(otpProviderConfigured({ SMS_PROVIDER: "mock" })).toBe(false);
    expect(otpProviderConfigured({ NODE_ENV: "", SMS_PROVIDER: "mock" })).toBe(false);
    expect(otpProviderConfigured({ NODE_ENV: "   ", SMS_PROVIDER: "mock" })).toBe(false);
    expect(otpProviderConfigured({ NODE_ENV: "production", SMS_PROVIDER: "mock" })).toBe(false);
  });

  it("normalizes provider case and whitespace like the adapter", () => {
    expect(otpProviderConfigured({ ...FOURJAWALY, SMS_PROVIDER: " 4Jawaly " })).toBe(true);
    expect(otpProviderConfigured({ ...TAQNYAT, SMS_PROVIDER: " TAQNYAT " })).toBe(true);
  });
});

describe("otpProviderConfigured — legacy OTP_PROVIDER compatibility", () => {
  it("keeps the historical http + URL behavior", () => {
    expect(
      otpProviderConfigured({ OTP_PROVIDER: "http", OTP_HTTP_URL: "https://sms.example/send" }),
    ).toBe(true);
    expect(otpProviderConfigured({ OTP_PROVIDER: "http" })).toBe(false);
    expect(otpProviderConfigured({ OTP_PROVIDER: "http", OTP_HTTP_URL: "   " })).toBe(false);
  });

  it("gives a non-empty legacy provider precedence over SMS_PROVIDER", () => {
    expect(
      otpProviderConfigured({
        NODE_ENV: "test",
        OTP_PROVIDER: "http",
        OTP_HTTP_URL: "https://sms.example/send",
        SMS_PROVIDER: "mock",
      }),
    ).toBe(true);
    // Legacy http without its URL stays closed even when SMS_* is complete:
    // the adapter would also fail closed on the legacy branch.
    expect(
      otpProviderConfigured({
        NODE_ENV: "production",
        OTP_PROVIDER: "http",
        OTP_HTTP_URL: "",
        SMS_PROVIDER: "4jawaly",
        SMS_API_KEY: "key",
        SMS_API_SECRET: "secret",
        SMS_SENDER_ID: "BedBank",
      }),
    ).toBe(false);
  });

  it("keeps the legacy fake stub outside the configured gate, as before", () => {
    // The old gate only accepted OTP_PROVIDER=http; fake is a local-only stub.
    expect(otpProviderConfigured({ NODE_ENV: "development", OTP_PROVIDER: "fake" })).toBe(false);
    expect(otpProviderConfigured({ NODE_ENV: "test", OTP_PROVIDER: "fake" })).toBe(false);
    expect(otpProviderConfigured({ NODE_ENV: "production", OTP_PROVIDER: "fake" })).toBe(false);
  });

  it("rejects an unknown legacy provider instead of falling through", () => {
    expect(
      otpProviderConfigured({ NODE_ENV: "test", OTP_PROVIDER: "sendgrid", SMS_PROVIDER: "mock" }),
    ).toBe(false);
  });

  it("falls through to SMS_PROVIDER when OTP_PROVIDER is blank", () => {
    expect(otpProviderConfigured({ NODE_ENV: "test", OTP_PROVIDER: "", SMS_PROVIDER: "mock" })).toBe(true);
    expect(otpProviderConfigured({ NODE_ENV: "test", OTP_PROVIDER: "   ", SMS_PROVIDER: "mock" })).toBe(true);
  });

  it("normalizes legacy case and whitespace like the adapter", () => {
    expect(otpProviderConfigured({ OTP_PROVIDER: " HTTP ", OTP_HTTP_URL: "https://sms.example/send" })).toBe(
      true,
    );
  });
});

describe("model-gate module purity", () => {
  it("never imports from src/server", () => {
    // The gate runs in the profile server component and the comparison handler;
    // it must stay a pure domain module so no transport/provider code leaks in.
    const source = readFileSync(path.join(process.cwd(), "src/domain/auth/model-gate.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']@\/server\//);
  });
});
