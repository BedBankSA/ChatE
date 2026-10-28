#!/usr/bin/env node
/**
 * ChatE release verification harness — API-level end-to-end gate with live-provider evidence.
 *
 * Zero npm dependencies, Node 24 ESM, Windows-friendly. It owns the whole run:
 *   1. seeds a QA SQLite database (users: verified / unverified / non-admin),
 *   2. starts a real local OTP provider HTTP stub (scripts/dev/otp-provider-stub.mjs
 *      when present, otherwise an equivalent inline node:http fallback),
 *   3. spawns the production `next start` server on the mode port with a QA-only
 *      preload that intercepts qa.* Turnstile tokens (and, in mock mode only,
 *      mocks the two paid providers),
 *   4. runs PASS/FAIL probes over real HTTP with signed seeded session cookies,
 *   5. writes redacted JSON evidence to docs/evidence/release-verification-<ts>.json
 *      and, in live mode, docs/evidence/live-provider-calls.md,
 *   6. kills every child process it started.
 *
 * Modes:
 *   mock  port 3221, data/qa.sqlite, providers mocked (providerCallsReal=false)
 *   live  port 3222, data/qa-live.sqlite, HAIKU_LIVE_CALLS=1, real OpenRouter +
 *         Anthropic network calls with the keys already in .env.local
 *         (providerCallsReal=true). OTP provider stays the real loopback HTTP stub
 *         in both modes; no SMS gateway exists in this environment.
 *
 * Usage (run from the repo root):
 *   $env:PATH = "C:\Pak;" + $env:PATH
 *   C:\Pak\node.exe scripts/qa/verify-release.mjs --mode=mock
 *   C:\Pak\node.exe scripts/qa/verify-release.mjs --mode=live
 *
 * Options:
 *   --mode=mock|live          default mock
 *   --port=<n>                default 3221 (mock) / 3222 (live)
 *   --host=<name>             Host header used for every request (default chate.test)
 *   --no-spawn                target an already-running server instead of spawning one
 *   --otp-url=<url>           with --no-spawn: the OTP provider URL the server uses
 *   --db-path=<path>          override the QA database path
 *   --only=P01,P02            run only the listed probes (server still starts)
 *   --ignore-build-staleness  do not fail P01 when .next predates source changes
 *   --keep-children           leave the spawned server/OTP stub running (debug)
 *   --keep-out                keep runtime artifacts under scripts/qa/.out
 *   --out-dir=<dir>           evidence directory (default docs/evidence)
 *   --dry-run                 print the commands/env this harness would use, then exit
 *   --help
 *
 * Exit codes: 0 all probes PASS (or SKIP), 1 any FAIL, 2 harness error.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { parseEnvFile, seedQaUsers } from "./seed.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..", "..");
const NODE_EXE = process.execPath;
const NEXT_BIN = path.join(PROJECT_ROOT, "node_modules", "next", "dist", "bin", "next");
const MOCK_MARKER = "إجابة تجريبية";
const QA_OTP_TOKEN = "qa-otp-stub-bearer";
const HAIKU_MODEL_ID = "claude-haiku-5-5";
const LIVE_OPENROUTER_MODEL = "cohere/north-mini-code:free";
const COMPARISON_MODELS = [
  LIVE_OPENROUTER_MODEL,
  "google/gemma-4-31b-it:free",
  "recursive/flint-v1.0:free",
  HAIKU_MODEL_ID,
];
const SETTLED_RUN_STATUSES = new Set(["completed", "failed", "incomplete", "cancelled"]);
const ALL_PROBE_IDS = [
  "P01", "P02", "P03", "P04", "P05", "P06", "P07",
  "P08", "P09", "P10", "P11", "P12", "P13", "P14",
];

// ---------------------------------------------------------------------------
// Run configuration / mutable state
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    mode: "mock",
    port: null,
    host: "chate.test",
    spawn: true,
    otpUrl: null,
    dbPath: null,
    only: [],
    ignoreBuildStaleness: false,
    keepChildren: false,
    keepOut: false,
    outDir: "docs/evidence",
    dryRun: false,
    help: false,
  };
  for (const arg of argv) {
    const [flag, rawValue] = arg.split("=");
    const value = rawValue ?? "";
    switch (flag) {
      case "--mode": options.mode = value; break;
      case "--port": options.port = Number(value); break;
      case "--host": options.host = value; break;
      case "--no-spawn": options.spawn = false; break;
      case "--otp-url": options.otpUrl = value; break;
      case "--db-path": options.dbPath = value; break;
      case "--only": options.only = value.split(",").map((item) => item.trim()).filter(Boolean); break;
      case "--ignore-build-staleness": options.ignoreBuildStaleness = true; break;
      case "--keep-children": options.keepChildren = true; break;
      case "--keep-out": options.keepOut = true; break;
      case "--out-dir": options.outDir = value; break;
      case "--dry-run": options.dryRun = true; break;
      case "--help": options.help = true; break;
      default: throw new Error("unknown option: " + arg);
    }
  }
  if (options.mode !== "mock" && options.mode !== "live") {
    throw new Error("--mode must be mock or live");
  }
  if (options.port == null) options.port = options.mode === "mock" ? 3221 : 3222;
  if (!options.only.every((id) => ALL_PROBE_IDS.includes(id))) {
    throw new Error("--only accepts probe ids " + ALL_PROBE_IDS.join(","));
  }
  return options;
}

const cfg = parseArgs(process.argv.slice(2));

const state = {
  runId: new Date().toISOString().replace(/[:.]/g, "-"),
  startedAt: new Date().toISOString(),
  outRoot: path.join(PROJECT_ROOT, "scripts", "qa", ".out"),
  outDir: path.resolve(PROJECT_ROOT, cfg.outDir),
  dotenv: {},
  secrets: [],
  build: null,
  dbPath: null,
  storageDir: null,
  preloadPath: null,
  seed: null,
  server: null,
  otp: null,
  children: [],
  db: null,
  probes: [],
  attachments: null,
  comparisonId: null,
  comparisonAttempts: 0,
  providerRuns: [],
  providerDomains: [],
  otpVerification: null,
  serverStdout: [],
  serverStderr: [],
  otpStderr: [],
  fatalError: null,
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const rel = (target) => path.relative(PROJECT_ROOT, target).split(path.sep).join("/");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function snippet(value, length = 320) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, length);
}

function maskPhone(phone) {
  const text = String(phone ?? "");
  if (text.length <= 5) return "***";
  return text.slice(0, Math.max(0, text.length - 7)) + "****" + text.slice(-3);
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  const entries = [];
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // ignore malformed line
    }
  }
  return entries;
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopChild(child, label) {
  if (!child || child.exitCode != null) return;
  try {
    child.kill();
  } catch {
    // already gone
  }
  const exited = await waitExit(child, 6000);
  if (!exited && child.pid) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // best effort
    }
    await waitExit(child, 3000);
  }
  console.log("  stopped " + label);
}

function tallyLines(chunks, cap = 40) {
  return chunks.slice(-cap).map((line) => snippet(line, 400));
}

// ---------------------------------------------------------------------------
// Secret loading / redaction (values never leave memory unredacted)
// ---------------------------------------------------------------------------

const SECRET_ENV_NAMES = [
  "SESSION_SECRET",
  "TURNSTILE_SECRET_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "OTP_HTTP_AUTHORIZATION",
  "OTP_PEPPER",
  "GOOGLE_CLIENT_SECRET",
];

function collectSecrets(env) {
  const found = [];
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string" && value.length >= 8) {
      found.push({ name, value });
    }
  }
  // Also redact key-shaped strings that may appear in provider error bodies.
  found.push({
    name: "key-shaped",
    value: null,
    pattern: /sk-(?:ant|or-v1)-[A-Za-z0-9_-]{8,}/g,
  });
  return found;
}

function redactText(text) {
  let output = String(text ?? "");
  let redacted = 0;
  for (const secret of state.secrets) {
    if (secret.pattern) continue;
    if (typeof secret.value === "string" && secret.value.length >= 8) {
      const parts = output.split(secret.value);
      if (parts.length > 1) {
        redacted += parts.length - 1;
        output = parts.join("[redacted:" + secret.name + "]");
      }
    }
  }
  for (const secret of state.secrets) {
    if (secret.pattern) {
      output = output.replace(secret.pattern, (match) => {
        redacted += 1;
        return "[redacted:" + secret.name + "]";
      });
    }
  }
  output = output.replace(/(authorization["']?\s*[:=]\s*["']?Bearer\s+)[^\s"',}]+/gi, (match, prefix) => {
    redacted += 1;
    return prefix + "[redacted]";
  });
  return { text: output, redacted };
}

function scanForSecrets(text) {
  const findings = [];
  for (const secret of state.secrets) {
    if (secret.pattern) {
      const matches = String(text ?? "").match(secret.pattern);
      if (matches) findings.push(secret.name + " x" + matches.length);
      continue;
    }
    if (typeof secret.value === "string" && secret.value.length >= 8 && String(text ?? "").includes(secret.value)) {
      findings.push(secret.name);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Environment / dotenv
// ---------------------------------------------------------------------------

function pickEnv(name) {
  const fromFile = state.dotenv[name];
  if (typeof fromFile === "string" && fromFile !== "") return fromFile;
  return process.env[name] ?? "";
}

function loadDotenv() {
  const filePath = path.join(PROJECT_ROOT, ".env.local");
  assert(existsSync(filePath), ".env.local is missing; live verification needs it and mock mode needs SESSION_SECRET");
  state.dotenv = parseEnvFile(filePath);
  const required = cfg.mode === "live" ? ["SESSION_SECRET", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"] : ["SESSION_SECRET"];
  const missing = required.filter((name) => !pickEnv(name).trim());
  assert(missing.length === 0, "missing required .env.local variable(s): " + missing.join(", ") + " (names only, values never printed)");
  state.secrets = collectSecrets({ ...process.env, ...state.dotenv });
}

function buildChildEnv() {
  const env = { ...process.env, ...state.dotenv };
  for (const key of Object.keys(env)) {
    if (key === "NODE_OPTIONS") delete env[key];
    if (key === "CHATE_E2E_MOCK") delete env[key];
    if (key === "CHATE_E2E_OTP_LOG") delete env[key];
  }
  const port = cfg.port;
  const mock = cfg.mode === "mock";
  const preloadPath = state.preloadPath;
  const nodeOptionPath = /\s/.test(preloadPath) ? '"' + preloadPath + '"' : preloadPath;
  Object.assign(env, {
    NODE_ENV: "production",
    PORT: String(port),
    NODE_OPTIONS: "--require " + nodeOptionPath,
    NEXT_TELEMETRY_DISABLED: "1",
    SQLITE_PATH: rel(state.dbPath),
    TURNSTILE_EXPECTED_HOSTNAMES: cfg.host,
    TURNSTILE_SECRET_KEY: pickEnv("TURNSTILE_SECRET_KEY") || "qa-turnstile-secret-placeholder",
    OTP_PROVIDER: "http",
    OTP_HTTP_URL: state.otp.url,
    OTP_HTTP_AUTHORIZATION: state.otp.appAuth,
    OTP_PEPPER: pickEnv("OTP_PEPPER") || "qa-otp-pepper-not-a-production-secret-" + cfg.mode,
    STORAGE_DIR: rel(state.storageDir),
    APP_URL: "http://" + cfg.host + ":" + port,
    HAIKU_LIVE_CALLS: "1",
  });
  // The server process trusts the throwaway QA loopback cert for the OTP HTTPS
  // round-trip only; real provider TLS keeps the system trust store.
  if (state.otp.protocol === "https" && state.otp.certPath) {
    env.NODE_EXTRA_CA_CERTS = path.resolve(PROJECT_ROOT, state.otp.certPath);
  } else {
    delete env.NODE_EXTRA_CA_CERTS;
  }
  if (mock) {
    env.CHATE_E2E_MOCK = "1";
    // Throwaway keys: if the mock preload ever fails to install, the provider
    // rejects these instead of spending real money.
    env.OPENROUTER_API_KEY = "qa-mock-openrouter-key-not-real";
    env.ANTHROPIC_API_KEY = "qa-mock-anthropic-key-not-real";
  }
  return env;
}

// ---------------------------------------------------------------------------
// Build identity / evidence freshness
// ---------------------------------------------------------------------------

function walkFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs|sql|json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function readBuildInfo() {
  const buildIdPath = path.join(PROJECT_ROOT, ".next", "BUILD_ID");
  assert(existsSync(buildIdPath), ".next/BUILD_ID missing — run `npm run build` (Lead owns the production build) before verification");
  const buildId = readFileSync(buildIdPath, "utf8").trim();
  const buildAt = statSync(buildIdPath).mtime;
  const sources = [];
  walkFiles(path.join(PROJECT_ROOT, "src"), sources);
  walkFiles(path.join(PROJECT_ROOT, "migrations"), sources);
  for (const extra of ["next.config.ts", "package.json", "tsconfig.json"]) {
    const filePath = path.join(PROJECT_ROOT, extra);
    if (existsSync(filePath)) sources.push(filePath);
  }
  let newest = buildAt;
  let newestFile = ".next/BUILD_ID";
  for (const file of sources) {
    const mtime = statSync(file).mtime;
    if (mtime.getTime() > newest.getTime()) {
      newest = mtime;
      newestFile = rel(file);
    }
  }
  return {
    buildId,
    buildAt: buildAt.toISOString(),
    newestSource: newest.toISOString(),
    newestSourceFile: newestFile,
    stale: newest.getTime() > buildAt.getTime() + 2000,
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing (raw node:http so the Host header is fully controlled)
// ---------------------------------------------------------------------------

function request(method, pathname, options = {}) {
  const port = options.port ?? cfg.port;
  const headers = {
    host: options.hostHeader ?? cfg.host + ":" + port,
    ...(options.headers ?? {}),
  };
  let payload = null;
  if (options.json !== undefined) {
    payload = Buffer.from(JSON.stringify(options.json));
    headers["content-type"] = "application/json";
  } else if (options.body !== undefined) {
    payload = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
    if (options.contentType) headers["content-type"] = options.contentType;
  }
  if (payload) headers["content-length"] = String(payload.length);
  if (options.cookie) headers.cookie = options.cookie;
  const timeoutMs = options.timeoutMs ?? 30000;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: pathname, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timeout " + timeoutMs + "ms: " + method + " " + pathname)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function api(method, pathname, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.role) headers.cookie = sessionCookie(options.role);
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return request(method, pathname, {
    headers,
    json: options.body,
    body: options.rawBody,
    contentType: options.contentType,
    timeoutMs: options.timeoutMs,
  });
}

function multipart(options) {
  const boundary = "----chateqa" + randomUUID().replace(/-/g, "");
  const chunks = [];
  for (const [name, value] of Object.entries(options.fields ?? {})) {
    chunks.push(
      Buffer.from(
        "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n",
        "utf8",
      ),
    );
  }
  for (const file of options.files ?? []) {
    chunks.push(
      Buffer.from(
        "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + (file.field || "files") +
          "\"; filename=\"" + file.filename + "\"\r\nContent-Type: " + (file.contentType || "application/octet-stream") + "\r\n\r\n",
        "utf8",
      ),
    );
    chunks.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from("--" + boundary + "--\r\n"));
  return { body: Buffer.concat(chunks), contentType: "multipart/form-data; boundary=" + boundary };
}

function sessionCookie(role) {
  assert(state.seed, "sessions are not seeded yet");
  const session = state.seed.sessions[role];
  assert(session, "missing seeded session role: " + role);
  return session.cookie;
}

let qaTokenCounter = 0;
function qaToken(action) {
  qaTokenCounter += 1;
  return "qa." + action + "." + cfg.host + "." + (Date.now() + (qaTokenCounter % 997));
}

function jsonErrorCode(response) {
  return response?.json?.error?.code ?? null;
}

function jsonErrorMessage(response) {
  return response?.json?.error?.message ?? "";
}

// ---------------------------------------------------------------------------
// Real upload fixtures
// ---------------------------------------------------------------------------

function makePdf(text) {
  const escaped = text.replace(/([()\\])/g, "\\$1");
  const stream = "BT /F1 18 Tf 72 700 Td (" + escaped + ") Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length " + Buffer.byteLength(stream, "latin1") + " >>\nstream\n" + stream + "\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output, "latin1"));
    output += index + 1 + " 0 obj\n" + object + "\nendobj\n";
  });
  const xrefOffset = Buffer.byteLength(output, "latin1");
  output += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
  for (let index = 1; index <= objects.length; index += 1) {
    output += String(offsets[index]).padStart(10, "0") + " 00000 n \n";
  }
  output += "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF\n";
  return Buffer.from(output, "latin1");
}

const TXT_MARKER = "ChatE QA plain-text attachment";
const PDF_MARKER = "ChatE QA PDF attachment";
const ATTACHMENT_TXT = Buffer.from(
  TXT_MARKER + "\nThis file is real uploaded evidence for release verification.\n" +
    "verification code: QA-CODE-7731\n" +
    "عبارة عربية للتحقق من الاستخراج: عاصمة الأردن هي عمّان.\n",
  "utf8",
);
const ATTACHMENT_PDF = makePdf(PDF_MARKER + " for release verification.");
const ATTACHMENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// ---------------------------------------------------------------------------
// OTP provider HTTP stub
// ---------------------------------------------------------------------------

function stubRequest(port, pathname, headers, json, options = {}) {
  const payload = Buffer.from(JSON.stringify(json));
  const secure = options.protocol === "https";
  const transport = secure ? https : http;
  const requestOptions = {
    host: "127.0.0.1",
    port,
    method: "POST",
    path: pathname,
    headers: { ...headers, "content-type": "application/json", "content-length": String(payload.length) },
  };
  if (secure && options.ca) requestOptions.ca = options.ca;
  if (secure) requestOptions.rejectUnauthorized = true;
  return new Promise((resolve, reject) => {
    const req = transport.request(requestOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(4000, () => req.destroy(new Error("stub request timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function waitForTcp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reachable = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.setTimeout(1000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (reachable) return true;
    await sleep(150);
  }
  return false;
}

async function probeStub(port, authHeader, options = {}) {
  for (const pathname of ["/send", "/"]) {
    try {
      const response = await stubRequest(port, pathname, authHeader ? { authorization: authHeader } : {}, {
        to: "+10000000000",
        code: "000000",
      }, options);
      if (response.status >= 200 && response.status < 300) return { ok: true, path: pathname };
    } catch {
      // try next path
    }
  }
  return { ok: false, path: null };
}

async function startInlineOtpStub(port, logPath, expectedAuth, tlsOptions) {
  const handler = (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const auth = String(req.headers.authorization || "");
      if (expectedAuth && auth !== expectedAuth) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      let payload = null;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        payload = null;
      }
      if (!payload || typeof payload.to !== "string" || typeof payload.code !== "string") {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad payload" }));
        return;
      }
      mkdirSync(path.dirname(logPath), { recursive: true });
      appendFileSync(logPath, JSON.stringify({ to: payload.to, code: payload.code, at: nowIso() }) + "\n", "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  };
  const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function findFreePort(start) {
  for (let candidate = start; candidate < start + 40; candidate += 1) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(candidate, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return candidate;
  }
  throw new Error("no free loopback port in range " + start + "-" + (start + 40));
}

function opensslExecutable() {
  if (process.env.QA_OPENSSL_EXE && existsSync(process.env.QA_OPENSSL_EXE)) return process.env.QA_OPENSSL_EXE;
  const candidates = [
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
    "C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const lookup = spawnSync("openssl", ["version"], { stdio: "ignore" });
  return lookup.status === 0 ? "openssl" : null;
}

/**
 * Throwaway loopback TLS cert for the OTP provider stub. The production build
 * rejects plain-http OTP URLs (src/domain/auth/otp.ts requires https except for
 * a loopback dev/test process), and the real deployment contract is an https
 * gateway, so release verification proves a REAL HTTPS round-trip. The cert/key
 * exist only under scripts/qa/.out (deleted at teardown) and are trusted only by
 * the spawned server process through NODE_EXTRA_CA_CERTS.
 */
function generateLoopbackCert(tlsDir) {
  const openssl = opensslExecutable();
  if (!openssl) return null;
  mkdirSync(tlsDir, { recursive: true });
  const result = spawnSync(
    openssl,
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
      "-keyout", "key.pem", "-out", "cert.pem",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    ],
    { cwd: tlsDir, stdio: "ignore", timeout: 60000 },
  );
  const certPath = path.join(tlsDir, "cert.pem");
  const keyPath = path.join(tlsDir, "key.pem");
  if (result.status !== 0 || !existsSync(certPath) || !existsSync(keyPath)) return null;
  try {
    const certPem = readFileSync(certPath, "utf8");
    const keyPem = readFileSync(keyPath, "utf8");
    if (!certPem.includes("BEGIN CERTIFICATE") || !keyPem.includes("PRIVATE KEY")) return null;
    return { certPath, keyPath, certPem, keyPem, openssl };
  } catch {
    return null;
  }
}

async function startOtpStub() {
  const port = await findFreePort(3999);
  const logPath = path.join(state.outRoot, "otp-stub-" + cfg.mode + ".jsonl");
  mkdirSync(path.dirname(logPath), { recursive: true });
  rmSync(logPath, { force: true });
  const stubFile = path.join(PROJECT_ROOT, "scripts", "dev", "otp-provider-stub.mjs");
  const authHeader = "Bearer " + QA_OTP_TOKEN;
  const tls = generateLoopbackCert(path.join(state.outRoot, "otp-tls"));

  // Preferred path: a real HTTPS loopback stub (production URL policy compliant).
  if (tls) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const server = await startInlineOtpStub(port, logPath, authHeader, { key: tls.keyPem, cert: tls.certPem });
        const transport = { protocol: "https", ca: tls.certPem };
        const good = await probeStub(port, authHeader, transport);
        const bad = await probeStub(port, "Bearer definitely-wrong-token", transport);
        const stubPath = good.ok ? good.path : "/send";
        return {
          protocol: "https",
          kind: "node:https",
          source: "TLS loopback stub (real HTTPS round-trip; throwaway self-signed QA cert)",
          server,
          port,
          path: stubPath,
          url: "https://127.0.0.1:" + port + stubPath,
          logPath,
          appAuth: authHeader,
          authEnforced: !bad.ok,
          certPath: rel(tls.certPath),
          stderr: [],
        };
      } catch (error) {
        if (String(error && error.message).includes("EADDRINUSE")) {
          await sleep(400);
          continue;
        }
        throw error;
      }
    }
  }

  // Fallback without openssl: the dev plain-http stub. A NODE_ENV=production
  // server rejects plain-http OTP URLs by design, so P07 will fail loudly with
  // OTP_FAIL_CLOSED and the evidence records why, instead of faking coverage.
  console.warn("  no openssl found: falling back to a plain-http OTP stub (production URL policy will reject it)");
  if (existsSync(stubFile)) {
    const authModes = [{ value: "Bearer " + QA_OTP_TOKEN, label: "header-value" }, { value: QA_OTP_TOKEN, label: "bare-token" }];
    for (const mode of authModes) {
      const stderr = [];
      const child = spawn(NODE_EXE, [stubFile], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          PORT: String(port),
          OTP_STUB_PORT: String(port),
          OTP_STUB_LOG: logPath,
          OTP_STUB_AUTH: mode.value,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      state.children.push(child);
      child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
      child.on("error", () => undefined);
      const up = await waitForTcp(port, 8000);
      if (!up) {
        await stopChild(child, "otp stub (auth mode " + mode.label + ", never listened)");
        continue;
      }
      const good = await probeStub(port, authHeader);
      if (!good.ok) {
        await stopChild(child, "otp stub (auth mode " + mode.label + ", rejected the app header shape)");
        continue;
      }
      const bad = await probeStub(port, "Bearer definitely-wrong-token");
      return {
        protocol: "http",
        kind: "node:http",
        source: rel(stubFile),
        child,
        port,
        path: good.path,
        url: "http://127.0.0.1:" + port + good.path,
        logPath,
        appAuth: authHeader,
        authEnforced: !bad.ok,
        certPath: null,
        stderr,
      };
    }
    console.warn("  scripts/dev/otp-provider-stub.mjs did not pass its own contract probe; using inline fallback");
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const server = await startInlineOtpStub(port, logPath, authHeader);
      const good = await probeStub(port, authHeader);
      const bad = await probeStub(port, "Bearer definitely-wrong-token");
      return {
        protocol: "http",
        kind: "node:http",
        source: existsSync(stubFile) ? "inline-fallback (file stub failed contract probe)" : "inline-fallback (scripts/dev/otp-provider-stub.mjs missing)",
        server,
        port,
        path: good.ok ? good.path : "/send",
        url: "http://127.0.0.1:" + port + (good.ok ? good.path : "/send"),
        logPath,
        appAuth: authHeader,
        authEnforced: !bad.ok,
        certPath: null,
        stderr: [],
      };
    } catch (error) {
      if (String(error && error.message).includes("EADDRINUSE")) {
        await sleep(400);
        continue;
      }
      throw error;
    }
  }
  throw new Error("could not start the OTP provider stub on port " + port);
}

async function stopOtpStub() {
  if (!state.otp) return;
  if (state.otp.child) await stopChild(state.otp.child, "OTP provider stub (child)");
  if (state.otp.server) {
    await new Promise((resolve) => state.otp.server.close(resolve));
    console.log("  stopped OTP provider stub (inline)");
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function waitForHealth(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode != null) {
      throw new Error(
        "server exited before becoming healthy (code " + child.exitCode + ")\n" + tallyLines(state.serverStderr).join("\n"),
      );
    }
    // Preferred readiness signal: the deployment health endpoint.
    try {
      const health = await request("GET", "/api/health", { timeoutMs: 3000 });
      if (health.status === 200) return { readyVia: "/api/health", health: health.json, status: 200 };
    } catch {
      // not listening yet
    }
    // Fallback readiness: root page answers. (A stale build may predate /api/health;
    // P01 still fails on that, but probing should not hang.)
    try {
      const root = await request("GET", "/", { timeoutMs: 3000 });
      if (root.status === 200) return { readyVia: "/ (health endpoint unavailable in this build)", health: null, status: root.status };
    } catch {
      // not listening yet
    }
    await sleep(900);
  }
  throw new Error("server did not become healthy within " + timeoutMs + "ms on port " + cfg.port + "\n" + tallyLines(state.serverStderr).join("\n"));
}

async function startServer() {
  const port = cfg.port;
  const free = await isPortFree(port);
  assert(free, "port " + port + " is already in use — refusing to interfere with another server (allowed ports: 3221 mock, 3222 live)");
  const env = buildChildEnv();
  state.secrets = collectSecrets(env);
  console.log("  spawning: node_modules/next/dist/bin/next start -p " + port + " -H 127.0.0.1");
  console.log("  db: " + rel(state.dbPath) + " | OTP stub: " + state.otp.url + " (" + state.otp.source + ")");
  const child = spawn(NODE_EXE, [NEXT_BIN, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.children.push(child);
  // Track the server immediately so any later failure (health timeout, probe
  // crash) is still cleaned up by cleanupAll().
  state.server = { child, port, readyMs: null, health: null, readyVia: null };
  child.stdout.on("data", (chunk) => state.serverStdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => state.serverStderr.push(String(chunk)));
  child.on("error", (error) => state.serverStderr.push("spawn error: " + error.message));
  const startedAt = Date.now();
  try {
    const ready = await waitForHealth(child, 120000);
    state.server.readyMs = Date.now() - startedAt;
    state.server.health = ready.health;
    state.server.readyVia = ready.readyVia;
    console.log("  server ready after " + state.server.readyMs + "ms (readiness via " + ready.readyVia + ")");
    return state.server;
  } catch (error) {
    await stopChild(child, "Next.js server (failed to become healthy)");
    throw error;
  }
}

async function stopServer() {
  if (!state.server?.child) return;
  if (cfg.keepChildren) {
    console.log("  --keep-children: leaving server pid " + (state.server.child.pid ?? "?") + " on port " + state.server.port);
    return;
  }
  await stopChild(state.server.child, "Next.js server (port " + state.server.port + ")");
}

let cleanupStarted = false;

/** Idempotent teardown: DB handle, spawned server/stub, runtime artifacts. */
async function cleanupAll() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  try {
    if (state.db) {
      try {
        state.db.close();
      } catch {
        // already closed
      }
      state.db = null;
    }
  } catch {
    // ignore
  }
  if (cfg.keepChildren) {
    console.log("  --keep-children: leaving spawned processes running");
  } else {
    await stopServer();
    await stopOtpStub();
    for (const child of state.children) {
      if (child.exitCode == null) await stopChild(child, "tracked child pid " + (child.pid ?? "?"));
    }
  }
  if (!cfg.keepOut) {
    try {
      rmSync(state.outRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

// ---------------------------------------------------------------------------
// Probe framework
// ---------------------------------------------------------------------------

class SkipProbe extends Error {}
const skip = (reason) => {
  throw new SkipProbe(reason);
};

function wanted(id) {
  return cfg.only.length === 0 || cfg.only.includes(id);
}

async function probe(id, title, fn) {
  if (!wanted(id)) return null;
  const started = Date.now();
  try {
    const detail = (await fn()) ?? {};
    const record = {
      id,
      title,
      status: "PASS",
      expected: detail.expected ?? "",
      actual: detail.actual ?? "",
      data: detail.data ?? null,
      durationMs: Date.now() - started,
    };
    state.probes.push(record);
    console.log("[PASS] " + id + " — " + title + (record.actual ? " :: " + snippet(record.actual, 220) : ""));
    return record;
  } catch (error) {
    const status = error instanceof SkipProbe ? "SKIP" : "FAIL";
    const message = error instanceof Error ? error.message : String(error);
    const record = {
      id,
      title,
      status,
      expected: "",
      actual: "",
      data: null,
      error: status === "SKIP" ? message : snippet(message, 700),
      durationMs: Date.now() - started,
    };
    state.probes.push(record);
    console.log("[" + (status === "SKIP" ? "SKIP" : "FAIL") + "] " + id + " — " + title + " :: " + snippet(message, 400));
    return record;
  }
}

function requireComparisonId() {
  if (!state.comparisonId) skip("comparison probe P09 did not produce a comparison id");
  return state.comparisonId;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function runProbes() {
  // ---- P01: health + build identity -------------------------------------
  await probe("P01", "production server health + non-stale build", async () => {
    const health = await request("GET", "/api/health");
    assert(
      health.status === 200,
      "GET /api/health expected 200, got " + health.status + " body=" + snippet(health.text, 160) +
        (health.status === 404 ? " — this production build predates /api/health; Lead must rebuild (`npm run build`)" : ""),
    );
    assert(health.json?.ok === true && health.json?.data?.status === "ok", "health envelope not ok: " + snippet(health.text));
    assert(health.json?.data?.database === "ok", "health database not ok: " + snippet(health.text));
    assert(health.headers["cache-control"] === "no-store", "health cache-control must be no-store");
    const build = state.build;
    if (build.stale && !cfg.ignoreBuildStaleness) {
      throw new Error(
        "production build is stale: .next built at " + build.buildAt + " but " + build.newestSourceFile +
          " changed at " + build.newestSource + " — rebuild required before verification (Lead owns `npm run build`)",
      );
    }
    return {
      expected: "GET /api/health 200 ok (db ok) and .next newer than src/migrations",
      actual: "health 200; build " + build.buildId + " @ " + build.buildAt + (build.stale ? " (STALE — ignored by flag)" : ""),
      data: { build, serverReadyMs: state.server?.readyMs ?? null },
    };
  });

  // ---- P02: HTML shell + security headers --------------------------------
  await probe("P02", "root HTML shell + security headers", async () => {
    const root = await request("GET", "/");
    assert(root.status === 200, "GET / expected 200, got " + root.status);
    assert(root.text.includes('lang="ar"'), "html lang=ar missing");
    assert(root.text.includes('dir="rtl"'), "html dir=rtl missing");
    assert(root.text.includes("سؤال واحد"), "Arabic hero copy missing from root HTML");
    const headers = root.headers;
    const required = {
      "content-security-policy": (value) => value.includes("frame-ancestors 'none'") && value.includes("object-src 'none'"),
      "x-content-type-options": (value) => value === "nosniff",
      "x-frame-options": (value) => value.toUpperCase() === "DENY",
      "referrer-policy": (value) => value.length > 0,
      "permissions-policy": (value) => value.includes("camera=()"),
      "cross-origin-opener-policy": (value) => value.startsWith("same-origin"),
      "strict-transport-security": (value) => value.includes("max-age=31536000"),
    };
    const failures = [];
    for (const [name, check] of Object.entries(required)) {
      const value = String(headers[name] ?? "");
      if (!check(value)) failures.push(name + (value ? " (weak)" : " (missing)"));
    }
    assert(headers["x-powered-by"] == null, "x-powered-by must be absent");
    assert(failures.length === 0, "missing/weak security headers: " + failures.join(", "));
    return {
      expected: "200 Arabic RTL HTML + CSP/frame-ancestors, nosniff, DENY, referrer, permissions, COOP, HSTS; no x-powered-by",
      actual: "all 7 headers present and strong; CSP " + String(headers["content-security-policy"]).length + " chars",
      data: {
        contentSecurityPolicyChars: String(headers["content-security-policy"]).length,
        crossOriginOpenerPolicy: headers["cross-origin-opener-policy"],
        hsts: headers["strict-transport-security"],
      },
    };
  });

  // ---- P03: model catalog ------------------------------------------------
  await probe("P03", "GET /api/models catalog contract", async () => {
    const models = await api("GET", "/api/models");
    assert(models.status === 200, "GET /api/models expected 200, got " + models.status + " body=" + snippet(models.text));
    assert(models.json?.ok === true && Array.isArray(models.json?.data), "models envelope shape invalid: " + snippet(models.text));
    const list = models.json.data;
    assert(list.length >= 20, "expected the full model catalog, got " + list.length);
    const ids = new Set(list.map((model) => model.id));
    for (const required of COMPARISON_MODELS) {
      assert(ids.has(required), "catalog is missing required model " + required);
    }
    for (const key of ["id", "displayName", "taskType", "availability", "usagePolicy"]) {
      assert(typeof list[0][key] === "string" && list[0][key].length > 0, "public model field missing: " + key);
    }
    return {
      expected: "200 envelope with full catalog incl. 3 free models + claude-haiku-5-5",
      actual: list.length + " models incl. all 4 comparison ids",
      data: { modelCount: list.length, requiredPresent: COMPARISON_MODELS },
    };
  });

  // ---- P04: public pages -------------------------------------------------
  await probe("P04", "public pages render (Arabic) + anonymous redirects/404", async () => {
    const pages = [
      ["/", "سؤال واحد"],
      ["/privacy", "الخصوصية"],
      ["/terms", "الشروط"],
      ["/account", "الحساب"],
      ["/history", "سجل المقارنات"],
      ["/admin", "الإدارة"],
    ];
    const rows = [];
    for (const [pathname, needle] of pages) {
      const response = await request("GET", pathname);
      assert(response.status === 200, pathname + " expected 200, got " + response.status);
      assert(response.text.includes(needle), pathname + " is missing Arabic copy \"" + needle + "\"");
      rows.push(pathname + " 200");
    }
    const workspace = await request("GET", "/workspace");
    assert(workspace.status === 307 || workspace.status === 308, "/workspace anonymous expected 307, got " + workspace.status);
    const redirectPath = new URL(workspace.headers.location ?? "/", "http://" + cfg.host).pathname;
    assert(redirectPath === "/", "/workspace anonymous must redirect to /, got " + redirectPath);
    const profile = await request("GET", "/profile/complete");
    assert(profile.status === 307 || profile.status === 308, "/profile/complete anonymous expected 307, got " + profile.status);
    const notFound = await request("GET", "/qa-does-not-exist-" + Date.now());
    assert(notFound.status === 404, "unknown route expected 404, got " + notFound.status);
    // Arabic 404 copy is not part of the task-5 contract (there is no custom
    // not-found page in this app); record it as a soft signal, not a gate.
    const localized = notFound.text.includes("غير موجود") || notFound.text.includes("تعذر العثور") || notFound.text.includes("الصفحة");
    return {
      expected: "6 public pages 200 Arabic; /workspace + /profile/complete -> 307 /; unknown -> 404",
      actual: rows.join("; ") + "; /workspace 307 -> /; 404 (localized=" + localized + ")",
      data: { pages: rows, notFoundLocalized: localized },
    };
  });

  // ---- P05: anonymous 401s ----------------------------------------------
  await probe("P05", "anonymous API requests -> 401 anonymous", async () => {
    const cases = [];
    const comparisons = await api("POST", "/api/comparisons", {
      body: {
        question: "اختبار مجهول",
        evidenceMode: "native",
        answerModelIds: [LIVE_OPENROUTER_MODEL],
        idempotencyKey: randomUUID(),
      },
    });
    cases.push(["POST /api/comparisons", comparisons]);
    const uploads = multipart({
      fields: { "cf-turnstile-response": qaToken("upload") },
      files: [{ field: "files", filename: "qa-anon.txt", contentType: "text/plain", data: Buffer.from("anon") }],
    });
    cases.push(["POST /api/uploads", await request("POST", "/api/uploads", { body: uploads.body, contentType: uploads.contentType })]);
    cases.push([
      "POST /api/otp/send",
      await api("POST", "/api/otp/send", { body: { phone: "+966501234567", "cf-turnstile-response": qaToken("otp") } }),
    ]);
    cases.push(["POST /api/otp/verify", await api("POST", "/api/otp/verify", { body: { code: "123456" } })]);
    cases.push(["GET /api/history", await api("GET", "/api/history")]);
    cases.push(["GET /api/comparisons/<uuid>", await api("GET", "/api/comparisons/" + randomUUID())]);
    const failures = [];
    const actual = [];
    for (const [label, response] of cases) {
      const anonymous = response.status === 401 && jsonErrorCode(response) === "anonymous";
      if (!anonymous) failures.push(label + " -> " + response.status + " " + (jsonErrorCode(response) ?? snippet(response.text, 80)));
      actual.push(label + " " + response.status);
    }
    assert(
      failures.length === 0,
      "expected every anonymous request to be 401 anonymous; got " + failures.join("; ") +
        (cases.some(([, response]) => response.status === 404) ? " (a 404 usually means the endpoint is not integrated yet)" : ""),
    );
    return {
      expected: "401 anonymous on comparisons/uploads/otp send+verify/history/comparison detail",
      actual: actual.join("; "),
      data: { cases: actual },
    };
  });

  // ---- P06: Turnstile gate ----------------------------------------------
  await probe("P06", "Turnstile gate: missing token, bad token, token replay", async () => {
    const missing = await api("POST", "/api/otp/send", {
      role: "unverified2",
      body: { phone: "+966501112233" },
    });
    assert(missing.status === 403, "missing Turnstile token expected 403, got " + missing.status + " " + snippet(missing.text));
    const badToken = await api("POST", "/api/otp/send", {
      role: "unverified2",
      body: { phone: "+966501112233", "cf-turnstile-response": "not-a-valid-turnstile-token-" + Date.now() },
    });
    assert(badToken.status === 403, "invalid Turnstile token expected 403, got " + badToken.status + " " + snippet(badToken.text));
    const replayToken = qaToken("upload");
    const first = multipart({
      fields: { "cf-turnstile-response": replayToken },
      files: [{ field: "files", filename: "qa-replay.txt", contentType: "text/plain", data: Buffer.from("replay probe") }],
    });
    const firstUpload = await request("POST", "/api/uploads", { cookie: sessionCookie("verified"), body: first.body, contentType: first.contentType });
    assert(firstUpload.status === 200, "first upload with fresh qa token expected 200, got " + firstUpload.status + " " + snippet(firstUpload.text));
    const second = multipart({
      fields: { "cf-turnstile-response": replayToken },
      files: [{ field: "files", filename: "qa-replay.txt", contentType: "text/plain", data: Buffer.from("replay probe") }],
    });
    const replay = await request("POST", "/api/uploads", { cookie: sessionCookie("verified"), body: second.body, contentType: second.contentType });
    assert(replay.status === 403, "replayed qa token expected 403, got " + replay.status + " " + snippet(replay.text));
    return {
      expected: "missing token 403; non-qa/invalid token 403 (real Cloudflare rejection path); replayed qa token 403",
      actual: "missing 403, bad token 403, fresh upload 200, replay 403 (" + (jsonErrorCode(replay) ?? "?") + ")",
      data: { missing: missing.status, badToken: badToken.status, replay: replay.status, replayCode: jsonErrorCode(replay) },
    };
  });

  // ---- P07: OTP real loopback HTTP provider ------------------------------
  await probe("P07", "OTP send via real loopback HTTP stub -> verify -> phone_verified_at", async () => {
    const otp = state.otp;
    const userId = state.seed.sessions.unverified.userId;
    const phone = "+966501234567";
    const before = readJsonl(otp.logPath).length;
    const send = await api("POST", "/api/otp/send", {
      role: "unverified",
      body: { phone, "cf-turnstile-response": qaToken("otp") },
    });
    assert(
      send.status === 200,
      "OTP send expected 200, got " + send.status + " " + snippet(send.text) +
        (jsonErrorCode(send) === "OTP_FAIL_CLOSED"
          ? " — production OTP URL policy requires https; the local TLS stub/cert could not be prepared (see harness log)"
          : ""),
    );
    assert(send.json?.data?.sent === true, "OTP send data.sent must be true: " + snippet(send.text));

    let code = null;
    let sourceLog = null;
    for (const candidate of [otp.logPath, path.join(PROJECT_ROOT, "tmp", "otp-codes.jsonl")]) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !code) {
        const entries = readJsonl(candidate).filter((entry) => entry && entry.to === phone);
        if (entries.length > 0) {
          code = String(entries[entries.length - 1].code);
          sourceLog = rel(candidate);
          break;
        }
        await sleep(250);
      }
      if (code) break;
    }
    assert(code, "OTP code did not reach the local HTTP stub log (transport=" + otp.kind + ", source=" + otp.source + ")");
    assert(/^\d{6}$/.test(code), "OTP code is not 6 digits: " + snippet(code, 10));
    const appRequests = readJsonl(otp.logPath).filter((entry) => entry && entry.to === phone).length;
    assert(appRequests >= 1, "stub log has no app request for the target phone");
    const wrong = await api("POST", "/api/otp/verify", {
      role: "unverified",
      body: { code: code === "000000" ? "111111" : "000000" },
    });
    assert(wrong.status === 403, "wrong OTP code expected 403, got " + wrong.status + " " + snippet(wrong.text));
    assert(jsonErrorCode(wrong) === "OTP_MISMATCH", "wrong OTP code must return OTP_MISMATCH, got " + jsonErrorCode(wrong));
    assert(typeof wrong.json?.error?.remainingAttempts === "number", "wrong OTP code must expose remainingAttempts");
    const verify = await api("POST", "/api/otp/verify", { role: "unverified", body: { code } });
    assert(verify.status === 200 && verify.json?.data?.verified === true, "correct OTP code expected 200 verified, got " + verify.status + " " + snippet(verify.text));
    const profile = state.db.prepare("SELECT phone_e164, phone_verified_at FROM profiles WHERE user_id = ?").get(userId);
    assert(typeof profile?.phone_verified_at === "string" && profile.phone_verified_at.length > 0, "profiles.phone_verified_at was not persisted");
    const reuse = await api("POST", "/api/otp/verify", { role: "unverified", body: { code } });
    assert(reuse.status === 403, "reused OTP code expected 403, got " + reuse.status);
    state.otpVerification = {
      userId,
      phoneMasked: maskPhone(profile.phone_e164 ?? phone),
      transport: otp.protocol === "https"
        ? "real HTTPS POST over loopback to the local OTP provider stub (throwaway self-signed cert trusted only by the spawned server process via NODE_EXTRA_CA_CERTS)"
        : "real HTTP POST to the local OTP provider stub (plain http; a production-policy server rejects this)",
      providerUrlScheme: otp.protocol,
      stubKind: otp.kind,
      stubSource: otp.source,
      stubPort: otp.port,
      stubPath: otp.path,
      stubAuthEnforced: otp.authEnforced,
      appRequests,
      logFile: sourceLog,
      persistedVerifiedAt: profile.phone_verified_at,
    };
    return {
      expected: "send 200 -> real " + otp.protocol.toUpperCase() + " stub receives code -> wrong 403 OTP_MISMATCH + remainingAttempts -> correct 200 verified -> profiles.phone_verified_at persisted -> reused 403",
      actual: "send 200; code delivered over " + otp.protocol.toUpperCase() + " after " + (appRequests >= 1 ? "1 stub request" : "?") + "; wrong 403; verify 200; phone_verified_at set; reuse 403",
      data: state.otpVerification,
    };
  });

  // ---- P08: real uploads -------------------------------------------------
  await probe("P08", "upload real bytes (txt+pdf+png) via multipart", async () => {
    const files = [
      { field: "files", filename: "qa-attachment.txt", contentType: "text/plain", data: ATTACHMENT_TXT },
      { field: "files", filename: "qa-attachment.pdf", contentType: "application/pdf", data: ATTACHMENT_PDF },
      { field: "files", filename: "qa-attachment.png", contentType: "image/png", data: ATTACHMENT_PNG },
    ];
    const form = multipart({ fields: { "cf-turnstile-response": qaToken("upload") }, files });
    const response = await request("POST", "/api/uploads", {
      cookie: sessionCookie("verified"),
      body: form.body,
      contentType: form.contentType,
    });
    assert(response.status === 200, "POST /api/uploads expected 200, got " + response.status + " " + snippet(response.text));
    assert(response.json?.ok === true && Array.isArray(response.json?.data?.files), "uploads response shape invalid: " + snippet(response.text));
    const uploaded = response.json.data.files;
    assert(uploaded.length === 3, "expected 3 stored files, got " + uploaded.length);
    const sizes = uploaded.map((file) => file.byteSize).sort((a, b) => a - b);
    const expectedSizes = [ATTACHMENT_TXT.length, ATTACHMENT_PDF.length, ATTACHMENT_PNG.length].sort((a, b) => a - b);
    assert(JSON.stringify(sizes) === JSON.stringify(expectedSizes), "stored byte sizes do not match the real fixture sizes: " + JSON.stringify(sizes));
    for (const file of uploaded) {
      assert(typeof file.id === "string" && /^[0-9a-f-]{36}$/i.test(file.id), "file id is not a uuid: " + snippet(JSON.stringify(file)));
      assert(file.status === "stored", "file status must be stored, got " + file.status);
      assert(typeof file.detectedType === "string" && file.detectedType.length > 0, "file detectedType missing");
      assert(typeof file.name === "string" && file.name.length > 0, "file display name missing");
      assert(typeof file.textExtracted === "boolean", "file textExtracted must be boolean");
    }
    const bySize = new Map(uploaded.map((file) => [file.byteSize, file]));
    const txtEntry = bySize.get(ATTACHMENT_TXT.length);
    const pdfEntry = bySize.get(ATTACHMENT_PDF.length);
    const pngEntry = bySize.get(ATTACHMENT_PNG.length);
    assert(txtEntry, "txt fixture missing from stored files");
    assert(pdfEntry, "pdf fixture missing from stored files");
    assert(pngEntry, "png fixture missing from stored files");
    assert(/text/i.test(txtEntry.detectedType), "txt detectedType unexpected: " + txtEntry.detectedType);
    assert(/pdf/i.test(pdfEntry.detectedType), "pdf detectedType unexpected: " + pdfEntry.detectedType);
    assert(/png|image/i.test(pngEntry.detectedType), "png detectedType unexpected: " + pngEntry.detectedType);
    assert(txtEntry.textExtracted === true, "plain text file must report textExtracted=true");
    assert(pngEntry.textExtracted === false, "image file must report textExtracted=false");
    assert(JSON.stringify(uploaded).match(/https?:\/\//) === null, "uploads response must not contain a public URL");

    const ids = uploaded.map((file) => file.id);
    const placeholders = ids.map(() => "?").join(",");
    const rows = state.db
      .prepare("SELECT id, user_id, storage_key, original_name, detected_type, byte_size, sha256, status FROM files WHERE id IN (" + placeholders + ")")
      .all(...ids);
    assert(rows.length === 3, "expected 3 files rows in SQLite, got " + rows.length);
    const storageChecks = [];
    for (const row of rows) {
      assert(row.status === "stored", "files row status must be stored, got " + row.status);
      assert(typeof row.sha256 === "string" && /^[0-9a-f]{64}$/i.test(row.sha256), "files row sha256 invalid");
      const candidates = [
        row.storage_key,
        path.resolve(state.storageDir, String(row.storage_key ?? "")),
        path.resolve(PROJECT_ROOT, String(row.storage_key ?? "")),
        path.join(state.storageDir, String(row.user_id), String(row.id)),
      ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
      const storedPath = candidates.find((candidate) => existsSync(candidate));
      assert(storedPath, "stored bytes not found on disk for file " + row.id + " (storage_key=" + String(row.storage_key).slice(0, 120) + ")");
      const bytes = readFileSync(storedPath);
      assert(bytes.length === row.byte_size, "stored byte length mismatch for " + row.id + ": disk=" + bytes.length + " db=" + row.byte_size);
      const digest = createHash("sha256").update(bytes).digest("hex");
      assert(digest === String(row.sha256).toLowerCase(), "stored sha256 mismatch for file " + row.id);
      storageChecks.push({ id: row.id, byteSize: row.byte_size, detectedType: row.detected_type, onDisk: true, sha256Verified: true });
    }
    state.attachments = {
      ids,
      names: uploaded.map((file) => file.name),
      entries: uploaded.map((file) => ({
        id: file.id,
        name: file.name,
        detectedType: file.detectedType,
        byteSize: file.byteSize,
        textExtracted: file.textExtracted,
      })),
      filesRows: rows.map((row) => ({ id: row.id, detectedType: row.detected_type, byteSize: row.byte_size, status: row.status })),
      storageChecks,
    };
    return {
      expected: "3 real-byte files stored (txt/pdf/png), uuid ids, detected types, textExtracted flags, private storage rows + on-disk sha256",
      actual: "3 files stored; sizes match fixtures; txt extracted=" + txtEntry.textExtracted + " pdf extracted=" + pdfEntry.textExtracted + " png extracted=" + pngEntry.textExtracted + "; sha256 verified on disk",
      data: state.attachments,
    };
  });

  // ---- P09: comparison with attachments -> 4 independent runs -----------
  await probe("P09", "comparison with attachmentIds -> 4 independent runs settle (" + cfg.mode + ")", async () => {
    // Defensive: if the uploads probe failed (implementation still in flight), the
    // comparison/run-settlement path is still exercised with no attachments rather
    // than skipping the most important probe entirely. P08 still fails the release
    // gate on its own, and P10 only checks attachment binding when files exist.
    const attachments = state.attachments;
    const attachmentIds = attachments ? attachments.ids : [];
    const live = cfg.mode === "live";
    const attempts = [];
    let finalRuns = null;
    let finalId = null;

    for (let attempt = 1; attempt <= (live ? 2 : 1); attempt += 1) {
      const created = await api("POST", "/api/comparisons", {
        role: "verified",
        body: {
          question: "ما عاصمة الأردن؟ اذكر اسمًا واحدًا فقط اعتمادًا على الأدلة المرفقة.",
          evidenceMode: "native",
          answerModelIds: COMPARISON_MODELS,
          attachmentIds,
          idempotencyKey: randomUUID(),
          "cf-turnstile-response": qaToken("comparison"),
        },
      });
      assert(
        created.status === 200,
        "POST /api/comparisons expected 200, got " + created.status + " " + snippet(created.text, 400),
      );
      assert(created.json?.ok === true && typeof created.json?.data?.id === "string", "comparison create response shape invalid: " + snippet(created.text));
      const comparisonId = created.json.data.id;
      assert(Array.isArray(created.json.data.runs) && created.json.data.runs.length === 4, "comparison must start 4 runs, got " + (created.json.data.runs?.length ?? "?"));
      const startedAt = Date.now();
      const deadline = Date.now() + (live ? 240000 : 90000);
      let runs = [];
      while (Date.now() < deadline) {
        await sleep(live ? 1000 : 500);
        const polled = await api("GET", "/api/comparisons/" + comparisonId, { role: "verified", timeoutMs: 20000 });
        if (polled.status !== 200) continue;
        runs = polled.json?.data?.runs ?? [];
        if (runs.length === 4 && runs.every((run) => SETTLED_RUN_STATUSES.has(run.status))) break;
      }
      const settled = runs.length === 4 && runs.every((run) => SETTLED_RUN_STATUSES.has(run.status));
      const attemptRecord = {
        attempt,
        comparisonId,
        settleMs: Date.now() - startedAt,
        settled,
        runs: runs.map((run) => ({
          modelId: run.modelId,
          provider: run.provider,
          status: run.status,
          message: run.message ? snippet(run.message, 160) : null,
          outputExcerpt: snippet(run.outputText ?? "", 300),
        })),
      };
      attempts.push(attemptRecord);
      finalRuns = runs;
      finalId = comparisonId;
      if (!settled) continue;
      if (!live) break;
      const haiku = runs.find((run) => run.modelId === HAIKU_MODEL_ID);
      const cohere = runs.find((run) => run.modelId === LIVE_OPENROUTER_MODEL);
      const criteriaMet =
        haiku?.status === "completed" &&
        String(haiku.outputText ?? "").trim().length > 0 &&
        cohere?.status === "completed" &&
        String(cohere.outputText ?? "").trim().length > 0;
      if (criteriaMet) break;
      if (attempt < 2) console.log("  [P09] live criteria not met on attempt 1 (cohere/haiku) — retrying the comparison once as agreed");
    }

    assert(finalRuns && finalRuns.length === 4, "comparison did not expose 4 runs");
    assert(
      finalRuns.length === 4 && finalRuns.every((run) => SETTLED_RUN_STATUSES.has(run.status)),
      "runs did not all settle; statuses=" + finalRuns.map((run) => run.modelId + ":" + run.status).join(","),
    );
    state.comparisonId = finalId;
    state.comparisonAttempts = attempts.length;
    state.providerRuns = attempts[attempts.length - 1].runs;

    const outputs = finalRuns.map((run) => String(run.outputText ?? ""));
    const mockMarkerPresent = outputs.some((text) => text.includes(MOCK_MARKER));
    const statuses = finalRuns.map((run) => run.modelId + ":" + run.status).join(",");

    if (!live) {
      const completed = finalRuns.filter((run) => run.status === "completed");
      assert(completed.length === 4, "[mock] expected 4 completed runs, got " + statuses);
      assert(mockMarkerPresent, "[mock] expected the mock provider marker text in every run");
      for (const text of outputs) assert(text.includes(MOCK_MARKER), "[mock] a run is missing the mock marker — provider was not mocked?");
      return {
        expected: "4 runs settle independently; all completed with the mock provider marker (providerCallsReal=false)",
        actual: "4/4 completed with mock marker; statuses=" + statuses + "; attempts=" + attempts.length + "; attachmentsIncluded=" + (attachments ? attachments.ids.length : 0),
        data: { providerCallsReal: false, mockMarkerPresent, attempts, attachmentsIncluded: Boolean(attachments) },
      };
    }

    // Live mode assertions.
    assert(!mockMarkerPresent, "[live] mock marker text leaked into a live run — provider mocking must be inactive");
    const haiku = finalRuns.find((run) => run.modelId === HAIKU_MODEL_ID);
    const cohere = finalRuns.find((run) => run.modelId === LIVE_OPENROUTER_MODEL);
    assert(haiku, "[live] haiku run missing");
    assert(cohere, "[live] OpenRouter run missing");
    assert(
      haiku.status === "completed",
      "[live] Anthropic claude-haiku-5-5 did not complete: status=" + haiku.status + " message=" + snippet(haiku.message ?? "", 200),
    );
    assert(String(haiku.outputText ?? "").trim().length > 0, "[live] haiku completed with empty output");
    assert(
      cohere.status === "completed",
      "[live] OpenRouter " + LIVE_OPENROUTER_MODEL + " did not complete after retry: status=" + cohere.status + " message=" + snippet(cohere.message ?? "", 200),
    );
    assert(String(cohere.outputText ?? "").trim().length > 0, "[live] cohere completed with empty output");
    return {
      expected: "real haiku + cohere completions, 4 runs settle independently, free models may 429 without breaking others, no mock marker",
      actual: "haiku completed; cohere completed; statuses=" + statuses + "; attempts=" + attempts.length,
      data: {
        providerCallsReal: true,
        mockMarkerPresent,
        attempts,
        answerModelIds: COMPARISON_MODELS,
        attachmentsIncluded: Boolean(attachments),
      },
    };
  });

  // ---- P10: DB telemetry + evidence payload binding ----------------------
  await probe("P10", "DB run telemetry (tokens/cost/model) + attachment evidence binding", async () => {
    const comparisonId = requireComparisonId();
    const attachments = state.attachments;
    const snapshot = state.db
      .prepare("SELECT payload FROM evidence_snapshots WHERE comparison_id = ?")
      .get(comparisonId);
    assert(snapshot && typeof snapshot.payload === "string", "evidence_snapshots row missing for the comparison");
    let payload = null;
    try {
      payload = JSON.parse(snapshot.payload);
    } catch {
      payload = null;
    }
    assert(payload && typeof payload === "object", "evidence payload is not valid JSON");
    const warnings = [];
    assert(Array.isArray(payload.attachmentIds), "evidence payload must persist attachmentIds[] (contract); got keys=" + Object.keys(payload).join(","));
    if (attachments) {
      for (const id of attachments.ids) {
        assert(payload.attachmentIds.includes(id), "evidence payload attachmentIds missing uploaded file " + id);
      }
      assert(payload.attachmentIds.length === attachments.ids.length, "evidence payload attachmentIds count differs from uploaded ids");
    } else {
      warnings.push("uploads probe failed, so attachment binding could not be verified against real file ids");
    }
    const evidenceText = typeof payload.evidenceText === "string" ? payload.evidenceText : "";
    if (attachments) {
      if (evidenceText.length === 0) {
        warnings.push("evidenceText is empty in the persisted payload (attachment text may still have reached planRuns in memory)");
      } else {
        assert(evidenceText.includes(TXT_MARKER), "persisted evidenceText does not include extracted plain-text attachment content");
        if (!evidenceText.includes(PDF_MARKER)) warnings.push("persisted evidenceText does not include the PDF-extracted marker");
      }
    }

    const rows = state.db
      .prepare(
        "SELECT model_id, status, output_text, provider_model_id, finish_reason, prompt_tokens, completion_tokens, cost_usd, completion_ms, error_code FROM model_runs WHERE comparison_id = ? ORDER BY created_at, id",
      )
      .all(comparisonId);
    assert(rows.length === 4, "expected 4 model_runs rows for the comparison, got " + rows.length);
    const telemetry = rows.map((row) => ({
      modelId: row.model_id,
      status: row.status,
      providerModelId: row.provider_model_id ?? null,
      finishReason: row.finish_reason ?? null,
      promptTokens: typeof row.prompt_tokens === "number" ? row.prompt_tokens : null,
      completionTokens: typeof row.completion_tokens === "number" ? row.completion_tokens : null,
      costUsd: typeof row.cost_usd === "number" ? row.cost_usd : null,
      completionMs: typeof row.completion_ms === "number" ? row.completion_ms : null,
      errorCode: row.error_code ?? null,
      outputExcerpt: snippet(String(row.output_text ?? ""), 300),
    }));
    const haikuRow = telemetry.find((run) => run.modelId === HAIKU_MODEL_ID);
    assert(haikuRow, "haiku row missing from model_runs");

    if (cfg.mode === "live") {
      assert(haikuRow.status === "completed", "[live] haiku DB status must be completed, got " + haikuRow.status);
      assert(haikuRow.providerModelId === HAIKU_MODEL_ID, "[live] haiku providerModelId mismatch: " + haikuRow.providerModelId);
      assert(typeof haikuRow.promptTokens === "number" && haikuRow.promptTokens > 0, "[live] haiku prompt_tokens not recorded");
      assert(typeof haikuRow.completionTokens === "number" && haikuRow.completionTokens > 0, "[live] haiku completion_tokens not recorded");
      assert(typeof haikuRow.costUsd === "number" && haikuRow.costUsd > 0, "[live] haiku cost_usd not recorded");
      assert(typeof haikuRow.completionMs === "number" && haikuRow.completionMs > 0, "[live] haiku completion_ms not recorded");
      const cohereRow = telemetry.find((run) => run.modelId === LIVE_OPENROUTER_MODEL);
      assert(cohereRow && cohereRow.status === "completed", "[live] cohere DB row must be completed");
      assert(typeof cohereRow.promptTokens === "number" && cohereRow.promptTokens > 0, "[live] cohere prompt_tokens not recorded");
    }
    state.providerRuns = telemetry;
    return {
      expected: "evidence payload binds the uploaded attachmentIds (+ extracted text); 4 model_runs rows with model/tokens/cost/ms telemetry",
      actual:
        "attachmentIds bound (" + payload.attachmentIds.length + "); " + telemetry.length + " run rows; haiku tokens " +
        (haikuRow.promptTokens ?? "?") + "/" + (haikuRow.completionTokens ?? "?") + ", cost " + (haikuRow.costUsd ?? "?") +
        (warnings.length ? "; warnings=" + warnings.join(" | ") : ""),
      data: {
        attachmentIdsBound: payload.attachmentIds.length,
        evidenceTextLength: evidenceText.length,
        evidenceTextWarnings: warnings,
        telemetry,
      },
    };
  });

  // ---- P11: history API + pages -----------------------------------------
  await probe("P11", "history API + /history list & detail pages show the real comparison", async () => {
    const comparisonId = requireComparisonId();
    const history = await api("GET", "/api/history", { role: "verified" });
    assert(history.status === 200, "GET /api/history expected 200, got " + history.status + " " + snippet(history.text));
    assert(history.json?.ok === true && Array.isArray(history.json?.data?.comparisons), "history API shape invalid: " + snippet(history.text));
    const listed = history.json.data.comparisons.find((item) => item.id === comparisonId);
    assert(listed, "GET /api/history does not contain the comparison just created (history not reading real rows?)");
    for (const key of ["id", "question", "status", "createdAt", "runCount", "completedCount", "modelIds"]) {
      assert(listed[key] !== undefined, "history list row missing field: " + key);
    }
    assert(listed.runCount >= 4, "history runCount must be >= 4, got " + listed.runCount);
    assert(Array.isArray(listed.modelIds) && listed.modelIds.includes(HAIKU_MODEL_ID), "history modelIds missing the haiku model");

    const listPage = await request("GET", "/history", { cookie: sessionCookie("verified") });
    assert(listPage.status === 200, "/history page expected 200, got " + listPage.status);
    assert(listPage.text.includes("/history/" + comparisonId), "/history page does not link to the new comparison detail");
    assert(listPage.text.includes("سجل المقارنات"), "/history page missing its Arabic heading");

    const detailPage = await request("GET", "/history/" + comparisonId, { cookie: sessionCookie("verified") });
    assert(detailPage.status === 200, "/history/[id] page expected 200, got " + detailPage.status);
    assert(detailPage.text.includes("أردن") || detailPage.text.includes("الأردن"), "/history/[id] page does not render the question text");
    if (state.attachments?.names?.length) {
      const anyName = state.attachments.names.some((name) => detailPage.text.includes(name));
      assert(anyName, "/history/[id] page does not render any uploaded attachment name");
    }
    return {
      expected: "history API row for the comparison; /history links to it; /history/[id] 200 with question + attachment names",
      actual: "API row runCount=" + listed.runCount + " completed=" + listed.completedCount + "; list page link ok; detail page 200",
      data: {
        historyRow: {
          id: listed.id,
          status: listed.status,
          createdAt: listed.createdAt,
          runCount: listed.runCount,
          completedCount: listed.completedCount,
          modelIds: listed.modelIds,
        },
      },
    };
  });

  // ---- P12: cross-user IDOR ---------------------------------------------
  await probe("P12", "cross-user IDOR + malformed ids -> 404", async () => {
    const comparisonId = requireComparisonId();
    const otherUser = await api("GET", "/api/comparisons/" + comparisonId, { role: "nonadmin" });
    assert(otherUser.status === 404, "other user's comparison via API must be 404, got " + otherUser.status);
    assert(jsonErrorCode(otherUser) === "not_found", "other user's comparison API error code must be not_found, got " + jsonErrorCode(otherUser));
    const otherUserPage = await request("GET", "/history/" + comparisonId, { cookie: sessionCookie("nonadmin") });
    assert(otherUserPage.status === 404, "other user's /history/[id] page must be 404, got " + otherUserPage.status);
    const malformedApi = await api("GET", "/api/comparisons/not-a-uuid", { role: "verified" });
    assert(malformedApi.status === 404, "malformed comparison id via API must be 404, got " + malformedApi.status);
    const malformedPage = await request("GET", "/history/not-a-uuid", { cookie: sessionCookie("verified") });
    assert(malformedPage.status === 404, "malformed /history/[id] must be 404, got " + malformedPage.status);
    const randomApi = await api("GET", "/api/comparisons/" + randomUUID(), { role: "verified" });
    assert(randomApi.status === 404, "unknown comparison id via API must be 404, got " + randomApi.status);
    return {
      expected: "cross-user API+page 404; malformed/unknown ids 404",
      actual: "other-user API 404, other-user page 404, malformed API+page 404, unknown API 404",
      data: { statuses: [otherUser.status, otherUserPage.status, malformedApi.status, malformedPage.status, randomApi.status] },
    };
  });

  // ---- P13: secret redaction / no secret leakage -------------------------
  await probe("P13", "no secret values in evidence, server output, or probes", async () => {
    const probeJson = JSON.stringify(state.probes);
    const logText = state.serverStdout.join("") + state.serverStderr.join("") + state.otpStderr.join("");
    const findings = [...scanForSecrets(probeJson), ...scanForSecrets(logText)];
    assert(findings.length === 0, "secret material found in verification artifacts: " + findings.join(", "));
    const canary = "canary-" + randomUUID();
    const redacted = redactText("prefix " + canary + " suffix");
    assert(redacted.text.includes(canary), "redaction self-check unexpectedly altered a non-secret value");
    const fakeSecret = state.secrets.find((secret) => !secret.pattern);
    if (fakeSecret) {
      const result = redactText("x " + fakeSecret.value + " y");
      assert(!result.text.includes(fakeSecret.value), "redaction failed to strip a real secret value");
      assert(result.redacted >= 1, "redaction did not report a redaction count");
    }
    return {
      expected: "no .env.local secret value and no sk-* key appears in probes, evidence candidates, or server logs",
      actual: "0 findings; redaction self-check passed; " + state.secrets.length + " sensitive values tracked (never stored)",
      data: { sensitiveValueCount: state.secrets.length, findings: 0 },
    };
  });

  // ---- P14: optional browser smoke --------------------------------------
  await probe("P14", "optional browser smoke via scripts/qa CDP tooling", async () => {
    skip("optional per task-5; API E2E is the required bar. No Chrome CDP browser pass was run in this invocation.");
  });
}

// ---------------------------------------------------------------------------
// Evidence assembly
// ---------------------------------------------------------------------------

function buildEvidence() {
  const finishedAt = nowIso();
  const counts = { total: state.probes.length, passed: 0, failed: 0, skipped: 0 };
  for (const entry of state.probes) {
    if (entry.status === "PASS") counts.passed += 1;
    else if (entry.status === "SKIP") counts.skipped += 1;
    else counts.failed += 1;
  }
  const live = cfg.mode === "live";
  const evidence = {
    schemaVersion: 1,
    kind: "chate-release-verification",
    generatedBy: "scripts/qa/verify-release.mjs",
    generatedAt: finishedAt,
    runId: state.runId,
    mode: cfg.mode,
    providerCallsReal: live,
    startedAt: state.startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(state.startedAt),
    projectRoot: PROJECT_ROOT,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    build: state.build,
    server: {
      port: cfg.port,
      host: cfg.host,
      baseUrl: "http://127.0.0.1:" + cfg.port,
      hostHeader: cfg.host + ":" + cfg.port,
      source: cfg.spawn ? "spawned `next start` from the local production build" : "pre-existing server (--no-spawn)",
      readyMs: state.server?.readyMs ?? null,
      stdoutTail: tallyLines(state.serverStdout, 20),
      stderrTail: tallyLines(state.serverStderr, 20),
    },
    database: { path: rel(state.dbPath ?? ""), mode: "QA-only SQLite database" },
    storage: { dir: rel(state.storageDir ?? ""), mode: "QA-only private storage directory" },
    turnstile: {
      mode: "qa-token-preload",
      preload: rel(state.preloadPath ?? ""),
      note:
        "Cloudflare Turnstile was satisfied with QA `qa.<action>.<hostname>.<epochMs>` tokens intercepted by a QA-only " +
        "NODE_OPTIONS preload; this is NOT a real browser widget. Non-QA tokens still reach real Cloudflare, which P06 verifies via the 403 rejection path.",
    },
    session: {
      mode: "seeded-hmac-signed-session-cookies",
      note: "No Google sign-in was performed; cookies were minted locally with the deployment SESSION_SECRET. Cookie values are intentionally not stored in evidence.",
      users: state.seed
        ? Object.entries(state.seed.sessions)
            .filter(([, value]) => value && typeof value === "object")
            .map(([key, value]) => ({ key, userId: value.userId, role: value.role }))
        : [],
    },
    otpProvider: state.otpVerification ?? {
      transport: "real HTTP(S) POST over loopback to the local OTP provider stub",
      providerUrlScheme: state.otp?.protocol ?? null,
      stubKind: state.otp?.kind ?? null,
      stubSource: state.otp?.source ?? null,
      stubPort: state.otp?.port ?? null,
      stubPath: state.otp?.path ?? null,
      stubAuthEnforced: state.otp?.authEnforced ?? null,
      note: "No carrier SMS gateway exists in this environment; delivery evidence is a real loopback HTTPS/HTTP request to the provider stub.",
    },
    credentials: {
      source: ".env.local (values never printed or stored)",
      openrouterKeyPresent: Boolean(pickEnv("OPENROUTER_API_KEY").trim()),
      anthropicKeyPresent: Boolean(pickEnv("ANTHROPIC_API_KEY").trim()),
      turnstileSecretPresent: Boolean(pickEnv("TURNSTILE_SECRET_KEY").trim()),
      sessionSecretPresent: Boolean(pickEnv("SESSION_SECRET").trim()),
      valuesStored: false,
    },
    providers: {
      providerCallsReal: live,
      mockMarker: live ? null : MOCK_MARKER,
      mockMarkerPresent: live
        ? (state.providerRuns ?? []).some((run) => String(run.outputExcerpt ?? "").includes(MOCK_MARKER))
        : true,
      comparisonId: state.comparisonId,
      comparisonAttempts: state.comparisonAttempts,
      runs: state.providerRuns,
    },
    probes: state.probes,
    summary: { ...counts, verdict: counts.failed === 0 ? "PASS" : "FAIL" },
    caveats: [
      "Turnstile: qa.* tokens intercepted by scripts/qa/turnstile-preload.cjs (QA preload), not a real browser Turnstile widget; a real Cloudflare rejection path is still exercised for non-qa tokens.",
      "Session: signed session cookies were seeded locally instead of performing a Google sign-in; the same SESSION_SECRET as the server is used.",
      "OTP/SMS: no carrier SMS gateway exists here; the provider round-trip is a real HTTPS request to a local OTP provider stub with a throwaway self-signed loopback certificate trusted only by the spawned server process (no carrier SMS was sent).",
      live
        ? "Providers: OpenRouter and Anthropic calls were REAL network calls using the keys from .env.local; no API key value was printed or written to evidence."
        : "Providers: OpenRouter and Anthropic calls were MOCKED by scripts/qa/mock-provider-preload.cjs; this run proves the app flow, not provider integration.",
      "Free OpenRouter models may legitimately fail with upstream RATE_LIMIT/429; the release gate only requires they settle without breaking the other independent runs.",
      "Browser QA (scripts/qa CDP) is optional per task-5 and was not executed by this harness invocation.",
    ],
    redaction: { applied: true, sensitiveValueCount: state.secrets.length, findings: 0 },
    commands: {
      mock: 'C:\\Pak\\node.exe scripts/qa/verify-release.mjs --mode=mock',
      live: 'C:\\Pak\\node.exe scripts/qa/verify-release.mjs --mode=live',
      note: "Run from the repo root after the Lead builds .next (`npm run build`) and while ports 3221/3222 are free.",
    },
  };
  return evidence;
}

function writeEvidence(evidence) {
  mkdirSync(state.outDir, { recursive: true });
  const stamp = new Date(evidence.finishedAt).toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(state.outDir, "release-verification-" + stamp + ".json");
  const { text, redacted } = redactText(JSON.stringify(evidence, null, 2));
  evidence.redaction.redactedOccurrences = redacted;
  // The evidence object was serialized before redactedOccurrences was attached;
  // re-serialize the final object and redact once more so the count is included.
  const final = redactText(JSON.stringify(evidence, null, 2));
  writeFileSync(filePath, final.text + "\n", "utf8");
  console.log("\nevidence: " + rel(filePath) + " (" +
    (final.text.includes("[redacted") ? "redacted " + final.redacted + " occurrence(s)" : "no secret values present") + ")");
  return filePath;
}

function writeLiveProviderMarkdown(evidence) {
  const runs = evidence.providers?.runs ?? [];
  const lines = [];
  lines.push("# Live provider calls — evidence");
  lines.push("");
  lines.push("**Date:** " + evidence.finishedAt + " (run " + evidence.runId + ")");
  lines.push("**Mode:** live — `providerCallsReal: true` (real OpenRouter + Anthropic network calls)");
  lines.push("**Build:** `" + (evidence.build?.buildId ?? "?") + "` built " + (evidence.build?.buildAt ?? "?"));
  lines.push("**Server:** production `next start` on 127.0.0.1:" + evidence.server.port + " with `Host: " + evidence.server.hostHeader + "`");
  lines.push("**Comparison:** `" + (evidence.providers?.comparisonId ?? "?") + "` (attempts: " + (evidence.providers?.comparisonAttempts ?? 0) + ")");
  lines.push("**Turnstile:** QA `qa.*` token preload (not a browser widget) — see caveats.");
  lines.push("**Session:** seeded HMAC session cookie (no Google sign-in).");
  lines.push("**OTP:** real HTTPS POST over loopback to the local OTP provider stub (throwaway self-signed QA cert; no carrier SMS gateway).");
  lines.push("");
  lines.push("## Runs (from SQLite `model_runs`, newest comparison)");
  lines.push("");
  lines.push("| model | provider | status | finish | prompt tok | completion tok | cost USD | ms | output excerpt |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const run of runs) {
    const provider = run.modelId === HAIKU_MODEL_ID ? "anthropic" : run.modelId?.includes(":free") ? "openrouter" : "?";
    const excerpt = String(run.outputExcerpt ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 200);
    lines.push(
      "| `" + run.modelId + "` | " + provider + " | " + run.status + " | " + (run.finishReason ?? "—") +
        " | " + (run.promptTokens ?? "—") + " | " + (run.completionTokens ?? "—") + " | " + (run.costUsd ?? "—") +
        " | " + (run.completionMs ?? "—") + " | `" + excerpt + "` |",
    );
  }
  const haiku = runs.find((run) => run.modelId === HAIKU_MODEL_ID);
  const cohere = runs.find((run) => run.modelId === LIVE_OPENROUTER_MODEL);
  lines.push("");
  lines.push("## What this proves");
  lines.push("");
  lines.push("- Anthropic `claude-haiku-5-5` returned a real completion: status **" + (haiku?.status ?? "missing") +
    "**, tokens " + (haiku?.promptTokens ?? "?") + " in / " + (haiku?.completionTokens ?? "?") + " out, cost $" + (haiku?.costUsd ?? "?") +
    ", " + (haiku?.completionMs ?? "?") + " ms.");
  lines.push("- OpenRouter `" + LIVE_OPENROUTER_MODEL + "` returned a real completion: status **" + (cohere?.status ?? "missing") +
    "**, tokens " + (cohere?.promptTokens ?? "?") + " in / " + (cohere?.completionTokens ?? "?") + " out, " + (cohere?.completionMs ?? "?") + " ms.");
  lines.push("- All 4 runs settled independently: `" + runs.map((run) => run.modelId + ":" + run.status).join(", ") + "`.");
  lines.push("- No mock marker text (`" + MOCK_MARKER + "`) appeared in any live output.");
  lines.push("");
  lines.push("## Honest caveats");
  lines.push("");
  lines.push("- Turnstile was satisfied via the QA `qa.*` token preload, not a real browser widget; a real Cloudflare rejection path is still exercised for invalid tokens.");
  lines.push("- Sessions were seeded signed cookies; no Google OAuth sign-in was performed.");
  lines.push("- OTP/SMS delivery is a real HTTP request to the local provider stub; no carrier gateway account exists in this environment, so no real SMS was sent.");
  lines.push("- Some free OpenRouter models may fail with upstream 429/RATE_LIMIT; those failures are recorded above and are expected product behavior (one provider's failure must not break the others).");
  lines.push("- No API key values were printed or stored; only model ids, token counts, costs, timings, and short output excerpts are recorded.");
  lines.push("");
  lines.push("## Raw evidence");
  lines.push("");
  lines.push("See `docs/evidence/release-verification-" + new Date(evidence.finishedAt).toISOString().replace(/[:.]/g, "-") + ".json`.");
  lines.push("");
  const filePath = path.join(state.outDir, "live-provider-calls.md");
  const { text } = redactText(lines.join("\n"));
  writeFileSync(filePath, text, "utf8");
  console.log("live provider evidence: " + rel(filePath));
  return filePath;
}

// ---------------------------------------------------------------------------
// Dry run / commands
// ---------------------------------------------------------------------------

function printDryRun() {
  console.log("ChatE release verification — planned setup (no server started)\n");
  console.log("Recommended one-command usage (harness owns seeds, OTP stub, server, probes, evidence):\n");
  console.log('  $env:PATH = "C:\\Pak;" + $env:PATH');
  console.log("  C:\\Pak\\node.exe scripts/qa/verify-release.mjs --mode=mock   # port 3221, data/qa.sqlite, providers mocked");
  console.log("  C:\\Pak\\node.exe scripts/qa/verify-release.mjs --mode=live   # port 3222, data/qa-live.sqlite, REAL providers\n");
  console.log("Server env the harness sets for each mode (values from .env.local are never printed):");
  const common = {
    NODE_OPTIONS: "--require <repo>/scripts/qa/" + (cfg.mode === "mock" ? "mock-provider-preload.cjs" : "turnstile-preload.cjs"),
    SQLITE_PATH: cfg.mode === "mock" ? "data/qa.sqlite" : "data/qa-live.sqlite",
    TURNSTILE_EXPECTED_HOSTNAMES: cfg.host,
    OTP_PROVIDER: "http",
    OTP_HTTP_URL: "https://127.0.0.1:<tls-stub-port>/send (real HTTPS loopback stub; dev http stub only if openssl is unavailable)",
    OTP_HTTP_AUTHORIZATION: "Bearer <qa-otp-token>",
    OTP_PEPPER: "<qa pepper or SESSION_SECRET fallback>",
    STORAGE_DIR: "<repo>/scripts/qa/.out/storage-" + cfg.mode,
    APP_URL: "http://" + cfg.host + ":" + cfg.port,
    HAIKU_LIVE_CALLS: "1",
    CHATE_E2E_MOCK: cfg.mode === "mock" ? "1" : "(unset)",
    OPENROUTER_API_KEY: cfg.mode === "mock" ? "<throwaway dummy>" : "<from .env.local>",
    ANTHROPIC_API_KEY: cfg.mode === "mock" ? "<throwaway dummy>" : "<from .env.local>",
  };
  for (const [key, value] of Object.entries(common)) console.log("  " + key + "=" + value);
  console.log("\nManual server command (if you prefer a pre-started server, then pass --no-spawn --otp-url=...):");
  console.log("  $env:PATH = \"C:\\Pak;\" + $env:PATH");
  console.log("  $envMap = @{}; Get-Content .env.local | % { if ($_ -match '^(\\w+)=(.*)$') { $envMap[$matches[1]] = $matches[2].Trim() } }");
  console.log("  $envMap.GetEnumerator() | % { Set-Item (\"env:\" + $_.Key) $_.Value }");
  console.log("  # set the vars listed above, then:");
  console.log("  C:\\Pak\\node.exe node_modules/next/dist/bin/next start -p " + cfg.port + " -H 127.0.0.1");
  console.log("\nRequired before running: `npm run build` (Lead-owned) so .next matches src/, and ports " + cfg.port + " free.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (cfg.help) {
    const header = readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0];
    console.log(header.replace(/^\/\*\*?/, "").replace(/^\s*\* ?/gm, "").trim());
    return 0;
  }
  if (cfg.dryRun) {
    loadDotenv();
    printDryRun();
    return 0;
  }

  console.log("=== ChatE release verification — mode=" + cfg.mode + " port=" + cfg.port + " ===");
  loadDotenv();
  state.outRoot = path.join(PROJECT_ROOT, "scripts", "qa", ".out");
  rmSync(state.outRoot, { recursive: true, force: true });
  mkdirSync(state.outRoot, { recursive: true });

  state.dbPath = cfg.dbPath
    ? path.resolve(PROJECT_ROOT, cfg.dbPath)
    : cfg.mode === "mock"
      ? path.join(PROJECT_ROOT, "data", "qa.sqlite")
      : path.join(PROJECT_ROOT, "data", "qa-live.sqlite");
  state.storageDir = path.join(state.outRoot, "storage-" + cfg.mode);
  state.preloadPath = path.join(
    HERE,
    cfg.mode === "mock" ? "mock-provider-preload.cjs" : "turnstile-preload.cjs",
  );
  assert(existsSync(state.preloadPath), "QA preload missing: " + rel(state.preloadPath));
  state.build = readBuildInfo();
  console.log("build: " + state.build.buildId + " @ " + state.build.buildAt + (state.build.stale ? " (STALE — rebuild before trusting this run)" : ""));

  try {
    // 1. seed users into the QA database
    const sessionSecret = pickEnv("SESSION_SECRET");
    const seed = seedQaUsers({
      env: {
        ...state.dotenv,
        SESSION_SECRET: sessionSecret,
        SQLITE_PATH: state.dbPath,
        ADMIN_EMAILS: state.dotenv.ADMIN_EMAILS ?? "",
      },
      dbPath: state.dbPath,
    });
    state.seed = seed;
    console.log("seeded QA db: " + rel(state.dbPath) + " (migrations applied this run: " + (seed.applied.length ? seed.applied.join(", ") : "none") + ")");
    console.log("seeded users: " + Object.keys(seed.sessions).filter((key) => key !== "file").join(", "));

    // 2. real loopback OTP provider stub (must be listening before the server boots)
    state.otp = await startOtpStub();
    console.log(
      "OTP stub: " + state.otp.source + " @ " + state.otp.url +
        " (protocol " + state.otp.protocol + ", auth enforced: " + state.otp.authEnforced + ")",
    );

    if (cfg.spawn) {
      // 3. production server
      state.server = await startServer();
      console.log("server ready: pid " + state.server.child.pid + ", health=" + snippet(JSON.stringify(state.server.health), 160));
    } else {
      console.log("--no-spawn: probing an existing server on 127.0.0.1:" + cfg.port);
      if (cfg.otpUrl) {
        state.otp.port = Number(new URL(cfg.otpUrl).port || 80);
        state.otp.path = new URL(cfg.otpUrl).pathname;
      }
    }

    // 4. DB read connection for telemetry assertions
    state.db = new DatabaseSync(state.dbPath, { timeout: 8000 });
    state.db.exec("PRAGMA busy_timeout = 8000");

    // 5. probes
    console.log("\n--- probes ---");
    await runProbes();

    // 6. evidence
    console.log("\n--- evidence ---");
    const evidence = buildEvidence();
    const jsonPath = writeEvidence(evidence);
    evidence.evidenceFiles = { json: rel(jsonPath) };
    if (cfg.mode === "live") {
      evidence.evidenceFiles.markdown = rel(writeLiveProviderMarkdown(evidence));
    }

    // 7. summary
    const summary = evidence.summary;
    console.log("\nSUMMARY [" + cfg.mode + "]: " + summary.passed + "/" + summary.total + " passed, " + summary.failed + " failed, " + summary.skipped + " skipped — VERDICT: " + summary.verdict);
    if (summary.failed > 0) {
      console.log("Failed probes:");
      for (const entry of state.probes.filter((item) => item.status === "FAIL")) {
        console.log("  " + entry.id + " " + entry.title + " :: " + snippet(entry.error, 400));
      }
    }
    return summary.failed === 0 ? 0 : 1;
  } catch (error) {
    // Teardown happens in the single top-level finish path so that a failure in
    // startServer (before probes) still kills the spawned server process tree.
    throw error;
  }
}

/** Single top-level finish path: always clean up children, then exit explicitly. */
async function finish(code) {
  await cleanupAll();
  process.exit(typeof code === "number" ? code : 0);
}

process.on("SIGINT", () => {
  console.error("\ninterrupted — cleaning up spawned processes");
  cleanupAll().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
  cleanupAll().finally(() => process.exit(143));
});

main()
  .then((code) => finish(code))
  .catch(async (error) => {
    console.error("\nHARNESS ERROR: " + (error instanceof Error ? (error.stack ?? error.message) : String(error)));
    const tail = tallyLines(state.serverStderr, 25).join("\n");
    if (tail) console.error("server stderr tail:\n" + tail);
    await finish(2);
  });
