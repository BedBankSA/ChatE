import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { PlannedRun } from "@/domain/comparison/plan";
import type { PublicAttachment, PublicComparison, PublicRun } from "@/domain/comparison/view";
import { findModel } from "@/domain/models/catalog";
import type { QuotaLimits } from "@/server/db/quota";
import { SHARED_QUOTA_ID, userQuotaId } from "@/server/db/quota-ids";
import { changeCount } from "@/server/db/rows";
import { immediateTransaction } from "@/server/db/transaction";

type ProviderName = "openrouter" | "anthropic";

export type CreateComparisonResult =
  | { ok: true; comparison: PublicComparison; duplicate: boolean; holds: ProviderName[] }
  | { ok: false; code: "quota" | "concurrency"; message: string };

export function createComparison(
  db: DatabaseSync,
  input: {
    userId: string;
    idempotencyKey: string;
    question: string;
    evidenceMode: "native" | "unified";
    runs: PlannedRun[];
    limits: QuotaLimits;
    /** Owned file ids to persist in the evidence snapshot (already validated). */
    attachmentIds?: readonly string[];
    /** Shared evidence text derived from the attachments. */
    evidenceText?: string;
  },
): CreateComparisonResult {
  return immediateTransaction(db, (): { commit: boolean; value: CreateComparisonResult } => {
    const existing = findExisting(db, input.userId, input.idempotencyKey);
    if (existing) return { commit: true, value: { ok: true as const, comparison: existing, duplicate: true, holds: [] } };
    if (!db.prepare("SELECT id FROM users WHERE id = ?").get(input.userId)) {
      throw new Error("USER_NOT_FOUND");
    }
    const units = countUnits(input.runs);
    const held: ProviderName[] = [];
    for (const provider of ["openrouter", "anthropic"] as const) {
      const count = units[provider];
      if (count < 1) continue;
      const decision = hold(db, input.userId, input.idempotencyKey, provider, count, input.limits);
      if (!decision.ok) return { commit: false, value: decision };
      held.push(provider);
    }
    const comparisonId = randomUUID();
    const jobId = randomUUID();
    db.prepare(`
      INSERT INTO jobs (id, queue, payload, status, user_id, idempotency_key, reservation_id, provider)
      VALUES (?, 'comparison', ?, 'queued', ?, ?, NULL, 'none')
    `).run(jobId, JSON.stringify({ comparisonId, holds: held }), input.userId, input.idempotencyKey);
    db.prepare(`
      INSERT INTO comparisons (id, user_id, question, evidence_mode, idempotency_key, status)
      VALUES (?, ?, ?, ?, ?, 'queued')
    `).run(comparisonId, input.userId, input.question, input.evidenceMode, input.idempotencyKey);
    db.prepare(`
      INSERT INTO evidence_snapshots (id, comparison_id, user_id, payload)
      VALUES (?, ?, ?, ?)
    `).run(
      randomUUID(),
      comparisonId,
      input.userId,
      JSON.stringify({
        question: input.question,
        evidenceMode: input.evidenceMode,
        evidenceText: input.evidenceText ?? "",
        attachmentIds: [...(input.attachmentIds ?? [])],
      }),
    );
    const insertRun = db.prepare(`
      INSERT INTO model_runs (id, comparison_id, user_id, model_id, status, requested_settings, input_label, output_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, '')
    `);
    for (const run of input.runs) {
      const model = findModel(run.modelId);
      const provider = model?.provider === "anthropic" ? "anthropic" : "openrouter";
      insertRun.run(
        randomUUID(),
        comparisonId,
        input.userId,
        run.modelId,
        run.status,
        JSON.stringify({
          labels: run.labels,
          notes: run.notes,
          provider,
          displayName: run.displayName,
          effort: provider === "anthropic" ? "medium" : null,
          message: run.message,
          request: run.request,
        }),
        run.inputLabel,
      );
    }
    const comparison = readComparison(db, input.userId, comparisonId);
    if (!comparison) throw new Error("COMPARISON_MISSING");
    return { commit: true, value: { ok: true as const, comparison, duplicate: false, holds: held } };
  });
}

function comparisonRow(
  db: DatabaseSync,
  userId: string,
  comparisonId: string,
): Record<string, SQLOutputValue> | undefined {
  return db.prepare("SELECT id, question, status, created_at FROM comparisons WHERE id = ? AND user_id = ?").get(comparisonId, userId) as
    | Record<string, SQLOutputValue>
    | undefined;
}

export function readComparison(db: DatabaseSync, userId: string, comparisonId: string): PublicComparison | null {
  let row = comparisonRow(db, userId, comparisonId);
  if (!row) return null;
  // A comparison whose runs outlived the execution deadline (process crash,
  // abandoned job) is reconciled to a terminal status before it is returned, so
  // GET polling settles instead of looping forever. Inside an open transaction
  // (createComparison/duplicate lookup) the caller owns the state and we never
  // start a nested transaction.
  if ((row.status === "queued" || row.status === "running") && !db.isTransaction) {
    if (reconcileStaleComparison(db, userId, comparisonId).reconciled) {
      row = comparisonRow(db, userId, comparisonId);
      if (!row) return null;
    }
  }
  if (typeof row.id !== "string" || typeof row.question !== "string" || typeof row.status !== "string") return null;
  return {
    id: row.id,
    question: row.question,
    status: row.status,
    runs: readRuns(db, comparisonId),
    attachments: readAttachments(db, userId, comparisonId),
  };
}

/**
 * Message persisted on runs that stay non-terminal past the execution deadline.
 * Kept stable so the client can show it verbatim.
 */
export const STALE_RUN_MESSAGE = "انتهت مهلة التنفيذ أو توقف الخادم قبل اكتمال الإجابة.";
export const STALE_RUN_ERROR_CODE = "RUN_TIMEOUT";
const DEFAULT_MODEL_TIMEOUT_MS = 180_000;
const MIN_MODEL_TIMEOUT_MS = 30_000;
const MAX_MODEL_TIMEOUT_MS = 1_800_000;
const STALE_RUN_GRACE_MS = 30_000;

/**
 * Deadline after which a queued/running comparison is treated as abandoned:
 * MODEL_TIMEOUT_MS (default 180s, clamped to 30s..30min) plus a 30s grace so the
 * normal per-call timeout always wins first.
 */
export function staleRunDeadlineMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MODEL_TIMEOUT_MS?.trim() ?? "";
  const parsed = Number(raw);
  const timeout =
    raw !== "" && Number.isInteger(parsed) && parsed > 0
      ? Math.min(Math.max(parsed, MIN_MODEL_TIMEOUT_MS), MAX_MODEL_TIMEOUT_MS)
      : DEFAULT_MODEL_TIMEOUT_MS;
  return timeout + STALE_RUN_GRACE_MS;
}

export type ReconcileResult = { reconciled: boolean; status: "failed" | "incomplete" | null };

/**
 * Bounded, idempotent repair for a comparison whose execution never finished.
 * Only comparisons in queued/running whose every non-terminal run is older than
 * the deadline are touched. The transition is guarded by a single conditional
 * UPDATE on comparisons.status, so concurrent GETs cannot double-settle quota.
 */
export function reconcileStaleComparison(
  db: DatabaseSync,
  userId: string,
  comparisonId: string,
  options: { env?: Record<string, string | undefined>; now?: number } = {},
): ReconcileResult {
  if (db.isTransaction) return { reconciled: false, status: null };
  const cutoff = new Date((options.now ?? Date.now()) - staleRunDeadlineMs(options.env)).toISOString();
  if (!isAbandonedComparison(db, userId, comparisonId, cutoff)) return { reconciled: false, status: null };
  return immediateTransaction(db, (): { commit: boolean; value: ReconcileResult } => {
    if (!isAbandonedComparison(db, userId, comparisonId, cutoff)) {
      return { commit: false, value: { reconciled: false, status: null } };
    }
    const comparison = db.prepare(`
      SELECT idempotency_key, status FROM comparisons WHERE id = ? AND user_id = ?
    `).get(comparisonId, userId) as Record<string, SQLOutputValue> | undefined;
    if (!comparison || typeof comparison.idempotency_key !== "string" || typeof comparison.status !== "string") {
      return { commit: false, value: { reconciled: false, status: null } };
    }
    const idempotencyKey = comparison.idempotency_key;
    const active = db.prepare(`
      SELECT id, model_id, requested_settings FROM model_runs
      WHERE comparison_id = ? AND status IN ('queued', 'running')
    `).all(comparisonId) as unknown as Record<string, SQLOutputValue>[];
    const completedRow = db.prepare(`
      SELECT COUNT(*) AS total FROM model_runs WHERE comparison_id = ? AND status = 'completed'
    `).get(comparisonId) as Record<string, SQLOutputValue> | undefined;
    const completed = typeof completedRow?.total === "number" ? completedRow.total : Number(completedRow?.total ?? 0);
    // Partial answers are kept readable: "incomplete" when some run completed,
    // otherwise the comparison is a plain "failed".
    const nextStatus: "failed" | "incomplete" = completed > 0 ? "incomplete" : "failed";
    const updated = db.prepare(`
      UPDATE comparisons SET status = ? WHERE id = ? AND user_id = ? AND status IN ('queued', 'running')
    `).run(nextStatus, comparisonId, userId);
    if (changeCount(updated) !== 1) return { commit: false, value: { reconciled: false, status: null } };
    for (const run of active) {
      const runId = typeof run.id === "string" ? run.id : "";
      if (!runId) continue;
      const settings = parseJson(run.requested_settings) ?? {};
      const modelId = typeof run.model_id === "string" ? run.model_id : "";
      const provider: ProviderName = settings.provider === "anthropic" || findModel(modelId)?.provider === "anthropic"
        ? "anthropic"
        : "openrouter";
      // An execution that already settled this unit must not be settled twice.
      const alreadySettled = settings.holdSettled === true;
      settings.message = STALE_RUN_MESSAGE;
      settings.holdSettled = true;
      const marked = db.prepare(`
        UPDATE model_runs
        SET status = 'failed', error_code = ?, requested_settings = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `).run(STALE_RUN_ERROR_CODE, JSON.stringify(settings), runId);
      if (changeCount(marked) !== 1 || alreadySettled) continue;
      settleHeldUnit(db, { userId, idempotencyKey, provider, used: false });
    }
    closeReservations(db, userId, idempotencyKey);
    closeAbandonedJob(db, userId, idempotencyKey);
    return { commit: true, value: { reconciled: true, status: nextStatus } };
  });
}

/** Reconcile by comparison id when the caller does not know the owner yet. */
export function reconcileStaleComparisonForId(
  db: DatabaseSync,
  comparisonId: string,
  options: { env?: Record<string, string | undefined>; now?: number } = {},
): ReconcileResult {
  if (db.isTransaction) return { reconciled: false, status: null };
  const row = db.prepare("SELECT user_id FROM comparisons WHERE id = ?").get(comparisonId) as
    | Record<string, SQLOutputValue>
    | undefined;
  const userId = typeof row?.user_id === "string" ? row.user_id : "";
  if (!userId) return { reconciled: false, status: null };
  return reconcileStaleComparison(db, userId, comparisonId, options);
}

/**
 * Settles the quota unit of one run exactly once. Normal execution and the
 * stale reconciler race for the same unit; the "holdSettled" marker written in
 * the same transaction makes the second caller a no-op.
 */
export function settleRunHoldOnce(
  db: DatabaseSync,
  input: { runId: string; userId: string; idempotencyKey: string; provider: ProviderName; used: boolean },
): boolean {
  return immediateTransaction(db, () => {
    const row = db.prepare("SELECT requested_settings FROM model_runs WHERE id = ?").get(input.runId) as
      | Record<string, SQLOutputValue>
      | undefined;
    if (!row) {
      // Row vanished: keep the historical best-effort behavior rather than
      // leaking the hold silently.
      settleHeldUnit(db, input);
      return { commit: true, value: true };
    }
    const settings = parseJson(row.requested_settings) ?? {};
    if (settings.holdSettled === true) return { commit: false, value: false };
    settings.holdSettled = true;
    db.prepare("UPDATE model_runs SET requested_settings = ? WHERE id = ?").run(JSON.stringify(settings), input.runId);
    settleHeldUnit(db, input);
    return { commit: true, value: true };
  });
}

function isAbandonedComparison(db: DatabaseSync, userId: string, comparisonId: string, cutoff: string): boolean {
  const comparison = comparisonRow(db, userId, comparisonId);
  if (!comparison || (comparison.status !== "queued" && comparison.status !== "running")) return false;
  const active = db.prepare(`
    SELECT created_at FROM model_runs WHERE comparison_id = ? AND status IN ('queued', 'running')
  `).all(comparisonId) as unknown as Record<string, SQLOutputValue>[];
  if (active.length === 0) {
    return typeof comparison.created_at === "string" && comparison.created_at < cutoff;
  }
  // Every non-terminal run must be older than the cutoff: the newest one has to
  // look abandoned before the comparison is repaired.
  let newest = "";
  for (const run of active) {
    if (typeof run.created_at === "string" && run.created_at > newest) newest = run.created_at;
  }
  return newest !== "" && newest < cutoff;
}

function closeAbandonedJob(db: DatabaseSync, userId: string, idempotencyKey: string): void {
  const job = db.prepare(`
    SELECT id FROM jobs
    WHERE user_id = ? AND queue = 'comparison' AND idempotency_key = ? AND provider = 'none'
  `).get(userId, idempotencyKey) as Record<string, SQLOutputValue> | undefined;
  const jobId = typeof job?.id === "string" ? job.id : "";
  if (!jobId) return;
  const updated = db.prepare(`
    UPDATE jobs
    SET status = 'failed', error_code = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), claim_token = NULL
    WHERE id = ? AND status IN ('queued', 'active')
  `).run(STALE_RUN_ERROR_CODE, jobId);
  // The concurrency slot belongs to the abandoned execution; release it once.
  if (changeCount(updated) === 1) releaseFlight(db, userId, jobHolds(db, jobId));
}

/**
 * Attachments are stored as ids in evidence_snapshots.payload; names/types are
 * resolved from the owner's files rows. A comparison never shows another user's
 * file: the join is filtered by the same userId as the comparison read.
 */
function readAttachments(db: DatabaseSync, userId: string, comparisonId: string): PublicAttachment[] {
  const snapshot = db.prepare(`
    SELECT payload FROM evidence_snapshots
    WHERE comparison_id = ? AND user_id = ?
    ORDER BY rowid LIMIT 1
  `).get(comparisonId, userId) as Record<string, SQLOutputValue> | undefined;
  const payload = parseJson(snapshot?.payload);
  const ids = Array.isArray(payload?.attachmentIds)
    ? payload.attachmentIds.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT id, original_name, detected_type FROM files
    WHERE user_id = ? AND id IN (${placeholders})
  `).all(userId, ...ids) as unknown as Record<string, SQLOutputValue>[];
  const byId = new Map<string, PublicAttachment>();
  for (const row of rows) {
    if (typeof row.id !== "string" || typeof row.original_name !== "string" || typeof row.detected_type !== "string") continue;
    byId.set(row.id, { id: row.id, name: row.original_name, detectedType: row.detected_type });
  }
  return ids.flatMap((id) => {
    const attachment = byId.get(id);
    return attachment ? [attachment] : [];
  });
}

export type RunnableRun = {
  id: string;
  modelId: string;
  provider: "anthropic" | "openrouter";
  request: Record<string, unknown> | null;
};

export function readRunnableRuns(db: DatabaseSync, comparisonId: string): RunnableRun[] {
  const rows = db.prepare(`
    SELECT id, model_id, requested_settings
    FROM model_runs
    WHERE comparison_id = ? AND status = 'queued'
  `).all(comparisonId) as unknown as Record<string, SQLOutputValue>[];
  return rows.flatMap((row) => {
    if (typeof row.id !== "string" || typeof row.model_id !== "string") return [];
    const settings = parseJson(row.requested_settings);
    const provider = settings?.provider === "anthropic" ? "anthropic" : "openrouter";
    const request = settings?.request && typeof settings.request === "object"
      ? settings.request as Record<string, unknown>
      : null;
    return [{ id: row.id, modelId: row.model_id, provider, request }];
  });
}

export function comparisonMeta(db: DatabaseSync, comparisonId: string): { userId: string; jobId: string; status: string; idempotencyKey: string } | null {
  const row = db.prepare(`
    SELECT c.user_id, c.status, c.idempotency_key, j.id AS job_id
    FROM comparisons c
    LEFT JOIN jobs j
      ON j.user_id = c.user_id
     AND j.queue = 'comparison'
     AND j.idempotency_key = c.idempotency_key
     AND j.provider = 'none'
    WHERE c.id = ?
  `).get(comparisonId) as Record<string, SQLOutputValue> | undefined;
  if (!row || typeof row.user_id !== "string" || typeof row.job_id !== "string" || typeof row.status !== "string" || typeof row.idempotency_key !== "string") {
    return null;
  }
  return { userId: row.user_id, jobId: row.job_id, status: row.status, idempotencyKey: row.idempotency_key };
}

export function claimComparisonJob(db: DatabaseSync, jobId: string, claimToken: string): boolean {
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  db.prepare(`
    UPDATE jobs
    SET status = 'queued', claim_token = NULL, claimed_at = NULL
    WHERE id = ? AND status = 'active' AND claimed_at IS NOT NULL AND claimed_at < ?
  `).run(jobId, stale);
  const result = db.prepare(`
    UPDATE jobs
    SET status = 'active', claim_token = ?, claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND status = 'queued'
  `).run(claimToken, jobId);
  return changeCount(result) === 1;
}

export function markComparison(db: DatabaseSync, comparisonId: string, status: string): void {
  db.prepare("UPDATE comparisons SET status = ? WHERE id = ?").run(status, comparisonId);
}

export function markRunRunning(db: DatabaseSync, runId: string): void {
  db.prepare("UPDATE model_runs SET status = 'running' WHERE id = ? AND status = 'queued'").run(runId);
}

export function saveRunResult(
  db: DatabaseSync,
  runId: string,
  result: {
    status: string;
    outputText: string;
    message: string | null;
    errorCode: string | null;
    providerModelId: string | null;
    finishReason: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    costUsd: number | null;
    completionMs: number | null;
  },
): void {
  const current = db.prepare("SELECT requested_settings FROM model_runs WHERE id = ?").get(runId) as
    | Record<string, SQLOutputValue>
    | undefined;
  const settings = parseJson(current?.requested_settings) ?? {};
  settings.message = result.message;
  db.prepare(`
    UPDATE model_runs
    SET status = ?, output_text = ?, error_code = ?, provider_model_id = ?,
        finish_reason = ?, prompt_tokens = ?, completion_tokens = ?, cost_usd = ?, completion_ms = ?,
        requested_settings = ?
    WHERE id = ?
  `).run(
    result.status,
    result.outputText,
    result.errorCode,
    result.providerModelId,
    result.finishReason,
    result.promptTokens,
    result.completionTokens,
    result.costUsd,
    result.completionMs,
    JSON.stringify(settings),
    runId,
  );
}

export function settleHeldUnit(
  db: DatabaseSync,
  input: { userId: string; idempotencyKey: string; provider: ProviderName; used: boolean },
): void {
  const usedDelta = input.used ? 1 : 0;
  for (const accountId of [accountIdFor(input.provider, "shared", input.userId), accountIdFor(input.provider, "user", input.userId)]) {
    db.prepare(`
      UPDATE quota_accounts
      SET reserved_units = reserved_units - 1,
          used_units = used_units + ?
      WHERE id = ? AND reserved_units >= 1
    `).run(usedDelta, accountId);
  }
  void input.idempotencyKey;
}

export function releaseFlight(db: DatabaseSync, userId: string, holds: ProviderName[]): void {
  for (const provider of holds) {
    for (const accountId of [accountIdFor(provider, "shared", userId), accountIdFor(provider, "user", userId)]) {
      db.prepare("UPDATE quota_accounts SET in_flight = in_flight - 1 WHERE id = ? AND in_flight >= 1").run(accountId);
    }
  }
}

export function closeReservations(db: DatabaseSync, userId: string, idempotencyKey: string): void {
  db.prepare(`
    UPDATE usage_reservations
    SET status = CASE
      WHEN EXISTS (
        SELECT 1
        FROM model_runs mr
        JOIN comparisons c ON c.id = mr.comparison_id
        WHERE c.user_id = usage_reservations.user_id
          AND c.idempotency_key = usage_reservations.idempotency_key
          AND mr.completion_ms IS NOT NULL
      ) THEN 'used'
      ELSE 'released'
    END
    WHERE user_id = ? AND idempotency_key = ? AND status = 'reserved'
  `).run(userId, idempotencyKey);
}

export function jobHolds(db: DatabaseSync, jobId: string): ProviderName[] {
  const row = db.prepare("SELECT payload FROM jobs WHERE id = ?").get(jobId) as Record<string, SQLOutputValue> | undefined;
  const payload = parseJson(row?.payload);
  if (!payload || !Array.isArray(payload.holds)) return [];
  return payload.holds.filter((item): item is ProviderName => item === "openrouter" || item === "anthropic");
}

function findExisting(db: DatabaseSync, userId: string, idempotencyKey: string): PublicComparison | null {
  const row = db.prepare("SELECT id FROM comparisons WHERE user_id = ? AND idempotency_key = ?").get(userId, idempotencyKey) as
    | Record<string, SQLOutputValue>
    | undefined;
  if (!row || typeof row.id !== "string") return null;
  return readComparison(db, userId, row.id);
}

function countUnits(runs: PlannedRun[]): Record<ProviderName, number> {
  const totals: Record<ProviderName, number> = { openrouter: 0, anthropic: 0 };
  for (const run of runs) {
    if (run.status !== "queued") continue;
    const provider = findModel(run.modelId)?.provider;
    if (provider === "anthropic" || provider === "openrouter") totals[provider] += 1;
  }
  return totals;
}

function hold(
  db: DatabaseSync,
  userId: string,
  idempotencyKey: string,
  provider: ProviderName,
  units: number,
  limits: QuotaLimits,
): { ok: true } | { ok: false; code: "quota" | "concurrency"; message: string } {
  const sharedId = accountIdFor(provider, "shared", userId);
  const userAccountId = accountIdFor(provider, "user", userId);
  ensureAccount(db, sharedId, "shared", null, limits.sharedLimit);
  ensureAccount(db, userAccountId, "user", userId, limits.userLimit);
  const shared = readAccount(db, sharedId);
  const userAccount = readAccount(db, userAccountId);
  if (shared.inFlight + 1 > limits.maxGlobalConcurrent || userAccount.inFlight + 1 > limits.maxUserConcurrent) {
    return { ok: false, code: "concurrency", message: "هناك مقارنات كثيرة قيد الإرسال. انتظر اكتمالها." };
  }
  if (shared.used + shared.reserved + units > shared.limit || userAccount.used + userAccount.reserved + units > userAccount.limit) {
    return { ok: false, code: "quota", message: "الحصة لا تكفي لهذه المقارنة." };
  }
  if (!applyHold(db, sharedId, units, limits.maxGlobalConcurrent) || !applyHold(db, userAccountId, units, limits.maxUserConcurrent)) {
    return { ok: false, code: "quota", message: "الحصة لا تكفي لهذه المقارنة." };
  }
  db.prepare(`
    INSERT INTO usage_reservations (id, user_id, idempotency_key, provider, units, status)
    VALUES (?, ?, ?, ?, ?, 'reserved')
  `).run(randomUUID(), userId, idempotencyKey, provider, units);
  return { ok: true };
}

function ensureAccount(db: DatabaseSync, id: string, scope: string, userId: string | null, limitUnits: number): void {
  db.prepare(`
    INSERT INTO quota_accounts (id, scope, user_id, limit_units)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(id, scope, userId, limitUnits);
}

function readAccount(db: DatabaseSync, id: string): { limit: number; used: number; reserved: number; inFlight: number } {
  const row = db.prepare("SELECT limit_units, used_units, reserved_units, in_flight FROM quota_accounts WHERE id = ?").get(id) as
    | Record<string, SQLOutputValue>
    | undefined;
  return {
    limit: numberValue(row?.limit_units),
    used: numberValue(row?.used_units),
    reserved: numberValue(row?.reserved_units),
    inFlight: numberValue(row?.in_flight),
  };
}

function applyHold(db: DatabaseSync, id: string, units: number, maxConcurrent: number): boolean {
  const result = db.prepare(`
    UPDATE quota_accounts
    SET reserved_units = reserved_units + ?,
        in_flight = in_flight + 1
    WHERE id = ?
      AND used_units + reserved_units + ? <= limit_units
      AND in_flight + 1 <= ?
  `).run(units, id, units, maxConcurrent);
  return changeCount(result) === 1;
}

function accountIdFor(provider: ProviderName, scope: "shared" | "user", userId: string): string {
  if (provider === "openrouter") return scope === "shared" ? SHARED_QUOTA_ID : userQuotaId(userId);
  return scope === "shared" ? "shared:anthropic" : `${userQuotaId(userId)}:anthropic`;
}

function readRuns(db: DatabaseSync, comparisonId: string): PublicRun[] {
  const rows = db.prepare(`
    SELECT model_id, status, output_text, requested_settings, completion_ms
    FROM model_runs
    WHERE comparison_id = ?
    ORDER BY created_at, id
  `).all(comparisonId) as unknown as Record<string, SQLOutputValue>[];
  return rows.flatMap((row) => {
    if (typeof row.model_id !== "string" || typeof row.status !== "string") return [];
    const settings = parseJson(row.requested_settings);
    const labels = Array.isArray(settings?.labels) ? settings.labels.filter((item): item is string => typeof item === "string") : [];
    const model = findModel(row.model_id);
    const provider = settings?.provider === "anthropic" || model?.provider === "anthropic" ? "anthropic" as const : "openrouter" as const;
    return [{
      modelId: row.model_id,
      displayName: typeof settings?.displayName === "string" ? settings.displayName : model?.displayName ?? row.model_id,
      provider,
      status: row.status,
      message: typeof settings?.message === "string" ? settings.message : null,
      outputText: typeof row.output_text === "string" ? row.output_text : "",
      effort: typeof settings?.effort === "string" ? settings.effort : null,
      labels,
      completionMs: typeof row.completion_ms === "number" ? row.completion_ms : null,
    }];
  });
}

function parseJson(value: SQLOutputValue | undefined): Record<string, unknown> | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function numberValue(value: SQLOutputValue | undefined): number {
  return typeof value === "number" ? value : 0;
}
