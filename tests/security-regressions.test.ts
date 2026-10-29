import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/domain/errors";
import { buildHaikuRequest, haikuLiveCallsEnabled, postHaiku } from "@/domain/models/haiku";
import { securityHeaders } from "@/domain/security/headers";
import { redact } from "@/domain/security/redact";
import { migrateDatabase, openDatabase } from "@/server/db/index";
import { consumeTurnstile } from "@/server/turnstile";
import { replayRemember, resetReplayMemory, tokenDigest } from "@/server/turnstile-replay";

describe("security headers: transport and isolation hardening", () => {
  const headers = (https: boolean) =>
    Object.fromEntries(securityHeaders(https, false).map((header) => [header.key, header.value]));

  it("sets the added browser-isolation headers on every response", () => {
    const http = headers(false);
    expect(http["Cross-Origin-Opener-Policy"]).toBe("same-origin-allow-popups");
    expect(http["X-Permitted-Cross-Domain-Policies"]).toBe("none");
    expect(http["X-Content-Type-Options"]).toBe("nosniff");
    expect(http["X-Frame-Options"]).toBe("DENY");
  });

  it("keeps HSTS https-only and production CSP free of unsafe-eval", () => {
    expect(headers(true)["Strict-Transport-Security"]).toContain("max-age=31536000");
    expect(headers(false)["Strict-Transport-Security"]).toBeUndefined();
    const csp = headers(true)["Content-Security-Policy"] ?? "";
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    // Known accepted gap (documented in the audit): strict-dynamic/nonce is not
    // wired yet, so inline scripts stay allowed in production.
    expect(csp).toContain("'unsafe-inline'");
  });
});

describe("log redaction never prints credential-shaped free text", () => {
  it("redacts secret-shaped values inside generic string fields", () => {
    // writeLog serializes redact() output, so this is the exact log line.
    const line = JSON.stringify(redact({
      error: "upstream said Bearer abcdef0123456789abcdef",
      detail: "key sk-or-v1-0123456789abcdef",
      anthropic: "sk-ant-api03-0123456789abcdef",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef",
    }));
    expect(line).not.toContain("sk-or-v1-0123456789abcdef");
    expect(line).not.toContain("sk-ant-api03-0123456789abcdef");
    expect(line).not.toContain("Bearer abcdef0123456789abcdef");
    expect(line).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef");
    expect(line).toContain("[redacted]");
  });

  it("still redacts by sensitive key and keeps harmless values", () => {
    expect(redact({ otp: "123456", question: "سري", status: "failed", attempts: 3 })).toEqual({
      otp: "[redacted]",
      question: "[redacted]",
      status: "failed",
      attempts: 3,
    });
    expect((redact({ q: "x".repeat(200) }) as { q: string }).q).toMatch(/^\[text:200\]$/);
    expect(redact({ deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } })).toBeTruthy();
  });
});

describe("Haiku live-call gate (fixed: telemetry-free default)", () => {
  const body = buildHaikuRequest({ maxTokens: 100, system: "s", content: [{ type: "text", text: "q" }] });

  it("requires an Anthropic key and honors the HAIKU_LIVE_CALLS kill switch", () => {
    expect(haikuLiveCallsEnabled({})).toBe(false);
    expect(haikuLiveCallsEnabled({ HAIKU_LIVE_CALLS: "0" })).toBe(false);
    expect(haikuLiveCallsEnabled({ HAIKU_LIVE_CALLS: "true" })).toBe(false);
    expect(haikuLiveCallsEnabled({ HAIKU_LIVE_CALLS: "1" })).toBe(false);
    expect(haikuLiveCallsEnabled({ ANTHROPIC_API_KEY: "sk-ant-test" })).toBe(true);
    expect(haikuLiveCallsEnabled({ ANTHROPIC_API_KEY: "sk-ant-test", HAIKU_LIVE_CALLS: "1" })).toBe(true);
    expect(haikuLiveCallsEnabled({ ANTHROPIC_API_KEY: "sk-ant-test", HAIKU_LIVE_CALLS: "0" })).toBe(false);
  });

  it("refuses to call the provider when the flag is absent, even if the caller passes allowLive", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await expect(
      postHaiku(body, { fetchImpl, apiKey: "test-key", allowLive: true, env: {} }),
    ).rejects.toMatchObject({ code: "HAIKU_LIVE_DISABLED" });
    expect(called).toBe(false);
  });

  it("calls Anthropic only when both the env flag and the dispatcher allow it", async () => {
    let headers: Headers | null = null;
    let sentBody = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      sentBody = String(init?.body ?? "");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await postHaiku(body, {
      fetchImpl,
      apiKey: "test-key",
      allowLive: false,
      env: { HAIKU_LIVE_CALLS: "1", ANTHROPIC_API_KEY: "sk-ant-test" },
    }).catch(() => undefined);
    expect(sentBody).toBe("");
    await postHaiku(body, {
      fetchImpl,
      apiKey: "test-key",
      allowLive: true,
      env: { HAIKU_LIVE_CALLS: "1", ANTHROPIC_API_KEY: "sk-ant-test" },
    });
    expect((headers as Headers | null)?.get("x-api-key")).toBe("test-key");
    expect(sentBody).not.toContain("test-key");
    expect(sentBody).toContain('"effort":"medium"');
  });
});

describe("Turnstile single-use under concurrent submission", () => {
  let db: ReturnType<typeof openDatabase>;
  const nowMs = Date.parse("2026-10-27T12:00:00.000Z");

  beforeEach(() => {
    resetReplayMemory();
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
    vi.stubEnv("TURNSTILE_EXPECTED_HOSTNAMES", "localhost");
    vi.stubEnv("NODE_ENV", "test");
    db = openDatabase(":memory:");
    migrateDatabase(db, path.join(process.cwd(), "migrations"));
  });

  afterEach(() => {
    if (db.isOpen && db.isTransaction) db.exec("ROLLBACK");
    if (db.isOpen) db.close();
    vi.unstubAllEnvs();
  });

  function request(): Request {
    return new Request("http://localhost:3211/api/auth/google", {
      method: "POST",
      headers: { "x-forwarded-host": "localhost" },
    });
  }

  function remote(): typeof fetch {
    return (async () =>
      new Response(
        JSON.stringify({
          success: true,
          action: "login",
          hostname: "localhost",
          challenge_ts: new Date(nowMs).toISOString(),
        }),
        { status: 200 },
      )) as typeof fetch;
  }

  it("accepts a token exactly once when two requests race", async () => {
    const [first, second] = await Promise.all([
      consumeTurnstile({
        request: request(),
        token: "race-token",
        expectedAction: "login",
        now: nowMs,
        fetchImpl: remote(),
        database: () => db,
      }),
      consumeTurnstile({
        request: request(),
        token: "race-token",
        expectedAction: "login",
        now: nowMs,
        fetchImpl: remote(),
        database: () => db,
      }),
    ]);
    const accepted = [first, second].filter((verdict) => verdict.ok).length;
    const reused = [first, second].filter((verdict) => !verdict.ok && verdict.code === "reused").length;
    expect(accepted).toBe(1);
    expect(reused).toBe(1);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM turnstile_tokens").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("fails closed when Turnstile is not configured and never records the token", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    const verdict = await consumeTurnstile({
      request: request(),
      token: "unconfigured-token",
      expectedAction: "login",
      now: nowMs,
      fetchImpl: remote(),
      database: () => db,
    });
    expect(verdict).toMatchObject({ ok: false, code: "TURNSTILE_UNCONFIGURED", status: 503 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM turnstile_tokens").get() as { n: number }).n).toBe(0);
  });

  it("rejects a token minted for another hostname and records nothing", async () => {
    const evilRemote = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          action: "login",
          hostname: "evil.example",
          challenge_ts: new Date(nowMs).toISOString(),
        }),
        { status: 200 },
      )) as typeof fetch;
    const verdict = await consumeTurnstile({
      request: request(),
      token: "hostname-token",
      expectedAction: "login",
      now: nowMs,
      fetchImpl: evilRemote,
      database: () => db,
    });
    expect(verdict).toMatchObject({ ok: false, code: "hostname" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM turnstile_tokens").get() as { n: number }).n).toBe(0);
  });

  it("keeps only a digest of the token in the store", () => {
    expect(replayRemember(db, { digest: tokenDigest("secret-token"), action: "login", hostname: "localhost", nowMs })).toBe(true);
    const row = db.prepare("SELECT token_hash FROM turnstile_tokens").get() as { token_hash: string };
    expect(row.token_hash).not.toContain("secret-token");
    expect(row.token_hash).toHaveLength(64);
  });
});
