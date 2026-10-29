// Local dev/test SMS receiver. This is a REAL HTTP server that plays the role of
// a carrier SMS gateway so the complete OTP path (route -> HttpOtpProvider -> HTTP
// -> gateway) can be proven without a paid carrier account. It never sends an SMS;
// it appends the delivered code to a JSONL file so a developer or QA script can
// read it back and finish the verify step.
//
// Run standalone (defaults to http://127.0.0.1:3999/):
//   node scripts/dev/otp-provider-stub.mjs
//
// Wire the app to it in .env.local:
//   OTP_PROVIDER=http
//   OTP_HTTP_URL=http://127.0.0.1:3999/
//   OTP_HTTP_AUTHORIZATION=Bearer local-dev-stub       # only if OTP_STUB_AUTH is set
//
// App -> gateway contract (documented in .env.example):
//   POST OTP_HTTP_URL  {"to":"+E164","code":"123456"}
//   optional Authorization header from OTP_HTTP_AUTHORIZATION
//   any 2xx = delivered; non-2xx / network error / timeout = send failed
//
// Stub-only environment:
//   OTP_STUB_HOST             default 127.0.0.1
//   OTP_STUB_PORT             default 3999 (0 = ephemeral, useful in tests)
//   OTP_STUB_AUTH             optional exact Authorization header the stub requires
//   OTP_STUB_LOG              default tmp/otp-codes.jsonl (relative to cwd)
//   OTP_STUB_DELAY_MS         optional response delay (timeout testing)
//   OTP_STUB_FAIL_STATUS      optional forced non-2xx status (failure testing)
//   OTP_STUB_REDIRECT         optional Location URL; answers 302 (redirect testing)
//
// The in-process exports (startOtpStub) are used by tests/otp-http-provider.test.ts,
// which runs this server on an ephemeral loopback port and talks to it through the
// real global fetch - no fetch mock involved in the provider path.

import { appendFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_OTP_STUB_HOST = "127.0.0.1";
export const DEFAULT_OTP_STUB_PORT = 3999;
const MAX_BODY_BYTES = 8 * 1024;
const PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;
const CODE_PATTERN = /^\d{4,8}$/;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  if (value == null || value === "" || !Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function urlFor(host, port) {
  return "http://" + (host.includes(":") ? "[" + host + "]" : host) + ":" + port + "/";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads a bounded JSON request body. Returns null when the body exceeds the cap
 * so the caller answers 413 instead of buffering an unbounded payload.
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function json(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Starts the stub and resolves once it is listening.
 *
 * @param {{
 *   host?: string, port?: number, auth?: string, logPath?: string,
 *   delayMs?: number, failStatus?: number, redirectLocation?: string,
 *   now?: () => Date,
 * }} [options]
 * @returns {Promise<{
 *   url: string, host: string, port: number, logPath: string,
 *   received: { to: string, code: string, at: string, authorization?: string }[],
 *   close: () => Promise<void>,
 * }>}
 */
export async function startOtpStub(options = {}) {
  const env = process.env;
  const host = options.host ?? env.OTP_STUB_HOST ?? DEFAULT_OTP_STUB_HOST;
  const port = options.port ?? positiveNumber(env.OTP_STUB_PORT, DEFAULT_OTP_STUB_PORT);
  const expectedAuth = options.auth ?? env.OTP_STUB_AUTH ?? "";
  const logPath = path.resolve(options.logPath ?? env.OTP_STUB_LOG ?? path.join("tmp", "otp-codes.jsonl"));
  const delayMs = options.delayMs ?? positiveNumber(env.OTP_STUB_DELAY_MS, 0);
  const failStatus = options.failStatus ?? positiveNumber(env.OTP_STUB_FAIL_STATUS, 0);
  const redirectLocation = options.redirectLocation ?? env.OTP_STUB_REDIRECT ?? "";
  const now = options.now ?? (() => new Date());
  const received = [];

  // Fail at startup, not on the first send, when the capture file cannot be
  // written: a stub that accepts codes it cannot report is useless for QA.
  mkdirSync(path.dirname(logPath), { recursive: true });

  async function handle(request, response) {
    try {
      if (request.method !== "POST") {
        json(response, 405, { ok: false, error: "method_not_allowed" });
        return;
      }
      if (redirectLocation) {
        // A real gateway must not redirect an OTP request; tests use this to
        // prove the provider refuses to follow it.
        response.writeHead(302, { location: redirectLocation });
        response.end();
        return;
      }
      if (failStatus) {
        json(response, failStatus, { ok: false, error: "stub_forced_failure" });
        return;
      }
      if (expectedAuth && request.headers.authorization !== expectedAuth) {
        json(response, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const text = await readBody(request);
      if (text === null) {
        json(response, 413, { ok: false, error: "payload_too_large" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(text || "{}");
      } catch {
        json(response, 400, { ok: false, error: "invalid_json" });
        return;
      }
      const to = typeof payload?.to === "string" ? payload.to.trim() : "";
      const code = typeof payload?.code === "string" ? payload.code.trim() : "";
      if (!PHONE_PATTERN.test(to) || !CODE_PATTERN.test(code)) {
        json(response, 422, { ok: false, error: "invalid_payload" });
        return;
      }
      if (delayMs > 0) await sleep(delayMs);
      const at = now().toISOString();
      try {
        appendFileSync(logPath, JSON.stringify({ to, code, at }) + "\n", "utf8");
      } catch {
        json(response, 500, { ok: false, error: "log_write_failed" });
        return;
      }
      received.push({ to, code, at, authorization: request.headers.authorization });
      // Never echo the code back: real gateways only acknowledge acceptance.
      json(response, 200, { ok: true });
    } catch {
      json(response, 500, { ok: false, error: "stub_error" });
    }
  }

  const server = http.createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  let closing = null;

  /** Stops listening, forces keep-alive sockets closed and resolves when the handle is gone. */
  function close() {
    if (closing) return closing;
    if (!server.listening) {
      closing = Promise.resolve();
      return closing;
    }
    closing = new Promise((resolve) => server.close(() => resolve()));
    // Node fetch keeps idle keep-alive sockets around; without these the test
    // process and a SIGTERM'd CLI could wait for the default timeout.
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    return closing;
  }

  return { url: urlFor(host, boundPort), host, port: boundPort, logPath, received, server, close };
}

async function runCli() {
  const stub = await startOtpStub();
  process.stdout.write("[otp-stub] listening on " + stub.url + "\n");
  process.stdout.write("[otp-stub] codes appended to " + stub.logPath + "\n");
  if (process.env.OTP_STUB_AUTH) process.stdout.write("[otp-stub] Authorization header is required\n");

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write("[otp-stub] " + signal + " received, shutting down\n");
    const forceExit = setTimeout(() => process.exit(0), 2_000);
    forceExit.unref();
    stub.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

const invokedAsScript = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  runCli().catch((error) => {
    process.stderr.write("[otp-stub] failed to start: " + (error instanceof Error ? error.message : "unknown error") + "\n");
    process.exit(1);
  });
}
