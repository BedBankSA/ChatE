import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_JSON_BYTES,
  clientAddress,
  consumeRateLimit,
  gateTurnstile,
  rateLimitResponse,
  readJson,
  resetRateLimits,
  sameOriginRequest,
} from "@/server/guard";

const ORIGIN = "http://localhost:3211";

function postRequest(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/test`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function originRequest(headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}/api/test`, { method: "POST", headers, body: "{}" });
}

describe("readJson: bounded browser JSON parsing", () => {
  it("parses an object body", async () => {
    await expect(readJson(postRequest(JSON.stringify({ question: "hi" })))).resolves.toEqual({ question: "hi" });
  });

  it("treats empty, malformed, and array bodies as an empty object", async () => {
    await expect(readJson(postRequest(""))).resolves.toEqual({});
    await expect(readJson(postRequest("{"))).resolves.toEqual({});
    await expect(readJson(postRequest("[1,2,3]"))).resolves.toEqual({});
    await expect(readJson(postRequest("null"))).resolves.toEqual({});
  });

  it("refuses a declared body larger than the cap without allocating it", async () => {
    const oversized = JSON.stringify({ payload: "x".repeat(MAX_JSON_BYTES) });
    const started = Date.now();
    await expect(readJson(postRequest(oversized))).resolves.toEqual({});
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stops reading a chunked body that crosses the cap", async () => {
    const total = MAX_JSON_BYTES + 4096;
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        const size = Math.min(64 * 1024, total - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size).fill(0x61));
      },
    });
    const request = new Request(`${ORIGIN}/api/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    await expect(readJson(request)).resolves.toEqual({});
  });

  it("parses a body just below the cap", async () => {
    const value = "a".repeat(MAX_JSON_BYTES - 100);
    const parsed = await readJson(postRequest(JSON.stringify({ q: value })));
    expect(typeof parsed.q).toBe("string");
    expect((parsed.q as string).length).toBe(value.length);
  });

  it("allows a caller to lower the cap", async () => {
    const parsed = await readJson(postRequest(JSON.stringify({ q: "1234567890" })), 8);
    expect(parsed).toEqual({});
  });
});

describe("sameOriginRequest: CSRF defense in depth", () => {
  it("allows non-browser callers that send no Origin/Referer", () => {
    expect(sameOriginRequest(originRequest({}))).toBe(true);
  });

  it("allows a same-origin browser request matched by Host", () => {
    expect(sameOriginRequest(originRequest({ origin: ORIGIN, host: "localhost:3211" }))).toBe(true);
  });

  it("allows an origin matched by the reverse-proxy forwarded host", () => {
    expect(
      sameOriginRequest(
        originRequest({ origin: "https://chate.example", host: "internal:3000", "x-forwarded-host": "chate.example" }),
      ),
    ).toBe(true);
  });

  it("allows a Referer-only browser request on the same host", () => {
    expect(sameOriginRequest(originRequest({ referer: `${ORIGIN}/workspace`, host: "localhost:3211" }))).toBe(true);
  });

  it("rejects a cross-site Origin or Referer", () => {
    expect(sameOriginRequest(originRequest({ origin: "https://evil.example", host: "localhost:3211" }))).toBe(false);
    expect(sameOriginRequest(originRequest({ referer: "https://evil.example/phish", host: "localhost:3211" }))).toBe(false);
  });

  it("fails closed for an opaque null origin and a malformed origin", () => {
    expect(sameOriginRequest(originRequest({ origin: "null", host: "localhost:3211" }))).toBe(false);
    expect(sameOriginRequest(originRequest({ origin: "///", host: "localhost:3211" }))).toBe(false);
  });
});

describe("in-memory rate limiting", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("allows the burst, then returns a retry hint, then refills over time", () => {
    const options = { capacity: 3, refillPerMinute: 6 };
    expect(consumeRateLimit("bucket", { ...options, now: 0 })).toMatchObject({ allowed: true });
    expect(consumeRateLimit("bucket", { ...options, now: 0 })).toMatchObject({ allowed: true });
    expect(consumeRateLimit("bucket", { ...options, now: 0 })).toMatchObject({ allowed: true });
    const denied = consumeRateLimit("bucket", { ...options, now: 0 });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    // 6 tokens / 60s = one token every 10s.
    expect(consumeRateLimit("bucket", { ...options, now: 10_000 }).allowed).toBe(true);
  });

  it("keeps separate buckets per key", () => {
    const options = { capacity: 1, refillPerMinute: 1 };
    expect(consumeRateLimit("a", { ...options, now: 0 }).allowed).toBe(true);
    expect(consumeRateLimit("a", { ...options, now: 0 }).allowed).toBe(false);
    expect(consumeRateLimit("b", { ...options, now: 0 }).allowed).toBe(true);
  });

  it("uses proxy headers for the client address and a local fallback", () => {
    expect(clientAddress(originRequest({ "cf-connecting-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientAddress(originRequest({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientAddress(originRequest({}))).toBe("local");
  });

  it("turns an exhausted bucket into a 429 with Retry-After", () => {
    const request = originRequest({ "x-forwarded-for": "203.0.113.5" });
    expect(rateLimitResponse(request, "login", { capacity: 1, refillPerMinute: 1 })).toBeNull();
    const blocked = rateLimitResponse(request, "login", { capacity: 1, refillPerMinute: 1 });
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("retry-after")).toBeTruthy();
    expect(blocked?.status).toBe(429);
  });
});

describe("gateTurnstile: origin gate and login/otp throttle", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
    vi.stubEnv("TURNSTILE_EXPECTED_HOSTNAMES", "localhost");
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a cross-site browser request before any Turnstile work", async () => {
    const response = await gateTurnstile(
      originRequest({ origin: "https://evil.example", host: "localhost:3211" }),
      {},
      "login",
    );
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "origin" } });
  });

  it("still fails closed on a missing Turnstile token for same-origin callers", async () => {
    const response = await gateTurnstile(originRequest({ host: "localhost:3211" }), {}, "login");
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ error: { code: "missing" } });
  });

  it("throttles repeated login attempts per address and reports Retry-After", async () => {
    const headers = { host: "localhost:3211", "x-forwarded-for": "203.0.113.77" };
    let lastStatus = 0;
    let lastBody: { error?: { code?: string } } = {};
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const response = await gateTurnstile(originRequest(headers), {}, "login");
      lastStatus = response?.status ?? 0;
      lastBody = response ? await response.json() : {};
    }
    expect(lastStatus).toBe(429);
    expect(lastBody.error?.code).toBe("rate_limit");
  });

  it("rejects a cross-site nonce request before minting and throttles the intent route", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-google-client");
    const { POST } = await import("@/app/api/auth/google/intent/route");
    const crossSite = await POST(
      new Request(`${ORIGIN}/api/auth/google/intent`, {
        method: "POST",
        headers: { origin: "https://evil.example", host: "localhost:3211" },
      }),
    );
    expect(crossSite.status).toBe(403);
    const headers = { host: "localhost:3211", "x-forwarded-for": "203.0.113.99" };
    let lastStatus = 0;
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const response = await POST(
        new Request(`${ORIGIN}/api/auth/google/intent`, { method: "POST", headers }),
      );
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
  });

  it("does not throttle comparison/upload actions", async () => {
    const headers = { host: "localhost:3211", "x-forwarded-for": "203.0.113.78" };
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await gateTurnstile(originRequest(headers), {}, "comparison");
      expect(response?.status).toBe(403);
    }
  });
});
