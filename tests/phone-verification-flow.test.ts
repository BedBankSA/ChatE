import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueChallenge, OTP_RESEND_COOLDOWN_SECONDS } from "@/domain/auth/otp";
import { signSession } from "@/domain/auth/session";
import { migrateDatabase, openDatabase } from "@/server/db/index";
import { resetRateLimits } from "@/server/guard";
import { insertChallenge, setVerifiedPhone } from "@/server/otp/service";
import { readPhoneHistoryForUser, readProfilePhone } from "@/server/phone/audit";

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }));

vi.mock("@/server/db/runtime", () => ({
  getDatabase: () => {
    if (!state.db) throw new Error("test database is not ready");
    return state.db;
  },
}));

const SECRET = "phone-flow-session-secret";
const PEPPER = "phone-flow-pepper";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PHONE = "+966501234567";
const OLD_PHONE = "+966500000001";
const NEW_PHONE = "+966555555555";
const PROVIDER_URL = "https://sms.test/send";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MIGRATIONS = path.join(process.cwd(), "migrations");

type JsonBody = {
  ok?: boolean;
  data?: {
    sent?: boolean;
    verified?: boolean;
    changed?: boolean;
    change?: boolean;
    expiresInSeconds?: number;
    cooldownSeconds?: number;
    targetPhone?: string;
  };
  error?: { message?: string; code?: string; remainingAttempts?: number; retryAfterSeconds?: number };
};

let providerCalls: { to: string; code: string }[] = [];
let turnstileSeq = 0;

function database(): DatabaseSync {
  if (!state.db) throw new Error("test database is not ready");
  return state.db;
}

function cookieFor(userId: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signSession({ userId, googleSub: userId, exp: nowSec + 600, csrf: "csrf", iat: nowSec }, SECRET);
  return "chate_session=" + token;
}

function post(pathname: string, body: Record<string, unknown>, userId: string): Request {
  return new Request("http://localhost:3211" + pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-host": "localhost",
      cookie: cookieFor(userId),
    },
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
        providerCalls.push({ to: String(sent.to ?? ""), code: String(sent.code ?? "") });
        return Response.json({ ok: true });
      }
      throw new Error("unexpected network call: " + url);
    }),
  );
}

function seedUser(id: string, name: string): void {
  database().prepare("INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)").run(
    id,
    "sub-" + id,
    id + "@example.com",
    name,
  );
  database().prepare("INSERT INTO profiles (user_id) VALUES (?)").run(id);
}

async function sendOtp(userId: string, phone: string) {
  const { POST } = await import("@/app/api/otp/send/route");
  const response = await POST(post("/api/otp/send", withTurnstile({ phone }), userId));
  const body = (await response.json()) as JsonBody;
  const last = providerCalls[providerCalls.length - 1];
  return { status: response.status, body, code: last?.code ?? "" };
}

async function verifyOtp(userId: string, code: unknown) {
  const { POST } = await import("@/app/api/otp/verify/route");
  const response = await POST(post("/api/otp/verify", { code }, userId));
  const body = (await response.json()) as JsonBody;
  return { status: response.status, body };
}

function actionsFor(userId: string): string[] {
  return readPhoneHistoryForUser(database(), userId, 50).map((row) => row.action);
}

beforeEach(() => {
  state.db = openDatabase(":memory:");
  migrateDatabase(database(), MIGRATIONS);
  seedUser(USER_A, "العميل أ");
  seedUser(USER_B, "العميل ب");
  providerCalls = [];
  turnstileSeq = 0;
  resetRateLimits();
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

describe("initial activation flow (new and stuck customers)", () => {
  it("sends the code, records INITIAL_ENTRY + OTP_SENT, then OTP_VERIFIED in one trail", async () => {
    const sent = await sendOtp(USER_A, "0501234567");
    expect(sent.status).toBe(200);
    expect(sent.body.data?.sent).toBe(true);
    expect(sent.body.data?.change).toBe(false);
    expect(sent.body.data?.targetPhone).toBe(PHONE);
    expect(sent.body.data?.expiresInSeconds).toBe(300);
    expect(sent.body.data?.cooldownSeconds).toBe(OTP_RESEND_COOLDOWN_SECONDS);
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.to).toBe(PHONE);

    const afterSend = readPhoneHistoryForUser(database(), USER_A, 10);
    expect(afterSend.map((row) => row.action)).toEqual(["OTP_SENT", "INITIAL_ENTRY"]);
    expect(afterSend[0]?.newPhone).toBe(PHONE);

    const verified = await verifyOtp(USER_A, sent.code);
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ ok: true, data: { verified: true }, error: null });
    expect(readProfilePhone(database(), USER_A)).toMatchObject({ phoneE164: PHONE });
    expect(actionsFor(USER_A)).toContain("OTP_VERIFIED");
    const verifiedRow = readPhoneHistoryForUser(database(), USER_A, 10).find((row) => row.action === "OTP_VERIFIED");
    expect(verifiedRow).toMatchObject({ newPhone: PHONE, phoneVerified: true, actorType: "user" });
  });

  it("records every wrong attempt in the permanent trail and still locks at five", async () => {
    const sent = await sendOtp(USER_A, PHONE);
    const wrong = sent.code === "000000" ? "000001" : "000000";
    const first = await verifyOtp(USER_A, wrong);
    expect(first.status).toBe(403);
    expect(first.body.error?.code).toBe("OTP_MISMATCH");
    expect(first.body.error?.remainingAttempts).toBe(4);
    const failed = readPhoneHistoryForUser(database(), USER_A, 10)[0];
    expect(failed?.action).toBe("FAILED_OTP_ATTEMPT");
    expect(JSON.parse(failed?.metadata ?? "{}")).toEqual({ attempts: 1 });
    for (let index = 0; index < 4; index += 1) await verifyOtp(USER_A, wrong);
    const locked = await verifyOtp(USER_A, sent.code);
    expect(locked.status).toBe(429);
    expect(locked.body.error?.code).toBe("OTP_ATTEMPTS");
    expect(actionsFor(USER_A).filter((action) => action === "FAILED_OTP_ATTEMPT")).toHaveLength(5);
  });
});

describe("phone change after verification", () => {
  beforeEach(() => {
    setVerifiedPhone(database(), USER_B, OLD_PHONE, new Date().toISOString());
  });

  it("sends to the new number, then swaps the verified phone and logs both change events", async () => {
    const sent = await sendOtp(USER_B, "0555555555");
    expect(sent.status).toBe(200);
    expect(sent.body.data?.change).toBe(true);
    expect(providerCalls[0]?.to).toBe(NEW_PHONE);
    const sentRow = readPhoneHistoryForUser(database(), USER_B, 10)[0];
    expect(sentRow).toMatchObject({ action: "OTP_SENT", oldPhone: OLD_PHONE, newPhone: NEW_PHONE });
    expect(JSON.parse(sentRow?.metadata ?? "{}").source).toBe("phone_change");

    const verified = await verifyOtp(USER_B, sent.code);
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ ok: true, data: { verified: true, changed: true }, error: null });
    expect(readProfilePhone(database(), USER_B)?.phoneE164).toBe(NEW_PHONE);
    const rows = readPhoneHistoryForUser(database(), USER_B, 20);
    const changed = rows.find((row) => row.action === "PHONE_CHANGED_BY_USER");
    expect(changed).toMatchObject({ oldPhone: OLD_PHONE, newPhone: NEW_PHONE, phoneVerified: true });
    expect(rows.some((row) => row.action === "OTP_VERIFIED" && row.newPhone === NEW_PHONE)).toBe(true);
  });

  it("never lets a customer claim a number verified by another account (send and race-safe verify)", async () => {
    setVerifiedPhone(database(), USER_A, PHONE, new Date().toISOString());
    const blockedSend = await sendOtp(USER_B, PHONE);
    expect(blockedSend.status).toBe(409);
    expect(blockedSend.body.error?.code).toBe("PHONE_TAKEN");
    expect(providerCalls).toHaveLength(0);

    // Simulate a challenge that already targets A's verified number (e.g. the
    // number was verified by A between B's send and B's verify).
    const challenge = issueChallenge("123456", PEPPER, Date.now(), null);
    insertChallenge(database(), { userId: USER_B, phoneE164: PHONE, challenge, now: Date.now() });
    const blockedVerify = await verifyOtp(USER_B, "123456");
    expect(blockedVerify.status).toBe(409);
    expect(blockedVerify.body.error?.code).toBe("PHONE_TAKEN");
    const failed = readPhoneHistoryForUser(database(), USER_B, 10)[0];
    expect(failed?.action).toBe("FAILED_OTP_ATTEMPT");
    expect(JSON.parse(failed?.metadata ?? "{}").reason).toBe("phone_taken");
    // The rejected challenge is not consumed, so the customer can edit the number.
    const stillActive = database()
      .prepare("SELECT consumed_at FROM otp_challenges WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(USER_B) as { consumed_at: string | null };
    expect(stillActive.consumed_at).toBeNull();
  });

  it("keeps the old no-op contract for a verified customer with no new phone", async () => {
    const { POST } = await import("@/app/api/otp/send/route");
    const response = await POST(post("/api/otp/send", withTurnstile({}), USER_B));
    const body = (await response.json()) as JsonBody;
    expect(response.status).toBe(200);
    expect(body.data).toEqual({ sent: false, verified: true });
  });
});

describe("carrier failure handling", () => {
  it("releases the reserved challenge and does not consume the send quota", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === SITEVERIFY) {
          return Response.json({ success: true, action: "otp", hostname: "localhost", challenge_ts: new Date().toISOString() });
        }
        return new Response("upstream down", { status: 500 });
      }),
    );
    const failed = await sendOtp(USER_A, PHONE);
    expect(failed.status).toBe(502);
    expect(failed.body.error?.code).toBe("OTP_PROVIDER");
    const rows = database().prepare("SELECT COUNT(*) AS n FROM otp_challenges").get() as { n: number };
    expect(rows.n).toBe(0);
    // A retry after the carrier recovers is not blocked by the failed attempt.
    installFetch();
    const retry = await sendOtp(USER_A, PHONE);
    expect(retry.status).toBe(200);
  });
});

describe("OTP send rate limits", () => {
  it("returns the remaining window as retryAfterSeconds after three sends", async () => {
    for (let index = 0; index < 3; index += 1) {
      const sent = await sendOtp(USER_A, PHONE);
      expect(sent.status).toBe(200);
    }
    const fourth = await sendOtp(USER_A, PHONE);
    expect(fourth.status).toBe(429);
    expect(fourth.body.error?.code).toBe("OTP_RESEND");
    expect(fourth.body.error?.retryAfterSeconds).toBeGreaterThan(0);
    expect(fourth.body.error?.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
    expect(providerCalls).toHaveLength(3);
  });
});
