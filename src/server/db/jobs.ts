import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { StoreError } from "@/server/db/errors";
import { changeCount, nullableText, textField } from "@/server/db/rows";
import { immediateTransaction } from "@/server/db/transaction";
import { requireInteger, requireText } from "@/server/db/validate";

export const CLAIM_JOB_SQL = `
UPDATE jobs
SET status = 'active',
    claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    claim_token = ?
WHERE status = 'queued'
  AND (? IS NULL OR queue = ?)
  AND (not_before IS NULL OR not_before <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  AND id = (
    SELECT id FROM jobs
    WHERE status = 'queued'
      AND (? IS NULL OR queue = ?)
      AND (not_before IS NULL OR not_before <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ORDER BY created_at, id
    LIMIT 1
  )
RETURNING id, queue, payload, user_id, idempotency_key, reservation_id, provider
`.trim();

export type ClaimedJob = {
  id: string;
  queue: string;
  payload: string;
  userId: string | null;
  idempotencyKey: string | null;
  reservationId: string | null;
  provider: string;
};

const QUEUE_NAME = /^[a-z0-9-]{1,64}$/;

export function claimQueuedJob(db: DatabaseSync, claimToken: string, queue: string | null): ClaimedJob | null {
  const token = requireText(claimToken, "CLAIM_TOKEN");
  const queueName = queue == null ? null : requireQueue(queue);
  return immediateTransaction(db, () => {
    const row = db.prepare(CLAIM_JOB_SQL).get(token, queueName, queueName, queueName, queueName);
    return { commit: true, value: row ? claimedJob(row) : null };
  });
}

export function deferClaim(db: DatabaseSync, jobId: string, claimToken: string, delayMs: number): boolean {
  const seconds = Math.ceil(requireInteger(delayMs, "DELAY", 0, 86_400_000) / 1000);
  const result = db.prepare(`
    UPDATE jobs
    SET status = 'queued',
        claim_token = NULL,
        claimed_at = NULL,
        not_before = strftime('%Y-%m-%dT%H:%M:%fZ','now', '+' || ? || ' seconds')
    WHERE id = ? AND status = 'active' AND claim_token = ?
  `).run(String(seconds), requireText(jobId, "JOB_ID"), requireText(claimToken, "CLAIM_TOKEN"));
  return changeCount(result) === 1;
}

export function claimWithoutProvider(db: DatabaseSync, claimToken: string, delayMs: number): { id: string; queue: string } | null {
  const claimed = claimQueuedJob(db, claimToken, null);
  if (!claimed) return null;
  if (!deferClaim(db, claimed.id, claimToken, delayMs)) throw new StoreError("DEFER_FAILED");
  return { id: claimed.id, queue: claimed.queue };
}

export function requeueStaleClaims(db: DatabaseSync, claimedBeforeIso: string): number {
  const result = db.prepare(`
    UPDATE jobs
    SET status = 'queued', claim_token = NULL, claimed_at = NULL
    WHERE status = 'active' AND claimed_at IS NOT NULL AND claimed_at < ?
  `).run(requireText(claimedBeforeIso, "CLAIMED_BEFORE", 40));
  return changeCount(result);
}

function requireQueue(queue: string): string {
  const name = requireText(queue, "QUEUE", 64);
  if (!QUEUE_NAME.test(name)) throw new StoreError("QUEUE");
  return name;
}

function claimedJob(row: Record<string, SQLOutputValue>): ClaimedJob {
  return {
    id: textField(row, "id"),
    queue: textField(row, "queue"),
    payload: textField(row, "payload"),
    userId: nullableText(row, "user_id"),
    idempotencyKey: nullableText(row, "idempotency_key"),
    reservationId: nullableText(row, "reservation_id"),
    provider: textField(row, "provider"),
  };
}
