import { randomUUID } from "node:crypto";
import { findModel } from "@/domain/models/catalog";
import { dispatchModel } from "@/domain/models/dispatch";
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

const running = new Set<string>();

export function scheduleComparison(comparisonId: string): void {
  if (running.has(comparisonId)) return;
  running.add(comparisonId);
  void executeComparison(comparisonId).finally(() => running.delete(comparisonId));
}

async function executeComparison(comparisonId: string): Promise<void> {
  const db = getDatabase();
  const meta = comparisonMeta(db, comparisonId);
  if (!meta || meta.status === "closed") return;
  const claimToken = randomUUID();
  if (!claimComparisonJob(db, meta.jobId, claimToken)) return;
  markComparison(db, comparisonId, "running");
  const runs = readRunnableRuns(db, comparisonId);
  await Promise.allSettled(runs.map((run) => executeRun(comparisonId, meta.userId, meta.idempotencyKey, run)));
  closeReservations(db, meta.userId, meta.idempotencyKey);
  const closed = finishJob(db, { jobId: meta.jobId, claimToken, outcome: "completed" });
  if (closed) {
    releaseFlight(db, meta.userId, jobHolds(db, meta.jobId));
    markComparison(db, comparisonId, "closed");
  }
}

async function executeRun(
  comparisonId: string,
  userId: string,
  idempotencyKey: string,
  run: { id: string; modelId: string; provider: "anthropic" | "openrouter"; request: Record<string, unknown> | null },
): Promise<void> {
  const db = getDatabase();
  try {
    const model = findModel(run.modelId);
    markRunRunning(db, run.id);
    if (!model || model.provider !== run.provider) {
      saveRunResult(db, run.id, emptyFailure("النموذج غير مسموح", "MODEL_NOT_ALLOWED"));
      settleHeldUnit(db, { userId, idempotencyKey, provider: run.provider, used: false });
      return;
    }
    if (model.provider === "openrouter" && (!model.policyAllowsTraffic || !model.liveNetwork || !model.id.endsWith(":free"))) {
      saveRunResult(db, run.id, emptyFailure(model.usagePolicy, "POLICY_BLOCKED"));
      settleHeldUnit(db, { userId, idempotencyKey, provider: run.provider, used: false });
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
    settleHeldUnit(db, { userId, idempotencyKey, provider: run.provider, used: result.attempted });
    if (result.costUsd != null && run.provider === "anthropic") {
      db.prepare(`
        INSERT INTO usage_events (id, user_id, model_id, provider, kind, units, cost_usd)
        VALUES (?, ?, ?, 'anthropic', 'completion', 1, ?)
      `).run(randomUUID(), userId, run.modelId, result.costUsd);
    }
  } catch {
    saveRunResult(db, run.id, emptyFailure("تعذر تنفيذ هذا النموذج.", "RUN_FAILED"));
    settleHeldUnit(db, { userId, idempotencyKey, provider: run.provider, used: false });
  }
  void comparisonId;
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
