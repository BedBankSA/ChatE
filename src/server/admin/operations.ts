import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { hourBucket, latencyEdge, PRESENCE_TTL_MS } from "@/domain/admin/measure";
import { redactErrorCode } from "@/domain/admin/privacy";
import { changeCount, numberField } from "@/server/db/rows";
import { touchActivity } from "@/server/account-access";

export type OperationType =
  | "question"
  | "comparison"
  | "generation"
  | "extra_attempt"
  | "embedding"
  | "rerank"
  | "classification"
  | "speech";

export type OperationDraft = {
  operationId: string;
  userId: string | null;
  model: string | null;
  provider: string | null;
  operationType: OperationType;
  occurredAt: string;
  status: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  reasoningIncludedInOutput?: boolean;
  ttftMs?: number | null;
  completionMs?: number | null;
  costUsd?: number | null;
  quotaUnits?: number | null;
  errorCode?: string | null;
};

export function recordOperation(db: DatabaseSync, draft: OperationDraft): boolean {
  const errorCode = redactErrorCode(draft.errorCode);
  const included = draft.reasoningIncludedInOutput ? 1 : 0;
  const result = db.prepare(`
    INSERT INTO operation_stats (
      operation_id, user_id, model, provider, operation_type, occurred_at, status,
      input_tokens, output_tokens, reasoning_tokens, reasoning_included_in_output,
      ttft_ms, completion_ms, cost_usd, quota_units, error_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(operation_id) DO NOTHING
  `).run(
    draft.operationId,
    draft.userId,
    draft.model,
    draft.provider,
    draft.operationType,
    draft.occurredAt,
    draft.status,
    draft.inputTokens ?? null,
    draft.outputTokens ?? null,
    draft.reasoningTokens ?? null,
    included,
    draft.ttftMs ?? null,
    draft.completionMs ?? null,
    draft.costUsd ?? null,
    draft.quotaUnits ?? null,
    errorCode,
  );
  if (changeCount(result) !== 1) return false;
  incrementBucket(db, draft, errorCode);
  addLatency(db, "ttft", draft.occurredAt, draft.ttftMs);
  addLatency(db, "completion", draft.occurredAt, draft.completionMs);
  return true;
}

export function recordAcceptedComparison(
  db: DatabaseSync,
  input: { userId: string; comparisonId: string; occurredAt: string },
): void {
  recordOperation(db, {
    operationId: `question:${input.comparisonId}`,
    userId: input.userId,
    model: null,
    provider: null,
    operationType: "question",
    occurredAt: input.occurredAt,
    status: "accepted",
  });
  recordOperation(db, {
    operationId: `comparison:${input.comparisonId}`,
    userId: input.userId,
    model: null,
    provider: null,
    operationType: "comparison",
    occurredAt: input.occurredAt,
    status: "accepted",
  });
  touchActivity(db, input.userId, input.occurredAt);
}

export function recordModelInvocation(db: DatabaseSync, input: {
  runId: string;
  userId: string;
  model: string;
  provider: string;
  occurredAt: string;
  succeeded: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  reasoningIncludedInOutput: boolean;
  ttftMs: number | null;
  completionMs: number | null;
  costUsd: number | null;
  errorCode: string | null;
  networkAttempts: number;
}): void {
  recordOperation(db, {
    operationId: `generation:${input.runId}`,
    userId: input.userId,
    model: input.model,
    provider: input.provider,
    operationType: "generation",
    occurredAt: input.occurredAt,
    status: input.succeeded ? "succeeded" : "failed",
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    reasoningTokens: input.reasoningTokens,
    reasoningIncludedInOutput: input.reasoningIncludedInOutput,
    ttftMs: input.ttftMs,
    completionMs: input.completionMs,
    costUsd: input.costUsd,
    quotaUnits: 1,
    errorCode: input.errorCode,
  });
  const extra = Math.max(0, input.networkAttempts - 1);
  for (let attempt = 2; attempt <= extra + 1; attempt += 1) {
    recordOperation(db, {
      operationId: `extra:${input.runId}:${attempt}`,
      userId: input.userId,
      model: input.model,
      provider: input.provider,
      operationType: "extra_attempt",
      occurredAt: input.occurredAt,
      status: "recorded",
      quotaUnits: null,
    });
  }
}

export function beatPresence(
  db: DatabaseSync,
  input: { userId: string | null; visitorId: string | null; now: Date },
): { visitorId: string | null } {
  const nowIso = input.now.toISOString();
  const expires = new Date(input.now.getTime() + PRESENCE_TTL_MS).toISOString();
  if (input.userId) {
    upsertPresence(db, `user:${input.userId}`, input.userId, nowIso, expires);
    if (input.visitorId) db.prepare("DELETE FROM presence WHERE subject_key = ?").run(`anon:${input.visitorId}`);
    touchActivity(db, input.userId, nowIso);
    return { visitorId: input.visitorId };
  }
  const visitorId = input.visitorId ?? randomUUID();
  upsertPresence(db, `anon:${visitorId}`, null, nowIso, expires);
  return { visitorId };
}

export function clearPresence(db: DatabaseSync, input: { userId?: string | null; visitorId?: string | null }): void {
  if (input.userId) db.prepare("DELETE FROM presence WHERE user_id = ?").run(input.userId);
  if (input.visitorId) db.prepare("DELETE FROM presence WHERE subject_key = ?").run(`anon:${input.visitorId}`);
}

export function countPresence(db: DatabaseSync, nowIso: string): { anonymous: number; registered: number } {
  db.prepare("DELETE FROM presence WHERE expires_at <= ?").run(nowIso);
  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT user_id) AS registered,
      COALESCE(SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END), 0) AS anonymous
    FROM presence
    WHERE expires_at > ?
  `).get(nowIso);
  return {
    registered: row ? numberField(row, "registered") : 0,
    anonymous: row ? numberField(row, "anonymous") : 0,
  };
}

function upsertPresence(db: DatabaseSync, key: string, userId: string | null, seen: string, expires: string): void {
  db.prepare(`
    INSERT INTO presence (subject_key, user_id, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(subject_key) DO UPDATE SET
      user_id = excluded.user_id,
      last_seen_at = excluded.last_seen_at,
      expires_at = excluded.expires_at
  `).run(key, userId, seen, expires);
}

function incrementBucket(db: DatabaseSync, draft: OperationDraft, errorCode: string | null): void {
  const separate = draft.reasoningIncludedInOutput ? 0 : draft.reasoningTokens ?? 0;
  const included = draft.reasoningIncludedInOutput ? draft.reasoningTokens ?? 0 : 0;
  const costEvents = draft.costUsd == null ? 0 : 1;
  db.prepare(`
    INSERT INTO operation_buckets (
      bucket_start, operation_type, model, provider, status, events,
      input_tokens, output_tokens, reasoning_separate, reasoning_included,
      quota_units, cost_usd, cost_events, error_rate_limit, error_auth, error_service
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bucket_start, operation_type, model, provider, status) DO UPDATE SET
      events = events + 1,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      reasoning_separate = reasoning_separate + excluded.reasoning_separate,
      reasoning_included = reasoning_included + excluded.reasoning_included,
      quota_units = quota_units + excluded.quota_units,
      cost_usd = cost_usd + excluded.cost_usd,
      cost_events = cost_events + excluded.cost_events,
      error_rate_limit = error_rate_limit + excluded.error_rate_limit,
      error_auth = error_auth + excluded.error_auth,
      error_service = error_service + excluded.error_service
  `).run(
    hourBucket(draft.occurredAt),
    draft.operationType,
    draft.model ?? "",
    draft.provider ?? "",
    draft.status,
    draft.inputTokens ?? 0,
    draft.outputTokens ?? 0,
    separate,
    included,
    draft.quotaUnits ?? 0,
    draft.costUsd ?? 0,
    costEvents,
    errorCode === "RATE_LIMIT" ? 1 : 0,
    errorCode === "AUTH" ? 1 : 0,
    errorCode === "SERVICE" ? 1 : 0,
  );
}

function addLatency(db: DatabaseSync, metric: "ttft" | "completion", occurredAt: string, value: number | null | undefined): void {
  if (value == null || !Number.isFinite(value) || value < 0) return;
  const edge = latencyEdge(value);
  db.prepare(`
    INSERT INTO latency_histogram (metric, bucket_start, le_ms, events)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(metric, bucket_start, le_ms) DO UPDATE SET events = events + 1
  `).run(metric, hourBucket(occurredAt), edge);
}
