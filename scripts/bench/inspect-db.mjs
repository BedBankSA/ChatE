#!/usr/bin/env node
/**
 * inspect-db.mjs - zero-dependency SQLite inspector for ChatE.
 *
 * Works on a COPY (never touches data/chate.sqlite). Read-only inspection plus
 * an optional growth simulation that inserts synthetic rows into a throwaway
 * copy to measure bytes per 1,000 comparisons.
 *
 * Usage:
 *   node scripts/bench/inspect-db.mjs                       # human report
 *   node scripts/bench/inspect-db.mjs --json                # machine JSON
 *   node scripts/bench/inspect-db.mjs --simulate=1000       # growth sim rows
 *   node scripts/bench/inspect-db.mjs --db data/chate.sqlite --copy-dir scripts/bench/tmp
 *
 * Flags: --db, --copy-dir, --keep, --json, --out=path, --simulate=<comparisons>
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const flag = (name) => args.includes("--" + name);
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const ROOT = process.cwd();
const DB = path.resolve(opt("db", path.join(ROOT, "data", "chate.sqlite")));
const COPY_DIR = path.resolve(opt("copy-dir", path.join(ROOT, "scripts", "bench", "tmp")));
const SIMULATE = Number(opt("simulate", "200"));
const result = {
  generatedAt: new Date().toISOString(),
  source: DB,
  sourceBytes: 0,
  walBytes: 0,
  shmBytes: 0,
  copy: null,
  pragmas: {},
  integrity: null,
  page: null,
  vacuumIntoBytes: null,
  tables: [],
  indexes: [],
  queryPlans: [],
  hotQueryFindings: [],
  growth: null,
  retention: null,
  warnings: [],
};

function bytes(file) { try { return statSync(file).size; } catch { return 0; } }
function q1(db, sql, ...params) { try { return db.prepare(sql).get(...params) || null; } catch { return null; } }
function num(value) { return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0; }
function quoteName(name) { return "\"" + String(name).replaceAll("\"", "\"\"") + "\""; }

result.sourceBytes = bytes(DB);
result.walBytes = bytes(DB + "-wal");
result.shmBytes = bytes(DB + "-shm");
if (!existsSync(DB)) { console.error("database not found: " + DB); process.exit(2); }

mkdirSync(COPY_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const copyPath = path.join(COPY_DIR, "chate-copy-" + stamp + ".sqlite");
copyFileSync(DB, copyPath);
if (existsSync(DB + "-wal")) copyFileSync(DB + "-wal", copyPath + "-wal");
if (existsSync(DB + "-shm")) copyFileSync(DB + "-shm", copyPath + "-shm");
result.copy = copyPath;

function open(file, readOnly) { return new DatabaseSync(file, { readOnly, enableForeignKeyConstraints: false, timeout: 5000 }); }

let db;
try { db = open(copyPath, true); q1(db, "SELECT count(*) AS n FROM sqlite_master"); }
catch (error) { result.warnings.push("readOnly open failed; retrying read-write on the copy: " + String(error).slice(0, 100)); db = open(copyPath, false); }

for (const name of ["page_size", "page_count", "freelist_count", "journal_mode", "synchronous", "busy_timeout", "cache_size", "mmap_size", "temp_store", "auto_vacuum", "wal_autocheckpoint", "user_version"]) {
  const row = q1(db, "PRAGMA " + name);
  result.pragmas[name] = row ? (row[name] ?? Object.values(row)[0]) : null;
}
const pageSize = num(result.pragmas.page_size);
const pageCount = num(result.pragmas.page_count);
const freelist = num(result.pragmas.freelist_count);
result.page = { pageSize, pageCount, freelist, dbBytes: pageSize * pageCount, freeBytes: pageSize * freelist };

const quick = q1(db, "PRAGMA quick_check");
const full = q1(db, "PRAGMA integrity_check");
result.integrity = { quick: quick ? Object.values(quick)[0] : null, full: full ? Object.values(full)[0] : null };

const master = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index','view','trigger') ORDER BY type, name").all();
const tableNames = master.filter((row) => row.type === "table" && !String(row.name).startsWith("sqlite_")).map((row) => String(row.name));
for (const row of master) {
  if (row.type !== "index") continue;
  const index = { name: row.name, table: row.tbl_name, sql: row.sql, bytes: null };
  const stat = q1(db, "SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name = ?", row.name);
  if (stat) index.bytes = num(stat.bytes);
  result.indexes.push(index);
}
for (const name of tableNames) {
  const count = q1(db, "SELECT COUNT(*) AS n FROM " + quoteName(name));
  const entry = { name, rows: num(count?.n), bytes: null, columns: [] };
  const stat = q1(db, "SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name = ?", name);
  if (stat) entry.bytes = num(stat.bytes);
  try { entry.columns = db.prepare("PRAGMA table_info(" + quoteName(name) + ")").all().map((c) => c.name + ":" + c.type); } catch {}
  result.tables.push(entry);
}
result.tables.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));

const plans = [
  { id: "profile-read", file: "src/server/db/profiles.ts:24", sql: "SELECT u.name, u.email, u.status, p.phone_e164, p.phone_verified_at, p.age, p.city FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?", params: ["bench-user"] },
  { id: "admin-identity", file: "src/server/admin/identity.ts:8", sql: "SELECT id, google_sub, email FROM users WHERE id = ? AND google_sub = ?", params: ["bench-user", "bench-sub"] },
  { id: "sessions-by-user", file: "src/server/account-access.ts:6", sql: "SELECT id, user_id, expires_at FROM sessions WHERE user_id = ?", params: ["bench-user"] },
  { id: "comparison-by-key", file: "src/server/comparisons/store.ts:257", sql: "SELECT id FROM comparisons WHERE user_id = ? AND idempotency_key = ?", params: ["bench-user", "bench-key"] },
  { id: "comparison-read", file: "src/server/comparisons/store.ts:94", sql: "SELECT id, question, status FROM comparisons WHERE id = ? AND user_id = ?", params: ["bench-id", "bench-user"] },
  { id: "comparison-runs", file: "src/server/comparisons/store.ts:342", sql: "SELECT model_id, status, output_text, requested_settings, cost_usd, completion_ms FROM model_runs WHERE comparison_id = ? ORDER BY created_at, id", params: ["bench-id"] },
  { id: "comparison-meta", file: "src/server/comparisons/store.ts:126", sql: "SELECT c.user_id, c.status, c.idempotency_key, j.id AS job_id FROM comparisons c LEFT JOIN jobs j ON j.user_id = c.user_id AND j.queue = 'comparison' AND j.idempotency_key = c.idempotency_key AND j.provider = 'none' WHERE c.id = ?", params: ["bench-id"] },
  { id: "quota-read", file: "src/server/db/quota.ts:121", sql: "SELECT limit_units, used_units, reserved_units, in_flight FROM quota_accounts WHERE id = ?", params: ["shared:openrouter"] },
  { id: "reservation-idempotency", file: "src/server/db/quota.ts:97", sql: "SELECT idempotency_key FROM usage_reservations WHERE user_id = ? AND idempotency_key = ? AND provider = ?", params: ["bench-user", "bench-key", "openrouter"] },
  { id: "job-idempotency", file: "src/server/db/quota.ts:103", sql: "SELECT id FROM jobs WHERE user_id = ? AND queue = ? AND idempotency_key = ? AND provider = ?", params: ["bench-user", "comparison", "bench-key", "none"] },
  { id: "job-claim", file: "src/server/db/jobs.ts:7", sql: "UPDATE jobs SET status = 'active' WHERE status = 'queued' AND (? IS NULL OR queue = ?) AND (not_before IS NULL OR not_before <= strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND id = (SELECT id FROM jobs WHERE status = 'queued' AND (? IS NULL OR queue = ?) AND (not_before IS NULL OR not_before <= strftime('%Y-%m-%dT%H:%M:%fZ','now')) ORDER BY created_at, id LIMIT 1)", params: [null, null, null, null] },
  { id: "job-requeue-stale", file: "src/server/db/jobs.ts:68", sql: "UPDATE jobs SET status = 'queued' WHERE status = 'active' AND claimed_at IS NOT NULL AND claimed_at < ?", params: ["2026-01-01T00:00:00.000Z"] },
  { id: "admin-questions-count", file: "src/server/admin/overview.ts:155", sql: "SELECT COUNT(*) AS n FROM operation_stats WHERE operation_type = ? AND occurred_at >= ? AND occurred_at < ?", params: ["question", "2026-01-01", "2026-12-31"] },
  { id: "admin-failures-count", file: "src/server/admin/overview.ts:162", sql: "SELECT COUNT(*) AS n FROM operation_stats WHERE status = 'failed' AND occurred_at >= ? AND occurred_at < ?", params: ["2026-01-01", "2026-12-31"] },
  { id: "admin-audit", file: "src/server/admin/overview.ts:204", sql: "SELECT id, admin_user_id, action, target, created_at FROM admin_audit_events ORDER BY created_at DESC LIMIT 20", params: [] },
  { id: "admin-users-page", file: "src/server/admin/users.ts:97", sql: "SELECT u.id, u.email, u.created_at, (SELECT COUNT(*) FROM operation_stats s WHERE s.user_id = u.id AND s.operation_type = 'question' AND s.occurred_at >= ? AND s.occurred_at < ?) AS questions_in_range FROM users u LEFT JOIN profiles p ON p.user_id = u.id LEFT JOIN quota_accounts q ON q.id = ('user:' || u.id) ORDER BY u.created_at DESC LIMIT 25", params: ["2026-01-01", "2026-12-31"] },
  { id: "presence-sweep", file: "src/server/admin/operations.ts:174", sql: "DELETE FROM presence WHERE expires_at <= ?", params: ["2026-01-01T00:00:00.000Z"] },
  { id: "presence-count", file: "src/server/admin/operations.ts:175", sql: "SELECT COUNT(DISTINCT user_id) AS registered, COALESCE(SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END), 0) AS anonymous FROM presence WHERE expires_at > ?", params: ["2026-01-01T00:00:00.000Z"] },
  { id: "turnstile-replay-lookup", file: "src/server/turnstile-replay.ts:23", sql: "SELECT 1 AS seen FROM turnstile_tokens WHERE token_hash = ? AND expires_at > ?", params: ["bench-token", "2026-01-01T00:00:00.000Z"] },
  { id: "turnstile-expiry-sweep", file: "src/server/turnstile-replay.ts:95", sql: "DELETE FROM turnstile_tokens WHERE expires_at <= ?", params: ["2026-01-01T00:00:00.000Z"] },
  { id: "user-count", file: "src/server/admin/overview.ts:128", sql: "SELECT COUNT(*) AS n FROM users", params: [] },
  { id: "files-storage-sum", file: "src/server/admin/overview.ts:199", sql: "SELECT COUNT(*) AS file_count, COALESCE(SUM(byte_size), 0) AS storage_bytes FROM files", params: [] },
  { id: "retention-settings", file: "migrations/001_init.sql:retention_settings", sql: "SELECT comparison_days, file_days FROM retention_settings WHERE id = 1", params: [] },
];
for (const plan of plans) {
  try {
    const rows = db.prepare("EXPLAIN QUERY PLAN " + plan.sql).all(...plan.params);
    const detail = rows.map((r) => String(r.detail)).join(" | ");
    result.queryPlans.push({ id: plan.id, file: plan.file, plan: detail });
    const badScan = /SCAN (users|comparisons|model_runs|operation_stats|jobs|sessions|presence|turnstile_tokens|usage_reservations|files|admin_audit_events)\b/.test(detail) && !/USING (COVERING )?INDEX/.test(detail);
    if (badScan) result.hotQueryFindings.push({ id: plan.id, file: plan.file, plan: detail });
  } catch (error) { result.queryPlans.push({ id: plan.id, file: plan.file, error: String(error).slice(0, 160) }); }
}

const vacuumPath = path.join(COPY_DIR, "chate-vacuum-" + stamp + ".sqlite");
try { db.exec("VACUUM INTO '" + vacuumPath.replaceAll("'", "''") + "'"); result.vacuumIntoBytes = bytes(vacuumPath); }
catch (error) { result.warnings.push("VACUUM INTO failed: " + String(error).slice(0, 120)); }

const retention = q1(db, "SELECT comparison_days, file_days FROM retention_settings WHERE id = 1");
const oldestComparison = q1(db, "SELECT MIN(created_at) AS oldest, COUNT(*) AS n FROM comparisons");
const oldestOperation = q1(db, "SELECT MIN(occurred_at) AS oldest, COUNT(*) AS n FROM operation_stats");
const oldestJob = q1(db, "SELECT MIN(created_at) AS oldest, COUNT(*) AS n FROM jobs");
result.retention = {
  settings: retention ? { comparisonDays: retention.comparison_days, fileDays: retention.file_days } : null,
  comparisons: { rows: num(oldestComparison?.n), oldest: oldestComparison?.oldest ?? null },
  operationStats: { rows: num(oldestOperation?.n), oldest: oldestOperation?.oldest ?? null },
  jobs: { rows: num(oldestJob?.n), oldest: oldestJob?.oldest ?? null },
  note: "No retention runner exists in src/ or scripts/ for comparisons, model_runs, evidence_snapshots, operation_stats, files, sessions, jobs or storage/; only turnstile_tokens and presence are swept. retention_settings is written but never read by any cleanup path.",
};
try { db.close(); } catch {}

const simPath = path.join(COPY_DIR, "chate-growth-" + stamp + ".sqlite");
if (SIMULATE > 0) {
  copyFileSync(DB, simPath);
  simulateGrowth(simPath, SIMULATE);
}

function simulateGrowth(file, comparisons) {
  const before = bytes(file);
  let sim = null;
  try {
    sim = open(file, false);
    sim.exec("PRAGMA foreign_keys = ON");
    sim.exec("PRAGMA journal_mode = WAL");
    sim.exec("PRAGMA synchronous = NORMAL");
    const userId = "sim-user";
    sim.prepare("INSERT OR IGNORE INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)").run(userId, "sim-sub", "sim@example.com", "Sim");
    sim.prepare("INSERT OR IGNORE INTO profiles (user_id) VALUES (?)").run(userId);
    const insertComparison = sim.prepare("INSERT INTO comparisons (id, user_id, question, evidence_mode, idempotency_key, status) VALUES (?, ?, ?, 'native', ?, 'closed')");
    const insertEvidence = sim.prepare("INSERT INTO evidence_snapshots (id, comparison_id, user_id, payload) VALUES (?, ?, ?, ?)");
    const insertRun = sim.prepare("INSERT INTO model_runs (id, comparison_id, user_id, model_id, status, requested_settings, input_label, output_text, finish_reason, completion_ms, prompt_tokens, completion_tokens) VALUES (?, ?, ?, ?, 'completed', ?, '', ?, 'stop', ?, ?, ?)");
    const insertJob = sim.prepare("INSERT INTO jobs (id, queue, payload, status, user_id, idempotency_key, provider) VALUES (?, 'comparison', ?, 'completed', ?, ?, 'none')");
    const insertReservation = sim.prepare("INSERT INTO usage_reservations (id, user_id, idempotency_key, provider, units, status) VALUES (?, ?, ?, 'openrouter', 3, 'used')");
    const insertOp = sim.prepare("INSERT INTO operation_stats (operation_id, user_id, model, provider, operation_type, occurred_at, status, input_tokens, output_tokens, completion_ms) VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?)");
    const upsertBucket = sim.prepare("INSERT INTO operation_buckets (bucket_start, operation_type, model, provider, status, events, input_tokens, output_tokens) VALUES (?, ?, ?, ?, 'succeeded', 1, ?, ?) ON CONFLICT(bucket_start, operation_type, model, provider, status) DO UPDATE SET events = events + 1, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens");
    const upsertHist = sim.prepare("INSERT INTO latency_histogram (metric, bucket_start, le_ms, events) VALUES (?, ?, ?, 1) ON CONFLICT(metric, bucket_start, le_ms) DO UPDATE SET events = events + 1");
    // Assumptions (documented in the report): 3 free OpenRouter models + Claude
    // Haiku per comparison, 120-char question, 1,200-char answer per model,
    // ~220-byte evidence snapshot, 6 operation_stats rows per comparison.
    const question = "س".repeat(120);
    const answer = "ج".repeat(1200);
    const snapshot = JSON.stringify({ question, evidenceMode: "native", evidenceText: "", attachmentIds: [] });
    const started = Date.now();
    sim.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < comparisons; i += 1) {
      const cid = "sim-c-" + i;
      const key = "sim-k-" + i;
      const now = new Date(started + i * 1000).toISOString();
      const bucket = now.slice(0, 13) + ":00:00.000Z";
      insertComparison.run(cid, userId, question, key);
      insertEvidence.run("sim-e-" + i, cid, userId, snapshot);
      insertJob.run("sim-j-" + i, JSON.stringify({ comparisonId: cid, holds: ["openrouter", "anthropic"] }), userId, key);
      insertReservation.run("sim-r-" + i, userId, key);
      for (let m = 0; m < 4; m += 1) {
        const provider = m === 3 ? "anthropic" : "openrouter";
        insertRun.run("sim-run-" + i + "-" + m, cid, userId, m === 3 ? "claude-haiku-5-5" : "google/gemma-4-31b-it:free", JSON.stringify({ labels: [], notes: [], provider, displayName: "M" + m, effort: m === 3 ? "medium" : null, message: null, request: { messages: [{ role: "user", content: "x".repeat(180) }] } }), answer, 1800 + m * 500, 420, 260);
        insertOp.run("gen:" + i + ":" + m, userId, "model" + m, provider, "generation", now, 420, 260, 1800 + m * 500);
        upsertBucket.run(bucket, "generation", "model" + m, provider, 420, 260);
        upsertHist.run("ttft", bucket, 250);
        upsertHist.run("completion", bucket, 2000);
      }
      insertOp.run("q:" + i, userId, null, null, "question", now, null, null, null);
      insertOp.run("c:" + i, userId, null, null, "comparison", now, null, null, null);
    }
    sim.exec("COMMIT");
    sim.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const afterWal = bytes(file + "-wal");
    const after = bytes(file);
    result.growth = {
      simulatedComparisons: comparisons,
      assumptions: { modelsPerComparison: 4, questionChars: 120, answerCharsPerModel: 1200, operationStatsPerComparison: 6, snapshotBytes: snapshot.length },
      fileBytesBefore: before,
      fileBytesAfter: after,
      walBytesAfter: afterWal,
      bytesAdded: after - before,
      bytesPerComparison: Math.round((after - before) / comparisons),
      bytesPer1000Comparisons: Math.round(((after - before) / comparisons) * 1000),
      estimatedWALPerComparison: Math.round(afterWal / comparisons),
      pageSize: num(q1(sim, "PRAGMA page_size")?.page_size),
      pageCount: num(q1(sim, "PRAGMA page_count")?.page_count),
      freelist: num(q1(sim, "PRAGMA freelist_count")?.freelist_count),
    };
    result.growth.perTableBytes = sim.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 20").all().map((r) => ({ name: r.name, bytes: num(r.bytes) }));
    sim.close();
  } catch (error) {
    result.warnings.push("growth simulation failed: " + String(error).slice(0, 200));
    try { sim?.close(); } catch {}
  }
}

if (!flag("keep")) {
  for (const file of [copyPath, copyPath + "-wal", copyPath + "-shm", vacuumPath, simPath, simPath + "-wal", simPath + "-shm"]) {
    try { rmSync(file, { force: true }); } catch {}
  }
}

const kb = (n) => n == null ? "n/a" : (n / 1024).toFixed(1) + " KB";
if (flag("json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("ChatE database inspector (copy of " + DB + ")");
  console.log("Source: db " + kb(result.sourceBytes) + ", wal " + kb(result.walBytes) + ", shm " + kb(result.shmBytes));
  console.log("Copy: " + result.page.pageCount + " pages x " + result.page.pageSize + " B = " + kb(result.page.dbBytes) + ", freelist " + result.page.freelist + " pages (" + kb(result.page.freeBytes) + ")");
  console.log("Pragmas: " + JSON.stringify(result.pragmas));
  console.log("Integrity: " + JSON.stringify(result.integrity));
  console.log("Vacuumed backup size: " + kb(result.vacuumIntoBytes));
  console.log("");
  console.log("TABLES (rows / bytes):");
  for (const table of result.tables) console.log("  " + table.name.padEnd(26) + String(table.rows).padStart(7) + " rows   " + kb(table.bytes));
  console.log("");
  console.log("INDEXES (" + result.indexes.length + "):");
  for (const index of result.indexes) console.log("  " + String(index.name).padEnd(34) + (index.table || "").padEnd(24) + kb(index.bytes));
  console.log("");
  console.log("QUERY PLANS:");
  for (const plan of result.queryPlans) console.log("  " + plan.id.padEnd(24) + (plan.error ? "ERROR " + plan.error : plan.plan));
  if (result.hotQueryFindings.length) {
    console.log("");
    console.log("POSSIBLE FULL-TABLE SCANS WITHOUT INDEX:");
    for (const finding of result.hotQueryFindings) console.log("  " + finding.id + " (" + finding.file + "): " + finding.plan);
  }
  if (result.growth) {
    console.log("");
    console.log("GROWTH SIMULATION (" + result.growth.simulatedComparisons + " synthetic comparisons):");
    console.log("  assumptions: " + JSON.stringify(result.growth.assumptions));
    console.log("  +" + kb(result.growth.bytesAdded) + " -> " + kb(result.growth.bytesPerComparison) + " per comparison, " + kb(result.growth.bytesPer1000Comparisons) + " per 1,000 comparisons");
    console.log("  top tables by bytes: " + result.growth.perTableBytes.slice(0, 8).map((t) => t.name + "=" + kb(t.bytes)).join(", "));
  }
  if (result.retention) {
    console.log("");
    console.log("RETENTION: settings=" + JSON.stringify(result.retention.settings));
    console.log("  comparisons rows=" + result.retention.comparisons.rows + " oldest=" + result.retention.comparisons.oldest);
    console.log("  operation_stats rows=" + result.retention.operationStats.rows + " oldest=" + result.retention.operationStats.oldest);
    console.log("  jobs rows=" + result.retention.jobs.rows + " oldest=" + result.retention.jobs.oldest);
    console.log("  " + result.retention.note);
  }
  if (result.warnings.length) { console.log(""); console.log("WARNINGS:"); for (const warning of result.warnings) console.log("  " + warning); }
}
if (opt("out", null)) writeFileSync(path.resolve(opt("out")), JSON.stringify(result, null, 2));
