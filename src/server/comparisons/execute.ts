import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { findModel } from "@/domain/models/catalog";
import { dispatchModel } from "@/domain/models/dispatch";
import { writeLog } from "@/domain/security/redact";
import { recordModelInvocation } from "@/server/admin/operations";
import { finishJob } from "@/server/db/settle";
import { getDatabase } from "@/server/db/runtime";
import {
  claimComparisonJob,
  closeReservations,
  comparisonMeta,
  jobHolds,
  markComparison,
  markRunRunning,
  readRunnableRuns,
  releaseFlight,
  saveRunResult,
  settleHeldUnit,
} from "@/server/comparisons/store";

// One in-process guard per comparison. The SQLite claim is the cross-process
// guard; this set only prevents duplicate local scheduling.
const running = new Set<string>();

export function scheduleComparison(comparisonId: string): void {
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
  if (!meta || meta.status === "closed") return;
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
    const result = await dispatchModel({
      provider: run.provider,
      modelId: model.id,
      endpoint: model.endpoint,
      request: run.request,
    }, {
      fetchImpl: fetch,
      openRouterKey: process.env.OPENROUTER_API_KEY,
      anthropicKey: process.env.ANTHROPIC_API_KEY,
      appUrl: process.env.APP_URL || "http://localhost:3211",
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
      settleHeldUnit(db, { userId, idempotencyKey, provider: run.provider, used });
    } catch (error) {
      writeLog("comparison.settle_unit_failed", {
        runId: run.id,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
  }
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
