import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { dispatchModel } from "@/domain/models/dispatch";
import {
  beatPresence,
  clearPresence,
  countPresence,
  recordAcceptedComparison,
  recordModelInvocation,
  recordOperation,
  type OperationDraft,
} from "@/server/admin/operations";
import { insertUser } from "@/server/db/accounts";
import { migrateDatabase, openDatabase } from "@/server/db/index";

const migrationsDir = path.join(process.cwd(), "migrations");
const owner = { id: "user-1", googleSub: "user-1", email: "owner@example.com", name: "المالك" };

function withDb(run: (db: DatabaseSync) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "chate-stats-"));
  const db = openDatabase(path.join(dir, "chate.sqlite"));
  try {
    migrateDatabase(db, migrationsDir);
    insertUser(db, owner);
    run(db);
  } finally {
    if (db.isOpen && db.isTransaction) db.exec("ROLLBACK");
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function draft(patch: Partial<OperationDraft> = {}): OperationDraft {
  return {
    operationId: "generation:run-1",
    userId: owner.id,
    model: "example/model:free",
    provider: "openrouter",
    operationType: "generation",
    occurredAt: "2026-10-27T11:05:00.000Z",
    status: "succeeded",
    inputTokens: 10,
    outputTokens: 5,
    completionMs: 120,
    costUsd: 0.01,
    ...patch,
  };
}

describe("operation statistics", () => {
  it("creates the bucket and histogram tables the writer depends on", () => {
    withDb((db) => {
      const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('operation_buckets', 'latency_histogram')")
        .all() as { name: string }[];
      expect(names.map((row) => row.name).sort()).toEqual(["latency_histogram", "operation_buckets"]);
    });
  });

  it("records one operation once and aggregates hourly buckets and latency", () => {
    withDb((db) => {
      expect(recordOperation(db, draft())).toBe(true);
      // A duplicate operation id must not double-count the bucket.
      expect(recordOperation(db, draft())).toBe(false);

      const stat = db.prepare("SELECT * FROM operation_stats WHERE operation_id = ?").get("generation:run-1") as Record<string, unknown>;
      expect(stat).toMatchObject({ user_id: owner.id, operation_type: "generation", status: "succeeded", input_tokens: 10, output_tokens: 5 });

      const buckets = db.prepare("SELECT * FROM operation_buckets").all() as Record<string, unknown>[];
      expect(buckets).toHaveLength(1);
      expect(buckets[0]).toMatchObject({
        bucket_start: "2026-10-27T11:00:00.000Z",
        operation_type: "generation",
        events: 1,
        input_tokens: 10,
        output_tokens: 5,
        cost_usd: 0.01,
        cost_events: 1,
      });

      const latency = db.prepare("SELECT metric, le_ms, events FROM latency_histogram").all();
      expect(latency).toEqual([{ metric: "completion", le_ms: 200, events: 1 }]);
    });
  });

  it("redacts provider error codes so the database trigger accepts every row", () => {
    withDb((db) => {
      expect(recordOperation(db, draft({ operationId: "generation:run-2", status: "failed", errorCode: "Rate limited by provider 429" }))).toBe(true);
      expect(recordOperation(db, draft({ operationId: "generation:run-3", status: "failed", errorCode: "sk-or-v1-super-secret" }))).toBe(true);
      const rows = db.prepare("SELECT operation_id, error_code FROM operation_stats ORDER BY operation_id").all() as {
        operation_id: string;
        error_code: string;
      }[];
      expect(rows).toEqual([
        { operation_id: "generation:run-2", error_code: "RATE_LIMITED_BY_PROVIDER_429" },
        { operation_id: "generation:run-3", error_code: "REDACTED" },
      ]);
      for (const row of rows) {
        expect(row.error_code).not.toContain(" ");
        expect(row.error_code.length).toBeLessThanOrEqual(64);
      }
    });
  });

  it("records retry attempts and classifies a rate-limited provider reply", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }) as typeof fetch;
    const result = await dispatchModel({
      provider: "openrouter",
      modelId: "google/gemma-4-31b-it:free",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      request: { model: "google/gemma-4-31b-it:free", messages: [] },
    }, { fetchImpl, openRouterKey: "test-key", appUrl: "http://localhost:3211" });
    expect(result.attempted).toBe(true);
    expect(result.errorCode).toBe("RATE_LIMIT");
    expect(result.attempts).toBe(3);
    expect(calls).toHaveLength(3);

    withDb((db) => {
      recordModelInvocation(db, {
        runId: "run-429",
        userId: owner.id,
        model: "google/gemma-4-31b-it:free",
        provider: "openrouter",
        occurredAt: "2026-10-27T11:20:00.000Z",
        succeeded: false,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        reasoningIncludedInOutput: false,
        ttftMs: null,
        completionMs: result.completionMs,
        costUsd: null,
        errorCode: result.errorCode,
        networkAttempts: result.attempts,
      });
      const bucket = db.prepare("SELECT events, error_rate_limit FROM operation_buckets").get() as {
        events: number;
        error_rate_limit: number;
      };
      expect(bucket).toEqual({ events: 1, error_rate_limit: 1 });
      const extras = db.prepare("SELECT COUNT(*) AS n FROM operation_stats WHERE operation_type = 'extra_attempt'").get() as { n: number };
      expect(extras.n).toBe(2);
    });
  });

  it("records each extra provider attempt and no quota unit for policy blocks", () => {
    withDb((db) => {
      recordModelInvocation(db, {
        runId: "run-9",
        userId: owner.id,
        model: "example/model:free",
        provider: "openrouter",
        occurredAt: "2026-10-27T11:10:00.000Z",
        succeeded: true,
        inputTokens: 4,
        outputTokens: 2,
        reasoningTokens: null,
        reasoningIncludedInOutput: false,
        ttftMs: 200,
        completionMs: 900,
        costUsd: null,
        errorCode: null,
        networkAttempts: 3,
      });
      recordModelInvocation(db, {
        runId: "run-10",
        userId: owner.id,
        model: "example/model:free",
        provider: "openrouter",
        occurredAt: "2026-10-27T11:11:00.000Z",
        succeeded: false,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        reasoningIncludedInOutput: false,
        ttftMs: null,
        completionMs: null,
        costUsd: null,
        errorCode: "POLICY_BLOCKED",
        networkAttempts: 0,
      });

      const rows = db.prepare("SELECT operation_id, operation_type, quota_units FROM operation_stats ORDER BY operation_id").all();
      expect(rows).toEqual([
        { operation_id: "extra:run-9:2", operation_type: "extra_attempt", quota_units: null },
        { operation_id: "extra:run-9:3", operation_type: "extra_attempt", quota_units: null },
        { operation_id: "generation:run-10", operation_type: "generation", quota_units: 0 },
        { operation_id: "generation:run-9", operation_type: "generation", quota_units: 1 },
      ]);
      const ttft = db.prepare("SELECT metric, le_ms FROM latency_histogram WHERE metric = 'ttft'").all();
      expect(ttft).toEqual([{ metric: "ttft", le_ms: 200 }]);
    });
  });

  it("writes question and comparison counters for an accepted request", () => {
    withDb((db) => {
      db.prepare("UPDATE users SET last_activity_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(owner.id);
      recordAcceptedComparison(db, {
        userId: owner.id,
        comparisonId: "comparison-1",
        occurredAt: "2026-10-27T12:00:00.000Z",
      });
      const rows = db.prepare("SELECT operation_id, operation_type, status FROM operation_stats ORDER BY operation_id").all();
      expect(rows).toEqual([
        { operation_id: "comparison:comparison-1", operation_type: "comparison", status: "accepted" },
        { operation_id: "question:comparison-1", operation_type: "question", status: "accepted" },
      ]);
      const user = db.prepare("SELECT last_activity_at FROM users WHERE id = ?").get(owner.id) as { last_activity_at: string };
      expect(user.last_activity_at).toBe("2026-10-27T12:00:00.000Z");
    });
  });
});

describe("presence", () => {
  it("counts a live registered session and expires it after the TTL", () => {
    withDb((db) => {
      const now = new Date("2026-10-27T12:00:00.000Z");
      beatPresence(db, { userId: owner.id, visitorId: null, now });
      expect(countPresence(db, new Date(now.getTime() + 30_000).toISOString())).toEqual({ registered: 1, anonymous: 0 });
      expect(countPresence(db, new Date(now.getTime() + 120_000).toISOString())).toEqual({ registered: 0, anonymous: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM presence").get()).toMatchObject({ n: 0 });
    });
  });

  it("issues a visitor id for anonymous hearts and clears both subjects", () => {
    withDb((db) => {
      const now = new Date("2026-10-27T12:00:00.000Z");
      const beat = beatPresence(db, { userId: null, visitorId: null, now });
      expect(beat.visitorId).toEqual(expect.any(String));
      expect(countPresence(db, now.toISOString())).toEqual({ registered: 0, anonymous: 1 });
      clearPresence(db, { userId: owner.id, visitorId: beat.visitorId });
      expect(db.prepare("SELECT COUNT(*) AS n FROM presence").get()).toMatchObject({ n: 0 });
    });
  });
});
