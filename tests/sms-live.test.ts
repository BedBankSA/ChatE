import { readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashOtp } from "@/domain/auth/otp";
import { signSession } from "@/domain/auth/session";
import { migrateDatabase, openDatabase } from "@/server/db/index";

/**
 * LIVE SMS end-to-end proof. Skipped unless SMS_LIVE_TEST=1.
 *
 * One real SMS is sent through the configured Saudi gateway (4jawaly) to the
 * owner-approved number. The route stores the normalized E.164 phone, the code is
 * recovered by brute-forcing the stored peppered hash (1e6 SHA-256, local only),
 * and the verify route must mark the profile verified with "+966..." persisted.
 *
 * Run:  $env:SMS_LIVE_TEST=1; & 'C:\Pak\npm.cmd' exec -- vitest run tests/sms-live.test.ts
 * Never runs in normal npm test / CI (describe.skipIf).
 */

const LIVE = process.env.SMS_LIVE_TEST === "1";
const MIGRATIONS = path.join(process.cwd(), "migrations");
const USER_ID = "77777777-7777-4777-8777-777777777777";
const GOOGLE_SUB = "google-sub-sms-live";
const RAW_INPUT = "0564106506";
const E164 = "+966564106506";
const CSRF = "csrf-sms-live";

const dbState = vi.hoisted(() => ({ db: null as DatabaseSync | null }));

vi.mock("@/server/db/runtime", () => ({
  getDatabase: () => {
    if (!dbState.db) throw new Error("live test database is not ready");
    return dbState.db;
  },
}));

vi.mock("@/server/turnstile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/turnstile")>();
  return { ...actual, requireTurnstile: async () => undefined };
});

type Dotenv = Record<string, string>;

function loadDotenv(): Dotenv {
  const env: Dotenv = {};
  try {
    for (const line of readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index < 1) continue;
      env[trimmed.slice(0, index)] = trimmed.slice(index + 1);
    }
  } catch {
    // A missing file is reported by the explicit configuration assertions below.
  }
  return env;
}

const dotenv = LIVE ? loadDotenv() : {};

function config(name: string): string {
  const fromFile = dotenv[name]?.trim();
  if (fromFile) return fromFile;
  return (process.env[name] ?? "").trim();
}

function database(): DatabaseSync {
  if (!dbState.db) throw new Error("live test database is not ready");
  return dbState.db;
}

function sessionCookie(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signSession(
    { userId: USER_ID, googleSub: GOOGLE_SUB, exp: nowSec + 600, csrf: CSRF, iat: nowSec },
    config("SESSION_SECRET"),
  );
  return "chate_session=" + token;
}

function post(pathname: string, body: Record<string, unknown>): Request {
  return new Request("http://localhost:3211" + pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: sessionCookie(),
      origin: "http://localhost:3211",
    },
    body: JSON.stringify(body),
  });
}

/** Recover the six-digit code from the stored hash; the test owns the pepper. */
function recoverCode(hash: string, pepper: string): string {
  for (let value = 0; value <= 999_999; value += 1) {
    const code = String(value).padStart(6, "0");
    if (hashOtp(code, pepper) === hash) return code;
  }
  throw new Error("could not recover the stored OTP code from the hash");
}

describe.skipIf(!LIVE)("LIVE Saudi SMS gateway → OTP route → verified phone", () => {
  beforeAll(() => {
    expect(config("SMS_PROVIDER"), "SMS_PROVIDER missing (set it in .env.local)").not.toBe("");
    expect(config("SMS_API_KEY"), "SMS_API_KEY missing").not.toBe("");
    expect(config("SMS_SENDER_ID"), "SMS_SENDER_ID missing").not.toBe("");
    expect(config("SESSION_SECRET"), "SESSION_SECRET missing").not.toBe("");

    vi.stubEnv("NODE_ENV", "test");
    // Force the new SMS_* path (an existing OTP_PROVIDER would take precedence).
    vi.stubEnv("OTP_PROVIDER", "");
    vi.stubEnv("SMS_PROVIDER", config("SMS_PROVIDER"));
    vi.stubEnv("SMS_API_KEY", config("SMS_API_KEY"));
    vi.stubEnv("SMS_API_SECRET", config("SMS_API_SECRET"));
    vi.stubEnv("SMS_SENDER_ID", config("SMS_SENDER_ID"));
    vi.stubEnv("SMS_ENDPOINT", "");
    vi.stubEnv("OTP_PEPPER", config("OTP_PEPPER") || config("SESSION_SECRET"));
    vi.stubEnv("SESSION_SECRET", config("SESSION_SECRET"));
    vi.stubEnv("TURNSTILE_SECRET_KEY", "live-test-turnstile-secret");
    vi.stubEnv("TURNSTILE_EXPECTED_HOSTNAMES", "localhost");
    vi.stubEnv("APP_URL", "http://localhost:3211");

    dbState.db = openDatabase(":memory:");
    migrateDatabase(database(), MIGRATIONS);
    database()
      .prepare("INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)")
      .run(USER_ID, GOOGLE_SUB, "sms-live@example.com", "مستخدم اختبار");
    database().prepare("INSERT INTO profiles (user_id) VALUES (?)").run(USER_ID);
  }, 30_000);

  afterAll(() => {
    vi.unstubAllEnvs();
    if (dbState.db?.isOpen) dbState.db.close();
    dbState.db = null;
  });

  it("sends a real SMS for a free-form national number and verifies the E.164 phone", async () => {
    const { POST: sendOtp } = await import("@/app/api/otp/send/route");
    const sendResponse = await sendOtp(post("/api/otp/send", { phone: RAW_INPUT, "cf-turnstile-response": "qa.live.otp" }));
    const sendBody = (await sendResponse.json()) as { data?: { sent?: boolean }; error?: { code?: string; message?: string } };
    expect(sendResponse.status, JSON.stringify(sendBody)).toBe(200);
    expect(sendBody.data?.sent).toBe(true);

    const stored = database()
      .prepare("SELECT phone_e164, code_hash FROM otp_challenges ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get() as { phone_e164?: string; code_hash?: string } | undefined;
    expect(stored?.phone_e164).toBe(E164);
    expect(stored?.code_hash).toMatch(/^[0-9a-f]{64}$/);

    const pepper = config("OTP_PEPPER") || config("SESSION_SECRET");
    const code = recoverCode(stored?.code_hash ?? "", pepper);

    const { POST: verifyOtp } = await import("@/app/api/otp/verify/route");
    const verifyResponse = await verifyOtp(post("/api/otp/verify", { code }));
    const verifyBody = (await verifyResponse.json()) as { data?: { verified?: boolean }; error?: { code?: string; message?: string } };
    expect(verifyResponse.status, JSON.stringify(verifyBody)).toBe(200);
    expect(verifyBody.data?.verified).toBe(true);

    const profile = database()
      .prepare("SELECT phone_e164, phone_verified_at FROM profiles WHERE user_id = ?")
      .get(USER_ID) as { phone_e164?: string; phone_verified_at?: string } | undefined;
    expect(profile?.phone_e164).toBe(E164);
    expect(profile?.phone_verified_at).toBeTruthy();

    // Evidence line (no secret, phone masked): proves the live round-trip.
    console.log(
      "[sms-live] PASS: real SMS sent via " + config("SMS_PROVIDER") + " for raw '" + RAW_INPUT + "', stored " + E164 + ", code verified, profile verified_at=" + profile?.phone_verified_at,
    );
  }, 120_000);
});
