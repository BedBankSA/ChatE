import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OTP_TTL_MS, hashOtp, issueChallenge } from "@/domain/auth/otp";
import { SAUDI_MOBILE_INVALID_MESSAGE } from "@/domain/auth/saudi-phone";
import { signSession } from "@/domain/auth/session";
import { migrateDatabase, openDatabase } from "@/server/db/index";
import { insertChallenge, latestAnyChallenge, latestChallenge, setVerifiedPhone } from "@/server/otp/service";

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }));

vi.mock("@/server/db/runtime", () => ({
  getDatabase: () => {
    if (!state.db) throw new Error("test database is not ready");
    return state.db;
  },
}));

const SECRET = "route-test-session-secret";
const PEPPER = "route-test-otp-pepper";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const GOOGLE_SUB = "google-sub-otp";
const PHONE = "+966501234567";
const PROVIDER_URL = "https://sms.test/send";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MIGRATIONS = path.join(process.cwd(), "migrations");

type JsonBody = {
  ok?: boolean;
  data?: { sent?: boolean; verified?: boolean; expiresInSeconds?: number };
  error?: { message?: string; code?: string; remainingAttempts?: number };
};

let providerCodes: { to: string; code: string }[] = [];
let turnstileSeq = 0;

function database(): DatabaseSync {
  if (!state.db) throw new Error("test database is not ready");
  return state.db;
}

function sessionCookie(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signSession(
    { userId: USER_ID, googleSub: GOOGLE_SUB, exp: nowSec + 600, csrf: "csrf-otp", iat: nowSec },
    SECRET,
  );
  return "chate_session=" + token;
}

function post(pathname: string, body: Record<string, unknown>, anonymous = false): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-host": "localhost",
  };
  if (!anonymous) headers.cookie = sessionCookie();
  return new Request("http://localhost:3211" + pathname, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function withTurnstile(body: Record<string, unknown>): Record<string, unknown> {
  turnstileSeq += 1;
  return { ...body, "cf-turnstile-response": "turnstile-token-" + turnstileSeq };
}

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === SITEVERIFY) {
        return Response.json({
          success: true,
          action: "otp",
          hostname: "localhost",
          challenge_ts: new Date().toISOString(),
        });
      }
      if (url === PROVIDER_URL) {
        const sent = JSON.parse(String(init?.body ?? "{}")) as { to?: unknown; code?: unknown };
        providerCodes.push({ to: String(sent.to ?? ""), code: String(sent.code ?? "") });
        return Response.json({ ok: true });
      }
      throw new Error("unexpected network call: " + url);
    }),
  );
}

function seedUser(): void {
  database()
    .prepare("INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)")
    .run(USER_ID, GOOGLE_SUB, "otp@example.com", "مستخدم");
  database().prepare("INSERT INTO profiles (user_id) VALUES (?)").run(USER_ID);
}

async function sendOtp(phone: string = PHONE, anonymous = false) {
  const { POST } = await import("@/app/api/otp/send/route");
  const response = await POST(post("/api/otp/send", withTurnstile({ phone }), anonymous));
  const body = (await response.json()) as JsonBody;
  const last = providerCodes[providerCodes.length - 1];
  return { status: response.status, body, code: last?.code ?? "" };
}

async function verifyOtp(code: unknown, anonymous = false) {
  const { POST } = await import("@/app/api/otp/verify/route");
  const response = await POST(post("/api/otp/verify", { code }, anonymous));
  const body = (await response.json()) as JsonBody;
  return { status: response.status, body };
}

beforeEach(() => {
  state.db = openDatabase(":memory:");
  migrateDatabase(database(), MIGRATIONS);
  seedUser();
  providerCodes = [];
  turnstileSeq = 0;
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("OTP_PEPPER", PEPPER);
  vi.stubEnv("OTP_PROVIDER", "http");
  vi.stubEnv("OTP_HTTP_URL", PROVIDER_URL);
  vi.stubEnv("OTP_HTTP_AUTHORIZATION", "Bearer test");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
  vi.stubEnv("TURNSTILE_EXPECTED_HOSTNAMES", "localhost");
  vi.stubEnv("APP_URL", "http://localhost:3211");
  vi.stubEnv("NODE_ENV", "test");
  installFetch();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (state.db && state.db.isOpen) state.db.close();
  state.db = null;
});

describe("POST /api/otp/send", () => {
  it("rejects an anonymous caller before Turnstile", async () => {
    const result = await sendOtp(PHONE, true);
    expect(result.status).toBe(401);
    expect(result.body.error?.code).toBe("anonymous");
    expect(providerCodes).toHaveLength(0);
  });

  it("rejects a signed session whose stored account is gone", async () => {
    // Session validation is bound to the users row (security-redteam hardening):
    // a deleted account fails closed as anonymous before the profile check runs.
    database().prepare("DELETE FROM profiles").run();
    database().prepare("DELETE FROM users").run();
    const result = await sendOtp();
    expect(result.status).toBe(401);
    expect(result.body.error?.code).toBe("anonymous");
    expect(providerCodes).toHaveLength(0);
  });

  it("fails closed when no SMS provider is configured", async () => {
    vi.stubEnv("OTP_PROVIDER", "");
    const result = await sendOtp();
    expect(result.status).toBe(503);
    expect(result.body.error?.code).toBe("OTP_FAIL_CLOSED");
    expect(providerCodes).toHaveLength(0);
  });

  it("accepts a national-only phone number and sends the normalized E.164", async () => {
    // Free-form national input is the primary customer path: the normalizer adds
    // +966 and the legacy gateway receives the stored E.164, not the raw input.
    const result = await sendOtp("0501234567");
    expect(result.status).toBe(200);
    expect(result.body.data?.sent).toBe(true);
    expect(providerCodes).toHaveLength(1);
    expect(providerCodes[0]?.to).toBe(PHONE);
    expect(providerCodes[0]?.code).toMatch(/^\d{6}$/);
    expect(latestAnyChallenge(database(), USER_ID)?.phoneE164).toBe(PHONE);
  });

  it("rejects a foreign number with 422 OTP_PHONE and the normalizer message", async () => {
    const result = await sendOtp("+12025550143");
    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe("OTP_PHONE");
    expect(result.body.error?.message).toBe(SAUDI_MOBILE_INVALID_MESSAGE);
    expect(providerCodes).toHaveLength(0);
  });

  it("enforces the recurring 15-minute send cap from the database", async () => {
    const now = Date.now() - 1_000;
    for (let index = 0; index < 3; index += 1) {
      const challenge = issueChallenge("123456", PEPPER, now + index, null);
      insertChallenge(database(), { userId: USER_ID, phoneE164: PHONE, challenge, now: now + index });
    }
    const result = await sendOtp();
    expect(result.status).toBe(429);
    expect(result.body.error?.code).toBe("OTP_RESEND");
    expect(providerCodes).toHaveLength(0);
  });

  it("persists a hashed challenge and never returns the code", async () => {
    const result = await sendOtp();
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.error).toBeNull();
    expect(result.body.data?.sent).toBe(true);
    expect(result.body.data?.expiresInSeconds).toBe(OTP_TTL_MS / 1000);
    expect(providerCodes).toHaveLength(1);
    const sent = providerCodes[0];
    expect(sent?.to).toBe(PHONE);
    expect(sent?.code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(result.body)).not.toContain(sent?.code ?? "unreachable");

    const stored = latestAnyChallenge(database(), USER_ID);
    expect(stored?.phoneE164).toBe(PHONE);
    expect(stored?.challenge.codeHash).toBe(hashOtp(sent?.code ?? "", PEPPER));
    expect(stored?.challenge.codeHash).not.toBe(sent?.code);
    expect(stored?.challenge.consumed).toBe(false);
  });

  it("no-ops for an already verified phone without calling the provider", async () => {
    setVerifiedPhone(database(), USER_ID, PHONE, new Date().toISOString());
    const result = await sendOtp();
    expect(result.status).toBe(200);
    expect(result.body.data?.sent).toBe(false);
    expect(result.body.data?.verified).toBe(true);
    expect(providerCodes).toHaveLength(0);
  });
});

describe("POST /api/otp/verify", () => {
  it("rejects anonymous callers and malformed codes", async () => {
    const anonymous = await verifyOtp("123456", true);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error?.code).toBe("anonymous");

    const malformed = await verifyOtp("12");
    expect(malformed.status).toBe(422);
    expect(malformed.body.error?.code).toBe("OTP_CODE");

    const nonString = await verifyOtp(123456);
    expect(nonString.status).toBe(422);
  });

  it("verifies the code, sets phone_verified_at and consumes the challenge", async () => {
    const sent = await sendOtp();
    expect(sent.status).toBe(200);
    const verified = await verifyOtp(sent.code);
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ ok: true, data: { verified: true }, error: null });

    const row = database()
      .prepare("SELECT phone_e164, phone_verified_at FROM profiles WHERE user_id = ?")
      .get(USER_ID) as { phone_e164: string; phone_verified_at: string };
    expect(row.phone_e164).toBe(PHONE);
    expect(Number.isFinite(Date.parse(row.phone_verified_at))).toBe(true);
    expect(latestAnyChallenge(database(), USER_ID)?.challenge.consumed).toBe(true);

    const reused = await verifyOtp(sent.code);
    expect(reused.status).toBe(403);
    expect(reused.body.error?.code).toBe("OTP_MISSING");

    const again = await sendOtp();
    expect(again.status).toBe(200);
    expect(again.body.data?.sent).toBe(false);
    expect(again.body.data?.verified).toBe(true);
    expect(providerCodes).toHaveLength(1);
  });

  it("counts wrong attempts, reports remaining tries and locks at five", async () => {
    const sent = await sendOtp();
    const wrong = sent.code === "000000" ? "000001" : "000000";
    const first = await verifyOtp(wrong);
    expect(first.status).toBe(403);
    expect(first.body.error?.code).toBe("OTP_MISMATCH");
    expect(first.body.error?.remainingAttempts).toBe(4);
    expect(latestChallenge(database(), USER_ID)?.challenge.attempts).toBe(1);

    for (let index = 0; index < 3; index += 1) {
      const next = await verifyOtp(wrong);
      expect(next.status).toBe(403);
    }
    expect(latestChallenge(database(), USER_ID)?.challenge.attempts).toBe(4);

    const fifth = await verifyOtp(wrong);
    expect(fifth.status).toBe(429);
    expect(fifth.body.error?.code).toBe("OTP_ATTEMPTS");

    const locked = await verifyOtp(sent.code);
    expect(locked.status).toBe(429);
    expect(locked.body.error?.code).toBe("OTP_ATTEMPTS");
  });

  it("rejects an expired challenge without consuming it", async () => {
    const past = Date.now() - OTP_TTL_MS - 5_000;
    const challenge = issueChallenge("654321", PEPPER, past, null);
    insertChallenge(database(), { userId: USER_ID, phoneE164: PHONE, challenge, now: past });

    const result = await verifyOtp("654321");
    expect(result.status).toBe(403);
    expect(result.body.error?.code).toBe("OTP_EXPIRED");
    const stored = latestAnyChallenge(database(), USER_ID);
    expect(stored?.challenge.consumed).toBe(false);
    expect(stored?.challenge.attempts).toBe(0);
  });
});
