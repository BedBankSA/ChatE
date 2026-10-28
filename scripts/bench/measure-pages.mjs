#!/usr/bin/env node
/**
 * measure-pages.mjs - zero-dependency HTTP latency/throughput benchmark for ChatE.
 *
 * Uses node:http with a keep-alive agent (no npm dependencies, no undici
 * extensions). Measures time-to-first-byte and total time per request, then
 * reports p50/p95/p99 and requests/second per concurrency level.
 *
 * Safe by construction: GET/HEAD only against the routes listed below. It never
 * posts to /api/comparisons, /api/uploads or /api/otp/send, so no provider can
 * be called and no paid traffic can be generated.
 *
 * Usage:
 *   node scripts/bench/measure-pages.mjs --base=http://127.0.0.1:3211
 *   node scripts/bench/measure-pages.mjs --concurrency=1,10,50 --requests=100 --json
 *   node scripts/bench/measure-pages.mjs --only=home --requests=30
 *
 * Flags: --base, --concurrency, --requests, --warmup, --timeout, --only,
 *        --json, --out=path, --no-warmup, --raw=path
 */
import http from "node:http";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes("--" + name);
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = new URL(opt("base", "http://127.0.0.1:3211"));
const CONCURRENCY = opt("concurrency", "1,10,50").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
const REQUESTS = Number(opt("requests", "80"));
const WARMUP = flag("no-warmup") ? 0 : Number(opt("warmup", "5"));
const TIMEOUT_MS = Number(opt("timeout", "15000"));
const ONLY = opt("only", null);
const JSON_OUT = flag("json");
const OUT = opt("out", null);
const RAW = opt("raw", null);
const SESSION = flag("session");

// Optional authenticated run: forge the app's own signed session cookie from
// SESSION_SECRET in .env.local. The secret and the cookie are never printed.
// This only enables GETs of pages/routes that require a session; no user row is
// created and no admin privilege is claimed.
let cookieHeader = null;
if (SESSION) {
  let envText = "";
  try { envText = readFileSync(path.join(process.cwd(), ".env.local"), "utf8"); }
  catch { console.error("--session requires a readable .env.local in " + process.cwd()); process.exit(2); }
  const match = envText.match(/^SESSION_SECRET=(.*)$/m);
  if (!match) { console.error("--session requested but SESSION_SECRET is absent from .env.local"); process.exit(2); }
  const secret = match[1].trim().replace(/^["']|["']$/g, "");
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ userId: "bench-user", googleSub: "bench-sub", exp: nowSec + 3600, iat: nowSec, csrf: "bench-csrf" })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  cookieHeader = "chate_session=" + payload + "." + signature;
  console.log("[--session] forged a signed cookie for GET-only authenticated routes (secret and cookie value redacted)");
}

const DEFAULT_TARGETS = [
  { name: "home", path: "/", kind: "page" },
  { name: "workspace-redirect", path: "/workspace", kind: "redirect" },
  { name: "history", path: "/history", kind: "page" },
  { name: "privacy", path: "/privacy", kind: "page" },
  { name: "admin-page", path: "/admin", kind: "page" },
  { name: "api-models", path: "/api/models", kind: "api" },
  { name: "api-admin-401", path: "/api/admin/overview", kind: "api-401" },
  { name: "api-comparisons-get", path: "/api/comparisons", kind: "api-405" },
  { name: "not-found", path: "/missing-bench-page", kind: "page-404" },
];
const SESSION_TARGETS = [
  { name: "workspace-authed", path: "/workspace", kind: "page-authed" },
  { name: "api-admin-forbidden", path: "/api/admin/overview", kind: "api-403" },
  { name: "api-comparison-missing", path: "/api/comparisons/00000000-0000-0000-0000-000000000000", kind: "api-404" },
];
const TARGETS = (SESSION ? DEFAULT_TARGETS.concat(SESSION_TARGETS) : DEFAULT_TARGETS).filter((t) => !ONLY || ONLY.split(",").includes(t.name));

const agent = new http.Agent({ keepAlive: true, maxSockets: Math.max(...CONCURRENCY) + 4 });
const rawSamples = [];

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function request(target) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let firstByte = null;
    const req = http.request(
      { hostname: BASE.hostname, port: BASE.port, path: target.path, method: "GET", agent, headers: Object.assign({ "cache-control": "no-cache", "accept-encoding": "gzip", "accept": "text/html,application/json;q=0.9,*/*;q=0.8" }, cookieHeader ? { cookie: cookieHeader } : {}) },
      (res) => {
        let size = 0;
        res.once("data", () => { firstByte = Number(process.hrtime.bigint() - started) / 1e6; });
        res.on("data", (chunk) => { size += chunk.length; });
        res.on("end", () => {
          const total = Number(process.hrtime.bigint() - started) / 1e6;
          resolve({ target: target.name, status: res.statusCode, ttfb: firstByte ?? total, total, bytes: size, encoding: res.headers["content-encoding"] || "identity", error: null });
        });
      },
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.on("error", (error) => {
      const total = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ target: target.name, status: 0, ttfb: null, total, bytes: 0, error: String(error && error.message ? error.message : error) });
    });
    req.end();
  });
}

async function sequentialPhase() {
  const rows = [];
  for (const target of TARGETS) {
    for (let i = 0; i < WARMUP; i += 1) await request(target);
    for (let i = 0; i < REQUESTS; i += 1) rows.push(await request(target));
  }
  return rows;
}

async function concurrentPhase(concurrency) {
  const rows = [];
  let cursor = 0;
  const perWorker = Math.max(1, Math.floor(REQUESTS / concurrency));
  const workers = Array.from({ length: concurrency }, async () => {
    for (let i = 0; i < perWorker; i += 1) {
      const target = TARGETS[(cursor++) % TARGETS.length];
      rows.push(await request(target));
    }
  });
  const started = Date.now();
  await Promise.all(workers);
  return { rows, elapsedMs: Date.now() - started };
}

function summarize(rows) {
  const ok = rows.filter((row) => !row.error);
  const totals = ok.map((row) => row.total).sort((a, b) => a - b);
  const ttfb = ok.map((row) => row.ttfb).filter((n) => n != null).sort((a, b) => a - b);
  const elapsed = rows.reduce((acc, row) => acc + row.total, 0);
  return {
    count: rows.length,
    ok: ok.length,
    errors: rows.filter((row) => row.error).length,
    statusCounts: rows.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {}),
    p50: percentile(totals, 0.5),
    p95: percentile(totals, 0.95),
    p99: percentile(totals, 0.99),
    max: totals.length ? totals[totals.length - 1] : null,
    ttfbP50: percentile(ttfb, 0.5),
    ttfbP95: percentile(ttfb, 0.95),
    meanTotal: ok.length ? ok.reduce((acc, row) => acc + row.total, 0) / ok.length : null,
    bytesPerRequest: ok.filter((row) => row.bytes > 0).length ? Math.round(ok.reduce((acc, row) => acc + row.bytes, 0) / Math.max(1, ok.filter((row) => row.bytes > 0).length)) : null,
    sumMs: elapsed,
  };
}

function groupByTarget(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.target)) map.set(row.target, []);
    map.get(row.target).push(row);
  }
  return [...map.entries()].map(([name, list]) => ({ target: name, ...summarize(list) }));
}

const result = {
  generatedAt: new Date().toISOString(),
  base: BASE.href,
  node: process.version,
  requestsPerLevel: REQUESTS,
  timeoutMs: TIMEOUT_MS,
  keepAlive: true,
  sessionMode: SESSION,
  phases: [],
  notes: [
    "Latency includes the server rendering/runtime cost and the local loopback network only.",
    "Requests send Accept-Encoding: gzip, so byte counts are the compressed transfer size when the server compresses.",
    "The server's own mode (dev vs production) is the dominant factor; record it with the run.",
    "This benchmark never sends write requests or provider-triggering requests.",
  ],
};

if (!JSON_OUT) console.log("ChatE page benchmark against " + BASE.href + " (node " + process.version + ", keep-alive)");
for (const concurrency of CONCURRENCY) {
  let phase;
  if (concurrency === 1) {
    const rows = await sequentialPhase();
    phase = { concurrency, kind: "sequential-per-target", rows, elapsedMs: rows.reduce((acc, row) => acc + row.total, 0), perTarget: groupByTarget(rows) };
  } else {
    const run = await concurrentPhase(concurrency);
    const summarized = summarize(run.rows);
    phase = { concurrency, kind: "concurrent-mixed", rows: run.rows, elapsedMs: run.elapsedMs, throughputRps: run.elapsedMs > 0 ? Math.round((run.rows.filter((r) => !r.error).length / run.elapsedMs) * 10000) / 10 : null, summary: summarized, perTarget: groupByTarget(run.rows) };
  }
  result.phases.push(phase);
  if (RAW) rawSamples.push(...phase.rows.map((row) => ({ ...row, concurrency })));
  if (!JSON_OUT) {
  const ms = (value) => value == null ? "err" : Number(value).toFixed(2);
    if (concurrency === 1) {
      console.log("");
      console.log("SEQUENTIAL (concurrency=1, " + REQUESTS + " requests per target, warmup " + WARMUP + ")");
      console.log("  target".padEnd(24) + "status".padEnd(8) + "p50 ms".padStart(9) + "p95 ms".padStart(9) + "ttfb p50".padStart(11) + "bytes".padStart(9));
      const encodings = new Map();
      for (const row of phase.rows) encodings.set(row.encoding, (encodings.get(row.encoding) || 0) + 1);
      console.log("  response encodings: " + JSON.stringify([...encodings.entries()]));
      for (const row of phase.perTarget) {
        console.log("  " + row.target.padEnd(22) + JSON.stringify(row.statusCounts).padEnd(8) + ms(row.p50).padStart(9) + ms(row.p95).padStart(9) + ms(row.ttfbP50).padStart(11) + String(row.bytesPerRequest ?? "-").padStart(9));
      }
    } else {
      const s = phase.summary;
      console.log("");
      console.log("CONCURRENT c=" + concurrency + " (" + phase.rows.length + " mixed requests, throughput " + phase.throughputRps + " req/s)");
      console.log("  p50 " + ms(s.p50) + " ms | p95 " + ms(s.p95) + " ms | p99 " + ms(s.p99) + " ms | ttfb p50 " + ms(s.ttfbP50) + " ms | ttfb p95 " + ms(s.ttfbP95) + " ms | errors " + s.errors + " | statuses " + JSON.stringify(s.statusCounts));
      console.log("  per-target p50/p95: " + phase.perTarget.map((row) => row.target + "=" + (row.p50 != null ? row.p50.toFixed(1) : "err") + "/" + (row.p95 != null ? row.p95.toFixed(1) : "err")).join(", "));
    }
  }
}

// Event-loop responsiveness of the benchmark client, not the server. Kept for context.
const loopLag = await new Promise((resolve) => {
  const expected = 50;
  let last = Date.now();
  let worst = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last - expected);
    last = now;
    ticks += 1;
    if (ticks >= 10) { clearInterval(timer); resolve(worst); }
  }, expected);
});
result.clientLoopLagWorstMs = loopLag;
if (!JSON_OUT) console.log(""); console.log("benchmark-client event-loop worst lag during idle tail: " + loopLag + " ms (server event loop is not measurable from outside without instrumentation)");

agent.destroy();
if (RAW) writeFileSync(path.resolve(RAW), JSON.stringify(rawSamples, null, 2));
if (OUT) writeFileSync(path.resolve(OUT), JSON.stringify(result, null, 2));
if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
