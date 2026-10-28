import { createHmac } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSession, signSession, type SessionPayload } from "@/domain/auth/session";
import { securityHeaders } from "@/domain/security/headers";
import { migrateDatabase, openDatabase } from "@/server/db/index";
import { consumeTurnstile } from "@/server/turnstile";
import { replayRemember, replaySeen, resetReplayMemory, tokenDigest } from "@/server/turnstile-replay";

const secret = "test-session-secret";
const now = 1_700_000_000;

function signRaw(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function validPayload(patch: Partial<SessionPayload> = {}): SessionPayload {
  return { userId: "user-1", googleSub: "sub-1", exp: now + 600, csrf: "csrf-1", iat: now, ...patch };
}

describe("session token validation", () => {
  it("accepts a signed token with the expected payload shape", () => {
    expect(readSession(signSession(validPayload(), secret), secret, now)).toEqual(validPayload());
  });

  it("rejects expired, overlong and malformed expiry values", () => {
    expect(readSession(signSession(validPayload({ exp: now - 1 }), secret), secret, now)).toBeNull();
    expect(readSession(signSession(validPayload({ exp: now + 400 * 24 * 60 * 60 + 60 }), secret), secret, now)).toBeNull();
    expect(readSession(signRaw({ ...validPayload(), exp: String(now + 600) }), secret, now)).toBeNull();
    expect(readSession(signRaw({ ...validPayload(), exp: Number.POSITIVE_INFINITY }), secret, now)).toBeNull();
    expect(readSession(signRaw({ ...validPayload(), exp: undefined }), secret, now)).toBeNull();
  });

  it("rejects missing or non-string identity fields", () => {
    expect(readSession(signRaw({ ...validPayload(), userId: "" }), secret, now)).toBeNull();
    expect(readSession(signRaw({ ...validPayload(), googleSub: 42 }), secret, now)).toBeNull();
    expect(readSession(signRaw({ ...validPayload(), csrf: ["a"] }), secret, now)).toBeNull();
    expect(readSession(signRaw([validPayload()]), secret, now)).toBeNull();
    expect(readSession(signRaw(null), secret, now)).toBeNull();
    expect(readSession(signSession(validPayload({ userId: "u".repeat(201) }), secret), secret, now)).toBeNull();
  });

  it("rejects an issued-at time in the future", () => {
    expect(readSession(signRaw({ ...validPayload(), iat: now + 3600 }), secret, now)).toBeNull();
    expect(readSession(signRaw({ ...validPayload(), iat: "yesterday" }), secret, now)).toBeNull();
  });

  it("rejects unsigned, truncated and oversized tokens", () => {
    const token = signSession(validPayload(), secret);
    expect(readSession(token, "other-secret", now)).toBeNull();
    expect(readSession(token.slice(0, -1), secret, now)).toBeNull();
    expect(readSession(`${"a".repeat(5000)}.${"b".repeat(43)}`, secret, now)).toBeNull();
  });
});

describe("transport security headers", () => {
  it("emits HSTS only on https and keeps production CSP strict", () => {
    const https = securityHeaders(true);
    const http = securityHeaders(false);
    expect(https.some((header) => header.key === "Strict-Transport-Security")).toBe(true);
    expect(http.some((header) => header.key === "Strict-Transport-Security")).toBe(false);
    const csp = https.find((header) => header.key === "Content-Security-Policy")?.value ?? "";
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe("turnstile single-use replay guard", () => {
  let db: ReturnType<typeof openDatabase>;

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

  function remote(nowMs: number) {
    return (async () => new Response(JSON.stringify({
      success: true,
      action: "login",
      hostname: "localhost",
      challenge_ts: new Date(nowMs).toISOString(),
    }), { status: 200 })) as typeof fetch;
  }

  it("accepts a token once and rejects its replay", async () => {
    const nowMs = Date.parse("2026-10-27T12:00:00.000Z");
    const first = await consumeTurnstile({
      request: request(),
      token: "token-one",
      expectedAction: "login",
      now: nowMs,
      fetchImpl: remote(nowMs),
      database: () => db,
    });
    expect(first).toEqual({ ok: true });
    const second = await consumeTurnstile({
      request: request(),
      token: "token-one",
      expectedAction: "login",
      now: nowMs + 1000,
      fetchImpl: remote(nowMs),
      database: () => db,
    });
    expect(second).toMatchObject({ ok: false, code: "reused", status: 403 });
    // The raw token never reaches the store.
    const rows = db.prepare("SELECT token_hash FROM turnstile_tokens").all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(tokenDigest("token-one"));
    expect(rows[0]?.token_hash).not.toBe("token-one");
  });

  it("falls back to the bounded in-process guard when the store is unavailable", async () => {
    const nowMs = Date.parse("2026-10-27T12:00:00.000Z");
    const first = await consumeTurnstile({
      request: request(),
      token: "token-memory",
      expectedAction: "login",
      now: nowMs,
      fetchImpl: remote(nowMs),
      database: () => undefined,
    });
    expect(first).toEqual({ ok: true });
    const second = await consumeTurnstile({
      request: request(),
      token: "token-memory",
      expectedAction: "login",
      now: nowMs + 1000,
      fetchImpl: remote(nowMs),
      database: () => undefined,
    });
    expect(second).toMatchObject({ ok: false, code: "reused" });
  });

  it("does not write a replay row for a rejected verification", async () => {
    const nowMs = Date.parse("2026-10-27T12:00:00.000Z");
    const wrongAction = (async () => new Response(JSON.stringify({
      success: true,
      action: "otp",
      hostname: "localhost",
      challenge_ts: new Date(nowMs).toISOString(),
    }), { status: 200 })) as typeof fetch;
    const verdict = await consumeTurnstile({
      request: request(),
      token: "token-wrong-action",
      expectedAction: "login",
      now: nowMs,
      fetchImpl: wrongAction,
      database: () => db,
    });
    expect(verdict).toMatchObject({ ok: false, code: "action", status: 403 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM turnstile_tokens").get()).toMatchObject({ n: 0 });
  });

  it("expires replay rows and keeps only a digest", () => {
    const nowMs = Date.parse("2026-10-27T12:00:00.000Z");
    const digest = tokenDigest("token-db");
    expect(replaySeen(db, digest, nowMs)).toBe(false);
    expect(replayRemember(db, { digest, action: "login", hostname: "localhost", nowMs })).toBe(true);
    expect(replaySeen(db, digest, nowMs + 60_000)).toBe(true);
    expect(replayRemember(db, { digest, action: "login", hostname: "localhost", nowMs: nowMs + 60_000 })).toBe(false);
    const row = db.prepare("SELECT expires_at, token_hash FROM turnstile_tokens WHERE token_hash = ?").get(digest) as {
      expires_at: string;
      token_hash: string;
    };
    expect(row.token_hash).toBe(digest);
    expect(Date.parse(row.expires_at)).toBeGreaterThan(nowMs);
  });
});
