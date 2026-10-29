import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "@/domain/auth/session";
import { insertUser, migrateDatabase, openDatabase } from "@/server/db/index";
import {
  STALE_RUN_MESSAGE,
  reconcileStaleComparison,
  staleRunDeadlineMs,
} from "@/server/comparisons/store";

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }));

vi.mock("@/server/db/runtime", () => ({
  getDatabase: () => {
    if (!state.db) throw new Error("test database is not ready");
    return state.db;
  },
}));

vi.mock("@/server/comparisons/execute", () => ({ scheduleComparison: vi.fn() }));

const SECRET = "comparison-reliability-session-secret";
const MIGRATIONS = path.join(process.cwd(), "migrations");
const USER_ID = "44444444-4444-4444-8444-444444444444";
const GOOGLE_SUB = "google-sub-comparison-reliability";
const MODEL_ID = "google/gemma-4-31b-it:free";
const SHARED = "shared";
const USER_QUOTA = `user:${USER_ID}`;

type JsonBody = {
  ok?: boolean;
  data?: { id?: string; status?: string; runs?: { modelId?: string; status?: string; message?: string | null }[] | null } | null;
  error?: { message?: string; code?: string } | null;
};

let comparisonSeq = 0;

function database(): DatabaseSync {
  if (!state.db) throw new Error("test database is not ready");
  return state.db;
}

function sessionCookie(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signSession(
    { userId: USER_ID, googleSub: GOOGLE_SUB, exp: nowSec + 600, csrf: "csrf-reliability", iat: nowSec },
    SECRET,
  );
  return "chate_session=" + token;
}

function comparisonRequest(comparisonId: string): Request {
  return new Request("http://localhost:3211/api/comparisons/" + comparisonId, {
    method: "GET",
    headers: { "x-forwarded-host": "localhost", cookie: sessionCookie() },
  });
}

async function getComparison(comparisonId: string): Promise<{ status: number; body: JsonBody }> {
  const { GET } = await import("@/app/api/comparisons/[id]/route");
  const response = await GET(comparisonRequest(comparisonId), { params: Promise.resolve({ id: comparisonId }) });
  const body = (await response.json()) as JsonBody;
  return { status: response.status, body };
}

type SeedOptions = {
  comparisonStatus: "queued" | "running";
  ageMs: number;
  runStatuses: ("queued" | "running" | "completed")[];
  completedHoldSettled?: boolean;
};

function seedComparison(options: SeedOptions): { comparisonId: string; idempotencyKey: string; runIds: string[]; jobId: string } {
  const comparisonId = randomUUID();
  const idempotencyKey = randomUUID();
  const jobId = randomUUID();
  const createdAt = new Date(Date.now() - options.ageMs).toISOString();
  comparisonSeq += 1;
  database()
    .prepare(`
      INSERT INTO comparisons (id, user_id, question, evidence_mode, idempotency_key, status, created_at)
      VALUES (?, ?, ?, 'native', ?, ?, ?)
    `)
    .run(comparisonId, USER_ID, "سؤال اختبار الموثوقية " + comparisonSeq, idempotencyKey, options.comparisonStatus, createdAt);
  database()
    .prepare(`
      INSERT INTO jobs (id, queue, payload, status, user_id, idempotency_key, reservation_id, provider, claim_token, claimed_at, created_at)
      VALUES (?, 'comparison', ?, 'active', ?, ?, NULL, 'none', 'dead-executor-claim', ?, ?)
    `)
    .run(jobId, JSON.stringify({ comparisonId, holds: ["openrouter"] }), USER_ID, idempotencyKey, createdAt, createdAt);
  const insertRun = database().prepare(`
    INSERT INTO model_runs (id, comparison_id, user_id, model_id, status, requested_settings, input_label, output_text, completion_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'نص السؤال والأدلة', '', ?, ?)
  `);
  const runIds: string[] = [];
  for (const status of options.runStatuses) {
    const runId = randomUUID();
    runIds.push(runId);
    const settings: Record<string, unknown> = {
      labels: [],
      notes: [],
      provider: "openrouter",
      displayName: "Gemma 4 31B",
      effort: null,
      message: null,
      request: null,
    };
    if (status === "completed" && options.completedHoldSettled) settings.holdSettled = true;
    insertRun.run(
      runId,
      comparisonId,
      USER_ID,
      MODEL_ID,
      status,
      JSON.stringify(settings),
      status === "completed" ? 1234 : null,
      createdAt,
    );
  }
  return { comparisonId, idempotencyKey, runIds, jobId };
}

function seedHolds(idempotencyKey: string, options: { reserved: number; inFlight: number }): void {
  database()
    .prepare(`
      INSERT INTO quota_accounts (id, scope, user_id, limit_units, used_units, reserved_units, in_flight)
      VALUES (?, 'shared', NULL, 2000, 0, ?, ?)
    `)
    .run(SHARED, options.reserved, options.inFlight);
  database()
    .prepare(`
      INSERT INTO quota_accounts (id, scope, user_id, limit_units, used_units, reserved_units, in_flight)
      VALUES (?, 'user', ?, 200, 0, ?, ?)
    `)
    .run(USER_QUOTA, USER_ID, options.reserved, options.inFlight);
  database()
    .prepare(`
      INSERT INTO usage_reservations (id, user_id, idempotency_key, provider, units, status)
      VALUES (?, ?, ?, 'openrouter', ?, 'reserved')
    `)
    .run(randomUUID(), USER_ID, idempotencyKey, options.reserved);
}

function accountState(id: string): { used: number; reserved: number; inFlight: number } {
  const row = database()
    .prepare("SELECT used_units, reserved_units, in_flight FROM quota_accounts WHERE id = ?")
    .get(id) as { used_units: number; reserved_units: number; in_flight: number } | undefined;
  return { used: row?.used_units ?? -1, reserved: row?.reserved_units ?? -1, inFlight: row?.in_flight ?? -1 };
}

function comparisonStatus(comparisonId: string): string {
  const row = database().prepare("SELECT status FROM comparisons WHERE id = ?").get(comparisonId) as { status: string } | undefined;
  return row?.status ?? "missing";
}

function jobState(jobId: string): { status: string; finishedAt: string | null } {
  const row = database().prepare("SELECT status, finished_at FROM jobs WHERE id = ?").get(jobId) as
    | { status: string; finished_at: string | null }
    | undefined;
  return { status: row?.status ?? "missing", finishedAt: row?.finished_at ?? null };
}

beforeEach(() => {
  state.db = openDatabase(":memory:");
  migrateDatabase(database(), MIGRATIONS);
  insertUser(database(), { id: USER_ID, googleSub: GOOGLE_SUB, email: "reliability@example.com", name: "مستخدم الاختبار" });
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("MODEL_TIMEOUT_MS", "");
  vi.stubEnv("APP_URL", "http://localhost:3211");
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (state.db && state.db.isOpen) state.db.close();
  state.db = null;
});

describe("comparison execution deadline reconciliation", () => {
  it("derives a bounded deadline from MODEL_TIMEOUT_MS", () => {
    expect(staleRunDeadlineMs({})).toBe(180_000 + 30_000);
    expect(staleRunDeadlineMs({ MODEL_TIMEOUT_MS: "60000" })).toBe(60_000 + 30_000);
    expect(staleRunDeadlineMs({ MODEL_TIMEOUT_MS: "1000" })).toBe(30_000 + 30_000);
    expect(staleRunDeadlineMs({ MODEL_TIMEOUT_MS: "999999999" })).toBe(1_800_000 + 30_000);
    expect(staleRunDeadlineMs({ MODEL_TIMEOUT_MS: "not-a-number" })).toBe(180_000 + 30_000);
  });

  it("reconciles a stale running comparison on GET and releases the reserved quota", async () => {
    const seeded = seedComparison({ comparisonStatus: "running", ageMs: 10 * 60_000, runStatuses: ["running", "running"] });
    seedHolds(seeded.idempotencyKey, { reserved: 2, inFlight: 1 });

    const first = await getComparison(seeded.comparisonId);
    expect(first.status).toBe(200);
    expect(first.body.data?.status).toBe("failed");
    const runs = first.body.data?.runs ?? [];
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.status).toBe("failed");
      expect(run.message).toBe(STALE_RUN_MESSAGE);
    }
    expect(comparisonStatus(seeded.comparisonId)).toBe("failed");
    expect(accountState(SHARED)).toEqual({ used: 0, reserved: 0, inFlight: 0 });
    expect(accountState(USER_QUOTA)).toEqual({ used: 0, reserved: 0, inFlight: 0 });
    const reservation = database()
      .prepare("SELECT status FROM usage_reservations WHERE idempotency_key = ?")
      .get(seeded.idempotencyKey) as { status: string } | undefined;
    expect(reservation?.status).toBe("released");
    expect(jobState(seeded.jobId)).toMatchObject({ status: "failed" });
    expect(jobState(seeded.jobId).finishedAt).not.toBeNull();
  });

  it("is idempotent: a second GET and a direct reconcile do not double-settle", async () => {
    const seeded = seedComparison({ comparisonStatus: "running", ageMs: 10 * 60_000, runStatuses: ["running"] });
    seedHolds(seeded.idempotencyKey, { reserved: 1, inFlight: 1 });
    await getComparison(seeded.comparisonId);
    await getComparison(seeded.comparisonId);
    const again = reconcileStaleComparison(database(), USER_ID, seeded.comparisonId);
    expect(again.reconciled).toBe(false);
    expect(accountState(SHARED)).toEqual({ used: 0, reserved: 0, inFlight: 0 });
    expect(accountState(USER_QUOTA)).toEqual({ used: 0, reserved: 0, inFlight: 0 });
  });

  it("keeps partial answers and marks the comparison incomplete", async () => {
    const seeded = seedComparison({
      comparisonStatus: "running",
      ageMs: 10 * 60_000,
      runStatuses: ["completed", "running"],
      completedHoldSettled: true,
    });
    // The completed run already settled its unit; one hold is still reserved.
    seedHolds(seeded.idempotencyKey, { reserved: 1, inFlight: 1 });

    const result = await getComparison(seeded.comparisonId);
    expect(result.body.data?.status).toBe("incomplete");
    const runs = result.body.data?.runs ?? [];
    expect(runs.map((run) => run.status).sort()).toEqual(["completed", "failed"]);
    expect(runs.find((run) => run.status === "failed")?.message).toBe(STALE_RUN_MESSAGE);
    expect(accountState(SHARED)).toEqual({ used: 0, reserved: 0, inFlight: 0 });
    const reservation = database()
      .prepare("SELECT status FROM usage_reservations WHERE idempotency_key = ?")
      .get(seeded.idempotencyKey) as { status: string } | undefined;
    expect(reservation?.status).toBe("used");
  });

  it("leaves a fresh running comparison untouched and lets the scheduler continue", async () => {
    const seeded = seedComparison({ comparisonStatus: "running", ageMs: 5_000, runStatuses: ["running"] });
    seedHolds(seeded.idempotencyKey, { reserved: 1, inFlight: 1 });
    const executeModule = await import("@/server/comparisons/execute");
    const schedule = executeModule.scheduleComparison as unknown as ReturnType<typeof vi.fn>;
    schedule.mockClear();

    const result = await getComparison(seeded.comparisonId);
    expect(result.body.data?.status).toBe("running");
    expect(comparisonStatus(seeded.comparisonId)).toBe("running");
    expect(accountState(SHARED)).toEqual({ used: 0, reserved: 1, inFlight: 1 });
    expect(accountState(USER_QUOTA)).toEqual({ used: 0, reserved: 1, inFlight: 1 });
    expect(jobState(seeded.jobId).status).toBe("active");
    expect(schedule).toHaveBeenCalledWith(seeded.comparisonId);
  });
});
