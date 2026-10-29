import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RESERVE_LOCK_SQL } from "@/domain/quota/reserve";
import {
  BEGIN_IMMEDIATE_SQL,
  CLAIM_JOB_SQL,
  SHARED_QUOTA_ID,
  StoreError,
  claimQueuedJob,
  claimWithoutProvider,
  finishJob,
  insertFile,
  insertSession,
  insertUser,
  migrateDatabase,
  openDatabase,
  readQuotaLimits,
  requeueStaleClaims,
  reserveAndEnqueue,
  resolveSqlitePath,
  userQuotaId,
  type QuotaLimits,
  type ReserveAndEnqueueInput,
} from "@/server/db/index";

const migrationsDir = path.join(process.cwd(), "migrations");

function migrationFiles(): string[] {
  return readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
}
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  googleSub: "sub-1",
  email: "layan@example.com",
  name: "ليان",
};
const roomy: QuotaLimits = { sharedLimit: 10, userLimit: 4, maxUserConcurrent: 4, maxGlobalConcurrent: 8 };

const tables = [
  "users", "profiles", "sessions", "otp_challenges", "turnstile_tokens", "files", "extraction_jobs",
  "documents", "chunks", "embedding_indexes", "embedding_vectors", "comparisons", "evidence_snapshots",
  "model_runs", "usage_reservations", "usage_events", "quota_accounts", "user_feedback",
  "admin_audit_events", "retention_settings", "jobs", "schema_migrations",
];

function request(overrides: Partial<ReserveAndEnqueueInput> = {}): ReserveAndEnqueueInput {
  return {
    userId: user.id,
    queue: "model-run",
    provider: "openrouter",
    units: 1,
    idempotencyKey: "cmp-1",
    payload: { question: "سؤال" },
    limits: roomy,
    ...overrides,
  };
}

function tempPaths(): { dir: string; filePath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "chate-sqlite-"));
  return { dir, filePath: path.join(dir, "chate.sqlite") };
}

function closeDb(db: DatabaseSync): void {
  if (db.isOpen && db.isTransaction) db.exec("ROLLBACK");
  if (db.isOpen) db.close();
}

function withDb(run: (db: DatabaseSync) => void): void {
  const { dir, filePath } = tempPaths();
  const db = openDatabase(filePath);
  try {
    expect(migrateDatabase(db, migrationsDir)).toEqual(migrationFiles());
    run(db);
  } finally {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  }
}

function account(db: DatabaseSync, id: string): { reserved_units: number; used_units: number; in_flight: number } | undefined {
  const row = db.prepare("SELECT reserved_units, used_units, in_flight FROM quota_accounts WHERE id = ?").get(id);
  return row as { reserved_units: number; used_units: number; in_flight: number } | undefined;
}

describe("sqlite file store", () => {
  it("resolves the default file and rejects a postgres URL", () => {
    expect(resolveSqlitePath(undefined, "C:\\app")).toBe(path.resolve("C:\\app", "data/chate.sqlite"));
    expect(resolveSqlitePath("  ", "C:\\app")).toBe(path.resolve("C:\\app", "data/chate.sqlite"));
    expect(() => resolveSqlitePath("postgresql://chate:chate@localhost:5432/chate", "C:\\app")).toThrow(StoreError);
  });

  it("creates the expected tables in a temporary file and keeps a session after reopen", () => {
    const { dir, filePath } = tempPaths();
    const db = openDatabase(filePath);
    try {
      expect(migrateDatabase(db, migrationsDir)).toEqual(migrationFiles());
      expect(migrateDatabase(db, migrationsDir)).toEqual([]);
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
      for (const table of tables) expect(names).toContain(table);
      insertUser(db, user);
      insertSession(db, { id: "sess-1", userId: user.id, tokenHash: "hash", expiresAt: "2026-10-28T00:00:00.000Z" });
      storeGraph(db);
      expect(() => db.prepare(`
        INSERT INTO chunks (id, document_id, user_id, ordinal, text, source)
        VALUES ('chunk-bad', 'doc-1', ?, 1, 'x', 'not-json')
      `).run(user.id)).toThrow();
      db.close();
      const again = openDatabase(filePath);
      try {
        expect(again.prepare("SELECT token_hash FROM sessions WHERE id = ?").get("sess-1")).toMatchObject({ token_hash: "hash" });
        expect(again.prepare("SELECT id FROM retention_settings").get()).toMatchObject({ id: 1 });
      } finally {
        again.close();
      }
    } finally {
      closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reserves quota and enqueues a job in one transaction", () => {
    withDb((db) => {
      insertUser(db, user);
      const first = reserveAndEnqueue(db, request({ units: 1, idempotencyKey: "cmp-1" }));
      const secondProvider = reserveAndEnqueue(db, request({ provider: "anthropic", idempotencyKey: "cmp-1" }));
      const duplicate = reserveAndEnqueue(db, request({ units: 1, idempotencyKey: "cmp-1" }));
      expect(first.ok && secondProvider.ok && duplicate.ok).toBe(true);
      if (!first.ok || !secondProvider.ok || !duplicate.ok) return;
      expect(duplicate).toMatchObject({ duplicate: true, jobId: first.jobId });
      expect(secondProvider.jobId).not.toBe(first.jobId);
      expect(account(db, SHARED_QUOTA_ID)).toMatchObject({ reserved_units: 2, used_units: 0, in_flight: 2 });
      expect(account(db, userQuotaId(user.id))).toMatchObject({ reserved_units: 2, in_flight: 2 });
      const busy = reserveAndEnqueue(db, request({
        idempotencyKey: "cmp-3",
        limits: { ...roomy, maxUserConcurrent: 2 },
      }));
      expect(busy).toEqual({ ok: false, code: "concurrency" });
      expect(() => reserveAndEnqueue(db, request({ userId: "missing-user", idempotencyKey: "cmp-4" }))).toThrow(StoreError);
      expect(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toMatchObject({ n: 2 });
    });
    withDb((db) => {
      insertUser(db, user);
      const tight = { ...roomy, userLimit: 1, maxUserConcurrent: 5 };
      expect(reserveAndEnqueue(db, request({ idempotencyKey: "cap-a", limits: tight })).ok).toBe(true);
      expect(reserveAndEnqueue(db, request({ idempotencyKey: "cap-b", limits: tight }))).toEqual({ ok: false, code: "quota" });
      expect(account(db, SHARED_QUOTA_ID)?.reserved_units).toBe(1);
    });
  });

  it("claims a queued job once, then settles or releases the reservation", () => {
    withDb((db) => {
      insertUser(db, user);
      const early = reserveAndEnqueue(db, request({ idempotencyKey: "early" }));
      const later = reserveAndEnqueue(db, request({ idempotencyKey: "later" }));
      if (!early.ok || !later.ok) throw new Error("reserve");
      db.prepare("UPDATE jobs SET created_at = '2026-10-27T00:00:02.000Z' WHERE id = ?").run(later.jobId);
      db.prepare("UPDATE jobs SET created_at = '2026-10-27T00:00:01.000Z', not_before = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(early.jobId);
      const claimed = claimQueuedJob(db, "worker-a", "model-run");
      expect(claimed?.id).toBe(later.jobId);
      expect(claimed?.payload).toContain("سؤال");
      expect(claimQueuedJob(db, "worker-b", "model-run")).toBeNull();
      expect(finishJob(db, { jobId: later.jobId, claimToken: "worker-a", outcome: "completed" })).toBe(true);
      expect(account(db, SHARED_QUOTA_ID)).toMatchObject({ reserved_units: 1, used_units: 1, in_flight: 1 });
      db.prepare("UPDATE jobs SET not_before = NULL WHERE id = ?").run(early.jobId);
      const failed = claimQueuedJob(db, "worker-a", null);
      expect(failed?.id).toBe(early.jobId);
      expect(finishJob(db, { jobId: early.jobId, claimToken: "worker-a", outcome: "failed", errorCode: "provider_not_called" })).toBe(true);
      expect(account(db, SHARED_QUOTA_ID)).toMatchObject({ reserved_units: 0, used_units: 1, in_flight: 0 });
      expect(db.prepare("SELECT status FROM usage_reservations WHERE idempotency_key = 'early'").get()).toMatchObject({ status: "released" });
    });
  });

  it("returns a claimed job to the queue without a provider call and requeues a stale claim", () => {
    withDb((db) => {
      insertUser(db, user);
      const queued = reserveAndEnqueue(db, request());
      if (!queued.ok) throw new Error("reserve");
      expect(claimWithoutProvider(db, "worker-a", 60_000)?.id).toBe(queued.jobId);
      expect(claimQueuedJob(db, "worker-b", null)).toBeNull();
      expect(account(db, SHARED_QUOTA_ID)?.reserved_units).toBe(1);
      db.prepare("UPDATE jobs SET not_before = NULL WHERE id = ?").run(queued.jobId);
      const active = claimQueuedJob(db, "worker-a", null);
      expect(active?.id).toBe(queued.jobId);
      expect(requeueStaleClaims(db, "2000-01-01T00:00:00.000Z")).toBe(0);
      db.prepare("UPDATE jobs SET claimed_at = '1999-01-01T00:00:00.000Z' WHERE id = ?").run(queued.jobId);
      expect(requeueStaleClaims(db, "2000-01-01T00:00:00.000Z")).toBe(1);
      expect(db.prepare("SELECT status FROM jobs WHERE id = ?").get(queued.jobId)).toMatchObject({ status: "queued" });
    });
  });

  it("blocks a second writer while a transaction holds the file", () => {
    const { dir, filePath } = tempPaths();
    const db1 = openDatabase(filePath, { timeoutMs: 200 });
    const db2 = openDatabase(filePath, { timeoutMs: 200 });
    try {
      migrateDatabase(db1, migrationsDir);
      insertUser(db1, user);
      const reserved = reserveAndEnqueue(db1, request());
      if (!reserved.ok) throw new Error("reserve");
      db1.exec(BEGIN_IMMEDIATE_SQL);
      let message = "";
      try {
        claimQueuedJob(db2, "other-worker", null);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message.toLowerCase()).toMatch(/locked|busy/);
      expect(db2.isTransaction).toBe(false);
      db1.exec("ROLLBACK");
      expect(claimQueuedJob(db2, "other-worker", null)?.id).toBe(reserved.jobId);
    } finally {
      closeDb(db1);
      closeDb(db2);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("postgres leftovers", () => {
  it("keeps setup on a sqlite file", () => {
    const example = readFileSync(".env.example", "utf8");
    const readme = readFileSync("README.md", "utf8");
    const architecture = readFileSync("docs/architecture.md", "utf8");
    const launch = readFileSync("docs/launch-and-secret-rotation.md", "utf8");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const migration = readFileSync("migrations/001_init.sql", "utf8").toLowerCase();
    expect(example).toContain("SQLITE_PATH=data/chate.sqlite");
    expect(example).not.toContain("DATABASE_URL");
    expect(example.toLowerCase()).not.toContain("postgres");
    expect(readme).not.toContain("docker compose");
    expect(readme).not.toContain("postgresql://");
    expect(architecture).toContain("data/chate.sqlite");
    expect(architecture).toContain("كاتب واحد");
    expect(architecture).toContain("لا Docker ولا pg-boss ولا Redis");
    expect(architecture).not.toContain("pg-boss يضع");
    expect(architecture).not.toContain("Docker Compose");
    expect(launch).not.toContain("DATABASE_URL");
    expect(pkg.dependencies.pg).toBeUndefined();
    expect(pkg.dependencies["pg-boss"]).toBeUndefined();
    expect(pkg.devDependencies["@types/pg"]).toBeUndefined();
    expect(readFileSync("next.config.ts", "utf8")).not.toContain("pg-boss");
    expect(readFileSync("scripts/migrate.ts", "utf8")).not.toContain("DATABASE_URL");
    expect(readFileSync("scripts/worker.ts", "utf8")).not.toContain("pg-boss");
    expect(migration).not.toContain("timestamptz");
    expect(migration).not.toContain("gen_random_uuid");
    expect(migration).not.toContain("jsonb");
    expect(RESERVE_LOCK_SQL).not.toContain("FOR UPDATE");
    expect(RESERVE_LOCK_SQL).not.toContain("$1");
    expect(CLAIM_JOB_SQL).toContain("status = 'queued'");
    expect(BEGIN_IMMEDIATE_SQL).toBe("BEGIN IMMEDIATE");
    expect(existsSync("docker-compose.yml")).toBe(false);
    const lock = readFileSync("package-lock.json", "utf8");
    expect(lock).not.toContain("node_modules/pg-boss");
    expect(lock).not.toContain("\"node_modules/pg\"");
    expect(lock).not.toContain("node_modules/@types/pg");
  });
});

function storeGraph(db: DatabaseSync): void {
  insertFile(db, {
    id: "file-1",
    userId: user.id,
    storageKey: "storage/file-1",
    originalName: "a.pdf",
    detectedType: "pdf",
    byteSize: 10,
    sha256: "ab",
    status: "stored",
  });
  db.prepare("INSERT INTO profiles (user_id, phone_e164, city) VALUES (?, ?, ?)").run(user.id, "+966512345678", "الرياض");
  db.prepare("INSERT INTO extraction_jobs (id, file_id, user_id, status) VALUES ('ext-1', 'file-1', ?, 'queued')").run(user.id);
  db.prepare("INSERT INTO documents (id, file_id, user_id, processing_version) VALUES ('doc-1', 'file-1', ?, 'v1')").run(user.id);
  db.prepare("INSERT INTO chunks (id, document_id, user_id, ordinal, text, source) VALUES ('chunk-1', 'doc-1', ?, 0, 'نص', '{\"page\":1}')").run(user.id);
  db.prepare(`
    INSERT INTO embedding_indexes (id, user_id, model_id, dimensions, processing_version, status)
    VALUES ('idx-1', ?, 'nvidia/nemotron-3.5-embed-1b:free', 2048, 'v1', 'empty')
  `).run(user.id);
  db.prepare(`
    INSERT INTO embedding_vectors (id, index_id, chunk_id, user_id, dimensions, "values")
    VALUES ('vec-1', 'idx-1', 'chunk-1', ?, 2048, '[0.1,0.2]')
  `).run(user.id);
  db.prepare(`
    INSERT INTO comparisons (id, user_id, question, evidence_mode, idempotency_key, status)
    VALUES ('cmp-row', ?, 'سؤال', 'native', 'cmp-key', 'queued')
  `).run(user.id);
  db.prepare("INSERT INTO evidence_snapshots (id, comparison_id, user_id, payload) VALUES ('ev-1', 'cmp-row', ?, '{\"text\":\"دليل\"}')").run(user.id);
  db.prepare("INSERT INTO model_runs (id, comparison_id, user_id, model_id, status) VALUES ('run-1', 'cmp-row', ?, 'google/gemma-4-31b-it:free', 'queued')").run(user.id);
  db.prepare("INSERT INTO usage_events (id, user_id, model_id, provider, kind, units) VALUES ('use-1', ?, 'google/gemma-4-31b-it:free', 'openrouter', 'answer', 1)").run(user.id);
  db.prepare("INSERT INTO user_feedback (id, run_id, user_id, rating) VALUES ('fb-1', 'run-1', ?, 5)").run(user.id);
  db.prepare("INSERT INTO admin_audit_events (id, admin_user_id, action, target) VALUES ('aud-1', ?, 'view', 'overview')").run(user.id);
  db.prepare("INSERT INTO otp_challenges (id, user_id, phone_e164, code_hash, expires_at) VALUES ('otp-1', ?, '+966512345678', 'hash', '2026-10-28T00:00:00.000Z')").run(user.id);
  db.prepare("INSERT INTO turnstile_tokens (token_hash, action, hostname, expires_at) VALUES ('tok', 'comparison', 'localhost', '2026-10-28T00:00:00.000Z')").run();
}

describe("quota config", () => {
  it("reads numeric limits and rejects a zero cap", () => {
    expect(readQuotaLimits({})).toEqual({ sharedLimit: 2000, userLimit: 200, maxUserConcurrent: 2, maxGlobalConcurrent: 8 });
    expect(readQuotaLimits({ SHARED_QUOTA_UNITS: "10", USER_QUOTA_UNITS: "  " }).sharedLimit).toBe(10);
    expect(readQuotaLimits({ USER_QUOTA_UNITS: "  " }).userLimit).toBe(200);
    expect(() => readQuotaLimits({ USER_QUOTA_UNITS: "0" })).toThrow(StoreError);
  });
});
