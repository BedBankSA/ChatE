import type { DatabaseSync } from "node:sqlite";
import { StoreError } from "@/server/db/errors";
import { SHARED_QUOTA_ID, userQuotaId } from "@/server/db/quota-ids";
import { changeCount, numberField } from "@/server/db/rows";
import { immediateTransaction } from "@/server/db/transaction";
import { requireText } from "@/server/db/validate";

export function finishJob(
  db: DatabaseSync,
  input: { jobId: string; claimToken: string; outcome: "completed" | "failed"; errorCode?: string | null },
): boolean {
  const jobId = requireText(input.jobId, "JOB_ID");
  const claimToken = requireText(input.claimToken, "CLAIM_TOKEN");
  const outcome = input.outcome === "completed" || input.outcome === "failed" ? input.outcome : null;
  if (!outcome) throw new StoreError("JOB_OUTCOME");
  const errorCode = outcome === "failed" ? requireText(input.errorCode ?? "failed", "ERROR_CODE") : null;
  return immediateTransaction(db, () => {
    const row = db.prepare(`
      SELECT user_id, reservation_id
      FROM jobs
      WHERE id = ? AND status = 'active' AND claim_token = ?
    `).get(jobId, claimToken);
    if (!row) return { commit: false, value: false };
    const userId = typeof row.user_id === "string" ? row.user_id : null;
    const reservationId = typeof row.reservation_id === "string" ? row.reservation_id : null;
    if (userId && reservationId && !settleReservation(db, userId, reservationId, outcome)) {
      throw new StoreError("QUOTA_SETTLE_FAILED");
    }
    const updated = db.prepare(`
      UPDATE jobs
      SET status = ?, error_code = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), claim_token = NULL
      WHERE id = ? AND status = 'active' AND claim_token = ?
    `).run(outcome, errorCode, jobId, claimToken);
    if (changeCount(updated) !== 1) throw new StoreError("JOB_FINISH_FAILED");
    return { commit: true, value: true };
  });
}

function settleReservation(db: DatabaseSync, userId: string, reservationId: string, outcome: "completed" | "failed"): boolean {
  const row = db.prepare(`
    SELECT units, status FROM usage_reservations WHERE id = ? AND user_id = ?
  `).get(reservationId, userId);
  if (!row || row.status !== "reserved") return false;
  const units = numberField(row, "units");
  const nextStatus = outcome === "completed" ? "used" : "released";
  const usedDelta = outcome === "completed" ? units : 0;
  const reservation = db.prepare(`
    UPDATE usage_reservations SET status = ? WHERE id = ? AND status = 'reserved'
  `).run(nextStatus, reservationId);
  if (changeCount(reservation) !== 1) return false;
  return moveUnits(db, SHARED_QUOTA_ID, units, usedDelta) && moveUnits(db, userQuotaId(userId), units, usedDelta);
}

function moveUnits(db: DatabaseSync, accountId: string, units: number, usedDelta: number): boolean {
  const result = db.prepare(`
    UPDATE quota_accounts
    SET reserved_units = reserved_units - ?,
        used_units = used_units + ?,
        in_flight = in_flight - ?
    WHERE id = ?
      AND reserved_units >= ?
      AND in_flight >= ?
  `).run(units, usedDelta, units, accountId, units, units);
  return changeCount(result) === 1;
}
