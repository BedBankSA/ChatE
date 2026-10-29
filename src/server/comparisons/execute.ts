import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { IMAGE_LIMIT_BYTES } from "@/domain/comparison/plan";
import { findModel } from "@/domain/models/catalog";
import { dispatchModel } from "@/domain/models/dispatch";
import { writeLog } from "@/domain/security/redact";
import { recordModelInvocation } from "@/server/admin/operations";
import { finishJob } from "@/server/db/settle";
import { getDatabase } from "@/server/db/runtime";
import { runtimeEnv } from "@/server/db/settings";
import { readOwnedFileRow } from "@/server/files/repository";
import { imageMediaType, readStoredBytes, type StorageEnv } from "@/server/files/storage";
import {
  claimComparisonJob,
  closeReservations,
  comparisonMeta,
  jobHolds,
  markComparison,
  markRunRunning,
  readRunnableRuns,
  reconcileStaleComparisonForId,
  releaseFlight,
  saveRunResult,
  settleRunHoldOnce,
} from "@/server/comparisons/store";

// One in-process guard per comparison. The SQLite claim is the cross-process
// guard; this set only prevents duplicate local scheduling.
const running = new Set<string>();

export function scheduleComparison(comparisonId: string): void {
  // GET polling and duplicate POSTs land here. If the previous execution died
  // (dead process, lost job) the comparison is repaired to a terminal status
  // before anything is scheduled again, so quota is released and clients stop.
  try {
    reconcileStaleComparisonForId(getDatabase(), comparisonId);
  } catch (error) {
    writeLog("comparison.reconcile_failed", {
      comparisonId,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
  if (running.has(comparisonId)) return;
  running.add(comparisonId);
  void executeComparison(comparisonId)
    .catch((error: unknown) => {
      writeLog("comparison.failed", {
        comparisonId,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    })
    .finally(() => {
      running.delete(comparisonId);
    });
}

async function executeComparison(comparisonId: string): Promise<void> {
  const db = getDatabase();
  const meta = comparisonMeta(db, comparisonId);
  if (!meta || meta.status === "closed" || meta.status === "failed" || meta.status === "incomplete") return;
  const claimToken = randomUUID();
  if (!claimComparisonJob(db, meta.jobId, claimToken)) return;
  try {
    markComparison(db, comparisonId, "running");
    const runs = readRunnableRuns(db, comparisonId);
    await Promise.allSettled(runs.map((run) => executeRun(meta.userId, meta.idempotencyKey, run)));
  } finally {
    // The quota hold and the job claim must be closed on every path, including
    // an unexpected throw, or the user's concurrency slot leaks forever.
    settleAndClose(db, meta, claimToken, comparisonId);
  }
}

function settleAndClose(
  db: ReturnType<typeof getDatabase>,
  meta: { userId: string; jobId: string; idempotencyKey: string },
  claimToken: string,
  comparisonId: string,
): void {
  try {
    closeReservations(db, meta.userId, meta.idempotencyKey);
  } catch (error) {
    writeLog("comparison.close_reservations_failed", {
      comparisonId,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
  let closed = false;
  try {
    closed = finishJob(db, { jobId: meta.jobId, claimToken, outcome: "completed" });
  } catch (error) {
    writeLog("comparison.finish_job_failed", {
      comparisonId,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
  if (!closed) {
    // The job was requeued or claimed elsewhere; leave the slot to its owner.
    return;
  }
  try {
    releaseFlight(db, meta.userId, jobHolds(db, meta.jobId));
    markComparison(db, comparisonId, "closed");
  } catch (error) {
    writeLog("comparison.release_flight_failed", {
      comparisonId,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
}

async function executeRun(
  userId: string,
  idempotencyKey: string,
  run: { id: string; modelId: string; provider: "anthropic" | "openrouter"; request: Record<string, unknown> | null },
): Promise<void> {
  const db = getDatabase();
  let used = false;
  try {
    const model = findModel(run.modelId);
    markRunRunning(db, run.id);
    if (!model || model.provider !== run.provider) {
      saveRunResult(db, run.id, emptyFailure("النموذج غير مسموح", "MODEL_NOT_ALLOWED"));
      return;
    }
    if (model.provider === "openrouter" && (!model.policyAllowsTraffic || !model.liveNetwork || !model.id.endsWith(":free"))) {
      saveRunResult(db, run.id, emptyFailure(model.usagePolicy, "POLICY_BLOCKED"));
      return;
    }
    // DB-managed credentials win over process.env so a key rotated from
    // /admin/settings applies to the very next comparison without a restart.
    const runtime = runtimeEnv();
    const result = await dispatchModel({
      provider: run.provider,
      modelId: model.id,
      endpoint: model.endpoint,
      request: hydrateImageRefs(db, userId, run.provider, run.request),
    }, {
      fetchImpl: fetch,
      openRouterKey: runtime.OPENROUTER_API_KEY,
      anthropicKey: runtime.ANTHROPIC_API_KEY,
      appUrl: runtime.APP_URL || "http://localhost:3211",
      env: runtime,
    });
    used = result.attempted;
    saveRunResult(db, run.id, {
      status: result.status,
      outputText: result.outputText,
      message: result.message,
      errorCode: result.errorCode,
      providerModelId: result.providerModelId,
      finishReason: result.finishReason,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsd: result.costUsd,
      completionMs: result.completionMs,
    });
    recordInvocation(db, {
      runId: run.id,
      userId,
      model: model.id,
      provider: run.provider,
      succeeded: result.status !== "failed",
      inputTokens: result.promptTokens,
      outputTokens: result.completionTokens,
      completionMs: result.completionMs,
      costUsd: result.costUsd,
      errorCode: result.errorCode,
      attempts: result.attempts,
    });
    if (result.costUsd != null && run.provider === "anthropic") {
      db.prepare(`
        INSERT INTO usage_events (id, user_id, model_id, provider, kind, units, cost_usd)
        VALUES (?, ?, ?, 'anthropic', 'completion', 1, ?)
      `).run(randomUUID(), userId, run.modelId, result.costUsd);
    }
  } catch {
    try {
      saveRunResult(db, run.id, emptyFailure("تعذر تنفيذ هذا النموذج.", "RUN_FAILED"));
    } catch {
      // The run row may already be settled or the database may be unavailable.
    }
    recordInvocation(db, {
      runId: run.id,
      userId,
      model: run.modelId,
      provider: run.provider,
      succeeded: false,
      inputTokens: null,
      outputTokens: null,
      completionMs: null,
      costUsd: null,
      errorCode: "RUN_FAILED",
      attempts: 0,
    });
  } finally {
    try {
      settleRunHoldOnce(db, {
        runId: run.id,
        userId,
        idempotencyKey,
        provider: run.provider,
        used,
      });
    } catch (error) {
      writeLog("comparison.settle_unit_failed", {
        runId: run.id,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
  }
}

/**
 * Replaces `{type:"image_ref"}` placeholders with real image content read from
 * private storage: Anthropic base64 blocks and OpenRouter data URLs. Ownership
 * is enforced through the files row (id + user), the media type must match the
 * detected type, and images above IMAGE_LIMIT_BYTES are downgraded to text, so a
 * stale or forged placeholder can never exfiltrate another user's file.
 * Requests without image placeholders are returned unchanged in shape.
 */
export function hydrateImageRefs(
  db: DatabaseSync,
  userId: string,
  provider: "anthropic" | "openrouter",
  request: Record<string, unknown> | null,
  options: { env?: StorageEnv; cwd?: string } = {},
): Record<string, unknown> | null {
  if (!request) return null;
  const cloned = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
  const messages = cloned.messages;
  if (!Array.isArray(messages)) return cloned;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (!Array.isArray(record.content)) continue;
    record.content = record.content.map((part) => hydratePart(db, userId, provider, part, options));
  }
  return cloned;
}

function hydratePart(
  db: DatabaseSync,
  userId: string,
  provider: "anthropic" | "openrouter",
  part: unknown,
  options: { env?: StorageEnv; cwd?: string },
): unknown {
  if (!part || typeof part !== "object") return part;
  const placeholder = part as Record<string, unknown>;
  if (placeholder.type !== "image_ref") return part;
  const fallback = { type: "text", text: "[تعذر تضمين الصورة المرفقة]" };
  const fileId = typeof placeholder.fileId === "string" ? placeholder.fileId : "";
  const mediaType = typeof placeholder.mediaType === "string" ? placeholder.mediaType : "";
  const row = readOwnedFileRow(db, userId, fileId);
  if (!row) return fallback;
  const expected = imageMediaType(row.detectedType);
  if (!expected || expected !== mediaType) return fallback;
  if (row.byteSize > IMAGE_LIMIT_BYTES) return fallback;
  const bytes = readStoredBytes({ userId, storageKey: row.storageKey, env: options.env, cwd: options.cwd });
  if (!bytes || bytes.byteLength === 0) return fallback;
  const data = bytes.toString("base64");
  if (provider === "anthropic") {
    return { type: "image", source: { type: "base64", media_type: expected, data } };
  }
  return { type: "image_url", image_url: { url: `data:${expected};base64,${data}` } };
}

function emptyFailure(message: string, errorCode: string) {
  return {
    status: "failed",
    outputText: "",
    message,
    errorCode,
    providerModelId: null,
    finishReason: null,
    promptTokens: null,
    completionTokens: null,
    costUsd: null,
    completionMs: null,
  };
}

function recordInvocation(
  db: DatabaseSync,
  draft: {
    runId: string;
    userId: string;
    model: string;
    provider: "anthropic" | "openrouter";
    succeeded: boolean;
    inputTokens: number | null;
    outputTokens: number | null;
    completionMs: number | null;
    costUsd: number | null;
    errorCode: string | null;
    attempts: number;
  },
): void {
  try {
    recordModelInvocation(db, {
      runId: draft.runId,
      userId: draft.userId,
      model: draft.model,
      provider: draft.provider,
      occurredAt: new Date().toISOString(),
      succeeded: draft.succeeded,
      inputTokens: draft.inputTokens,
      outputTokens: draft.outputTokens,
      reasoningTokens: null,
      reasoningIncludedInOutput: false,
      ttftMs: null,
      completionMs: draft.completionMs,
      costUsd: draft.costUsd,
      errorCode: draft.errorCode,
      networkAttempts: draft.attempts,
    });
  } catch (error) {
    // Statistics must never break a user-visible run.
    writeLog("comparison.stats_failed", {
      runId: draft.runId,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
}
