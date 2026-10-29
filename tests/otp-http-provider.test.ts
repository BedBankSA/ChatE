import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postOtpSend } from "@/app/api/otp/send/route";
import { POST as postOtpVerify } from "@/app/api/otp/verify/route";
import {
  FakeOtpProvider,
  HttpOtpProvider,
  OTP_HTTP_TIMEOUT_MS,
  createOtpProvider,
  isLoopbackOtpHost,
  validateOtpHttpUrl,
} from "@/domain/auth/otp";
import { signSession } from "@/domain/auth/session";
import { AppError } from "@/domain/errors";
import { migrateDatabase, openDatabase } from "@/server/db/index";
import { resetRateLimits } from "@/server/guard";

const dbState = vi.hoisted(() => ({ db: null as DatabaseSync | null }));

vi.mock("@/server/db/runtime", () => ({
  getDatabase: () => {
    if (!dbState.db) throw new Error("test database is not ready");
    return dbState.db;
  },
}));

/**
 * Turnstile is the only gate bypassed in this file: a unit test has no Cloudflare
 * secret and must not reach the network. Everything OTP-specific below (send
 * route -> HttpOtpProvider -> real loopback HTTP server -> verify route -> SQLite)
 * runs for real, with the real global fetch. No fetch mock is installed.
 */
vi.mock("@/server/turnstile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/turnstile")>();
  return { ...actual, requireTurnstile: async () => undefined };
});

const MIGRATIONS = path.join(process.cwd(), "migrations");
const SECRET = "otp-http-route-secret";
const PEPPER = "otp-http-route-pepper";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const GOOGLE_SUB = "google-sub-otp-http";
const PHONE = "+966501234567";
const STUB_AUTH = "Bearer local-stub-secret";

type StubMessage = { to: string; code: string; at: string; authorization?: string };

type StubServer = {
  url: string;
  host: string;
  port: number;
  logPath: string;
  received: StubMessage[];
  close: () => Promise<void>;
};

type StubOptions = {
  host?: string;
  port?: number;
  auth?: string;
  logPath?: string;
  delayMs?: number;
  failStatus?: number;
  redirectLocation?: string;
};

type StubModule = {
  startOtpStub: (options?: StubOptions) => Promise<StubServer>;
};

type JsonBody = {
  ok?: boolean;
  data?: { sent?: boolean; verified?: boolean; expiresInSeconds?: number };
  error?: { message?: string; code?: string; remainingAttempts?: number };
};

let stubModule: StubModule;
let stubs: StubServer[] = [];
let tempDirs: string[] = [];

beforeAll(async () => {
  // The in-process stub is the same file a developer runs from the CLI, so the
  // tests exercise the shipped receiver logic instead of a parallel copy.
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "scripts", "dev", "otp-provider-stub.mjs")).href;
  stubModule = (await import(/* @vite-ignore */ moduleUrl)) as StubModule;
});

async function startStub(options: StubOptions = {}): Promise<StubServer> {
  const dir = mkdtempSync(path.join(tmpdir(), "chate-otp-http-"));
  tempDirs.push(dir);
  const stub = await stubModule.startOtpStub({ port: 0, logPath: path.join(dir, "otp-codes.jsonl"), ...options });
  stubs.push(stub);
  return stub;
}

function readCapturedCodes(stub: StubServer): { to: string; code: string; at: string }[] {
  return readFileSync(stub.logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { to: string; code: string; at: string });
}

async function expectProviderFailure(action: () => Promise<void>): Promise<AppError> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  const appError = caught as AppError;
  expect(appError).toMatchObject({ code: "OTP_PROVIDER", statusCode: 502 });
  return appError;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  const running = stubs;
  stubs = [];
  for (const stub of running) await stub.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  resetRateLimits();
  if (dbState.db?.isOpen) dbState.db.close();
  dbState.db = null;
});

describe("provider endpoint policy fails closed", () => {
  it("accepts https everywhere and plain http only on loopback outside production", () => {
    expect(validateOtpHttpUrl(" https://sms.example/send ", "production")).toBe("https://sms.example/send");
    expect(validateOtpHttpUrl("http://127.0.0.1:3999/", "development")).toBe("http://127.0.0.1:3999/");
    expect(validateOtpHttpUrl("http://localhost:3999/", "test")).toBe("http://localhost:3999/");
    expect(validateOtpHttpUrl("http://[::1]:3999/", "test")).toBe("http://[::1]:3999/");
    expect(isLoopbackOtpHost("localhost")).toBe(true);
    expect(isLoopbackOtpHost("127.0.0.1")).toBe(true);
    expect(isLoopbackOtpHost("sms.example")).toBe(false);
  });

  it("rejects empty, malformed, credentialed and non-loopback plain-http URLs", () => {
    const rejected: [string | undefined, string][] = [
      [undefined, "development"],
      ["", "development"],
      ["   ", "production"],
      ["not a url", "development"],
      ["ftp://sms.example/send", "development"],
      ["http://sms.example/send", "development"],
      ["http://127.0.0.1:3999/", "production"],
      ["https://user:pass@sms.example/send", "production"],
    ];
    for (const [url, nodeEnv] of rejected) {
      let caught: unknown;
      try {
        validateOtpHttpUrl(url, nodeEnv);
      } catch (error) {
        caught = error;
      }
      expect(caught, String(url)).toBeInstanceOf(AppError);
      expect(caught).toMatchObject({ code: "OTP_FAIL_CLOSED", statusCode: 503 });
    }
  });

  it("keeps production on the real HTTP provider and never falls back to fake", () => {
    expect(() =>
      createOtpProvider({ nodeEnv: "production", provider: "fake", httpUrl: "https://sms.example/send" }),
    ).toThrow(AppError);
    expect(() => createOtpProvider({ nodeEnv: "production", provider: "http", httpUrl: "" })).toThrow(AppError);
    expect(() =>
      createOtpProvider({ nodeEnv: "production", provider: "http", httpUrl: "http://127.0.0.1:3999/" }),
    ).toThrow(AppError);
    expect(
      createOtpProvider({ nodeEnv: "production", provider: "http", httpUrl: "https://sms.example/send" }),
    ).toBeInstanceOf(HttpOtpProvider);
    expect(createOtpProvider({ nodeEnv: "development", provider: "fake", httpUrl: undefined })).toBeInstanceOf(
      FakeOtpProvider,
    );
    expect(
      createOtpProvider({ nodeEnv: "development", provider: "http", httpUrl: "http://127.0.0.1:3999/" }),
    ).toBeInstanceOf(HttpOtpProvider);
    expect(() => createOtpProvider({ nodeEnv: "development", provider: "http", httpUrl: "" })).toThrow(AppError);
    expect(() => createOtpProvider({ nodeEnv: "development", provider: undefined, httpUrl: undefined })).toThrow(
      AppError,
    );
  });

  it("documents a ten second provider deadline", () => {
    expect(OTP_HTTP_TIMEOUT_MS).toBe(10_000);
  });
});

describe("HttpOtpProvider over real loopback HTTP", () => {
  it("delivers the code to a real HTTP server and appends it to the JSONL capture", async () => {
    const stub = await startStub({ auth: STUB_AUTH });
    const provider = createOtpProvider({
      nodeEnv: "test",
      provider: "http",
      httpUrl: stub.url,
      httpAuthorization: STUB_AUTH,
    });
    expect(provider).toBeInstanceOf(HttpOtpProvider);

    await provider.send({ to: PHONE, code: "123456" });

    expect(stub.received).toHaveLength(1);
    expect(stub.received[0]).toMatchObject({ to: PHONE, code: "123456", authorization: STUB_AUTH });
    const captured = readCapturedCodes(stub);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ to: PHONE, code: "123456" });
    expect(Number.isFinite(Date.parse(captured[0]?.at ?? ""))).toBe(true);
  });

  it("stores no Authorization header when the deployment has none", async () => {
    const stub = await startStub();
    const provider = new HttpOtpProvider(stub.url, "", fetch, { nodeEnv: "test" });
    await provider.send({ to: PHONE, code: "654321" });
    expect(stub.received).toHaveLength(1);
    expect(stub.received[0]?.authorization).toBeUndefined();
  });

  it("fails as an opaque 502 when the gateway rejects the Authorization header", async () => {
    const stub = await startStub({ auth: STUB_AUTH });
    const provider = new HttpOtpProvider(stub.url, "Bearer wrong-token", fetch, { nodeEnv: "test" });
    const error = await expectProviderFailure(() => provider.send({ to: PHONE, code: "123456" }));
    // The gateway body ("unauthorized") and the code must never be echoed.
    expect(error.message).not.toContain("unauthorized");
    expect(error.message).not.toContain("123456");
    expect(stub.received).toHaveLength(0);
  });

  it("maps a non-2xx gateway response to the same opaque 502", async () => {
    const stub = await startStub({ failStatus: 500 });
    const provider = new HttpOtpProvider(stub.url, "", fetch, { nodeEnv: "test" });
    const error = await expectProviderFailure(() => provider.send({ to: PHONE, code: "123456" }));
    expect(error.message).toBe("تعذر إرسال رمز التحقق");
    expect(error.message).not.toContain("stub_forced_failure");
    expect(stub.received).toHaveLength(0);
  });

  it("aborts a stalled gateway at the configured deadline", async () => {
    const stub = await startStub({ delayMs: 250 });
    const provider = new HttpOtpProvider(stub.url, "", fetch, { nodeEnv: "test", timeoutMs: 50 });
    const started = Date.now();
    await expectProviderFailure(() => provider.send({ to: PHONE, code: "123456" }));
    expect(Date.now() - started).toBeLessThan(2_000);
    // The server finishes its (already-aborted) request; wait for the capture so
    // the temp directory cleanup below cannot race the log write.
    await vi.waitFor(() => expect(stub.received).toHaveLength(1));
  });

  it("fails closed when the gateway is unreachable", async () => {
    const stub = await startStub();
    const deadUrl = stub.url;
    await stub.close();
    const provider = new HttpOtpProvider(deadUrl, "", fetch, { nodeEnv: "test" });
    await expectProviderFailure(() => provider.send({ to: PHONE, code: "123456" }));
  });

  it("refuses to follow a gateway redirect instead of replaying the code", async () => {
    const target = await startStub();
    const redirecting = await startStub({ redirectLocation: target.url });
    const provider = new HttpOtpProvider(redirecting.url, "", fetch, { nodeEnv: "test" });
    await expectProviderFailure(() => provider.send({ to: PHONE, code: "123456" }));
    expect(target.received).toHaveLength(0);
  });

  it("never calls the network for a payload outside the provider contract", async () => {
    const stub = await startStub();
    const provider = new HttpOtpProvider(stub.url, "", fetch, { nodeEnv: "test" });
    await expectProviderFailure(() => provider.send({ to: "0501234567", code: "123456" }));
    await expectProviderFailure(() => provider.send({ to: PHONE, code: "12" }));
    expect(stub.received).toHaveLength(0);
  });
});

function database(): DatabaseSync {
  if (!dbState.db) throw new Error("test database is not ready");
  return dbState.db;
}

function seedUser(): void {
  database()
    .prepare("INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)")
    .run(USER_ID, GOOGLE_SUB, "otp-http@example.com", "مستخدم");
  database().prepare("INSERT INTO profiles (user_id) VALUES (?)").run(USER_ID);
}

function postRequest(pathname: string, body: Record<string, unknown>): Request {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signSession(
    { userId: USER_ID, googleSub: GOOGLE_SUB, exp: nowSec + 600, csrf: "csrf-otp-http", iat: nowSec },
    SECRET,
  );
  return new Request("http://localhost:3211" + pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-host": "localhost",
      cookie: "chate_session=" + token,
    },
    body: JSON.stringify(body),
  });
}

async function callRoute(
  handler: (request: Request) => Promise<Response>,
  pathname: string,
  body: Record<string, unknown>,
): Promise<{ status: number; text: string; body: JsonBody }> {
  const response = await handler(postRequest(pathname, body));
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as JsonBody };
}

describe("full OTP send -> provider -> verify over real loopback HTTP", () => {
  let primaryStub: StubServer;

  beforeEach(async () => {
    resetRateLimits();
    dbState.db = openDatabase(":memory:");
    migrateDatabase(database(), MIGRATIONS);
    seedUser();
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("OTP_PEPPER", PEPPER);
    vi.stubEnv("OTP_PROVIDER", "http");
    vi.stubEnv("OTP_HTTP_AUTHORIZATION", STUB_AUTH);
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
    vi.stubEnv("TURNSTILE_EXPECTED_HOSTNAMES", "localhost");
    vi.stubEnv("NODE_ENV", "test");
    primaryStub = await startStub({ auth: STUB_AUTH });
    vi.stubEnv("OTP_HTTP_URL", primaryStub.url);
  });

  it("delivers a real HTTP request, verifies the captured code and persists phone_verified_at", async () => {
    const sent = await callRoute(postOtpSend, "/api/otp/send", {
      phone: PHONE,
      "cf-turnstile-response": "local-unit-turnstile-token",
    });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, data: { sent: true, expiresInSeconds: 300 }, error: null });

    // The real loopback server received exactly one genuine HTTP request.
    expect(primaryStub.received).toHaveLength(1);
    const delivered = primaryStub.received[0];
    expect(delivered?.to).toBe(PHONE);
    expect(delivered?.code).toMatch(/^\d{6}$/);
    expect(delivered?.authorization).toBe(STUB_AUTH);
    expect(sent.text).not.toContain(delivered?.code ?? "unreachable");

    const wrongCode = delivered?.code === "000000" ? "111111" : "000000";
    const wrong = await callRoute(postOtpVerify, "/api/otp/verify", { code: wrongCode });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toMatchObject({ code: "OTP_MISMATCH", remainingAttempts: 4 });

    const verified = await callRoute(postOtpVerify, "/api/otp/verify", { code: delivered?.code });
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ ok: true, data: { verified: true }, error: null });

    const row = database()
      .prepare("SELECT phone_e164, phone_verified_at FROM profiles WHERE user_id = ?")
      .get(USER_ID) as { phone_e164: string | null; phone_verified_at: string | null };
    expect(row.phone_e164).toBe(PHONE);
    expect(Number.isFinite(Date.parse(row.phone_verified_at ?? ""))).toBe(true);

    // The verified profile needs no second SMS; no extra HTTP request is made.
    const again = await callRoute(postOtpSend, "/api/otp/send", {
      phone: PHONE,
      "cf-turnstile-response": "local-unit-turnstile-token-2",
    });
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ sent: false, verified: true });
    expect(primaryStub.received).toHaveLength(1);
  });

  it("fails the route with an opaque 502 when the real gateway rejects the request", async () => {
    const rejecting = await startStub({ auth: "Bearer expected-by-gateway" });
    vi.stubEnv("OTP_HTTP_URL", rejecting.url);
    vi.stubEnv("OTP_HTTP_AUTHORIZATION", "Bearer wrong-from-app");

    const sent = await callRoute(postOtpSend, "/api/otp/send", {
      phone: PHONE,
      "cf-turnstile-response": "local-unit-turnstile-token",
    });
    expect(sent.status).toBe(502);
    expect(sent.body.error?.code).toBe("OTP_PROVIDER");
    expect(rejecting.received).toHaveLength(0);
    expect(primaryStub.received).toHaveLength(0);
    // No provider detail and no OTP code may appear in the response body.
    expect(sent.text).not.toContain("unauthorized");
    expect(sent.text).not.toMatch(/\d{6}/);
  });
});
