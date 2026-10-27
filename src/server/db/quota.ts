import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { beginIdempotent, reserve, RESERVE_LOCK_SQL } from "@/domain/quota/reserve";
import { StoreError } from "@/server/db/errors";
import { SHARED_QUOTA_ID, userQuotaId } from "@/server/db/quota-ids";
import { changeCount, numberField, textField } from "@/server/db/rows";
import { immediateTransaction } from "@/server/db/transaction";
import { requireInteger, requireText } from "@/server/db/validate";

const PROVIDERS = ["openrouter", "anthropic", "none"] as const;
const QUEUE_NAME = /^[a-z0-9-]{1,64}$/;

export type QuotaLimits = {
  sharedLimit: number;
  userLimit: number;
  maxUserConcurrent: number;
  maxGlobalConcurrent: number;
};

export type ReserveAndEnqueueInput = {
  userId: string;
  queue: string;
  provider: (typeof PROVIDERS)[number];
  units: number;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  limits: QuotaLimits;
};

export type ReserveAndEnqueueResult =
  | { ok: true; jobId: string; duplicate: boolean }
  | { ok: false; code: "quota" | "concurrency" };

type QuotaAccount = {
  limitUnits: number;
  usedUnits: number;
  reservedUnits: number;
  inFlight: number;
};

export function readQuotaLimits(env: Record<string, string | undefined>): QuotaLimits {
  return {
    sharedLimit: readPositive(env.SHARED_QUOTA_UNITS, 2000),
    userLimit: readPositive(env.USER_QUOTA_UNITS, 200),
    maxUserConcurrent: readPositive(env.MAX_USER_CONCURRENCY, 2),
    maxGlobalConcurrent: readPositive(env.MAX_GLOBAL_CONCURRENCY, 8),
  };
}

export function reserveAndEnqueue(db: DatabaseSync, input: ReserveAndEnqueueInput): ReserveAndEnqueueResult {
  const userId = requireText(input.userId, "USER_ID");
  const queue = requireQueue(input.queue);
  const provider = requireProvider(input.provider);
  const units = requireInteger(input.units, "QUOTA_UNITS", 1, 1_000_000);
  const idempotencyKey = requireText(input.idempotencyKey, "IDEMPOTENCY_KEY");
  const payload = encodePayload(input.payload);
  const limits = requireLimits(input.limits);
  return immediateTransaction<ReserveAndEnqueueResult>(db, () => {
    const duplicateJobId = findDuplicateJob(db, userId, idempotencyKey, provider, queue);
    if (duplicateJobId) return { commit: true, value: { ok: true as const, jobId: duplicateJobId, duplicate: true } };
    if (!db.prepare("SELECT id FROM users WHERE id = ?").get(userId)) throw new StoreError("USER_NOT_FOUND");
    ensureAccount(db, SHARED_QUOTA_ID, "shared", null, limits.sharedLimit);
    const userAccountId = userQuotaId(userId);
    ensureAccount(db, userAccountId, "user", userId, limits.userLimit);
    const shared = readAccount(db, SHARED_QUOTA_ID);
    const userAccount = readAccount(db, userAccountId);
    const decision = reserve({
      sharedLimit: shared.limitUnits,
      sharedUsed: shared.usedUnits,
      sharedReserved: shared.reservedUnits,
      userLimit: userAccount.limitUnits,
      userUsed: userAccount.usedUnits,
      userReserved: userAccount.reservedUnits,
      userInFlight: userAccount.inFlight,
      globalInFlight: shared.inFlight,
      maxUserConcurrent: limits.maxUserConcurrent,
      maxGlobalConcurrent: limits.maxGlobalConcurrent,
    }, units);
    if (!decision.ok) return { commit: false, value: { ok: false as const, code: decision.code } };
    if (!applyReserve(db, SHARED_QUOTA_ID, units, limits.maxGlobalConcurrent)) throw new StoreError("QUOTA_CONFLICT");
    if (!applyReserve(db, userAccountId, units, limits.maxUserConcurrent)) throw new StoreError("QUOTA_CONFLICT");
    const reservationId = randomUUID();
    const jobId = randomUUID();
    db.prepare(`
      INSERT INTO usage_reservations (id, user_id, idempotency_key, provider, units, status)
      VALUES (?, ?, ?, ?, ?, 'reserved')
    `).run(reservationId, userId, idempotencyKey, provider, units);
    db.prepare(`
      INSERT INTO jobs (id, queue, payload, status, user_id, idempotency_key, reservation_id, provider)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
    `).run(jobId, queue, payload, userId, idempotencyKey, reservationId, provider);
    return { commit: true, value: { ok: true as const, jobId, duplicate: false } };
  });
}

function findDuplicateJob(db: DatabaseSync, userId: string, key: string, provider: string, queue: string): string | null {
  const reservation = db.prepare(`
    SELECT idempotency_key FROM usage_reservations
    WHERE user_id = ? AND idempotency_key = ? AND provider = ?
  `).get(userId, key, provider);
  const existing = reservation ? { id: "reservation", key: textField(reservation, "idempotency_key") } : null;
  if (!beginIdempotent(existing, key).duplicate) return null;
  const job = db.prepare(`
    SELECT id FROM jobs
    WHERE user_id = ? AND queue = ? AND idempotency_key = ? AND provider = ?
  `).get(userId, queue, key, provider);
  if (!job) throw new StoreError("IDEMPOTENCY_JOB_MISSING");
  return textField(job, "id");
}

// The first reservation seeds the cap. Later calls keep the stored cap.
function ensureAccount(db: DatabaseSync, id: string, scope: string, userId: string | null, limitUnits: number): void {
  db.prepare(`
    INSERT INTO quota_accounts (id, scope, user_id, limit_units)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(id, scope, userId, limitUnits);
}

function readAccount(db: DatabaseSync, id: string): QuotaAccount {
  const row = db.prepare(`
    SELECT limit_units, used_units, reserved_units, in_flight FROM quota_accounts WHERE id = ?
  `).get(id);
  if (!row) throw new StoreError("QUOTA_ACCOUNT_MISSING");
  return {
    limitUnits: numberField(row, "limit_units"),
    usedUnits: numberField(row, "used_units"),
    reservedUnits: numberField(row, "reserved_units"),
    inFlight: numberField(row, "in_flight"),
  };
}

function applyReserve(db: DatabaseSync, id: string, units: number, maxConcurrent: number): boolean {
  const result = db.prepare(RESERVE_LOCK_SQL).run(units, units, id, units, units, maxConcurrent);
  return changeCount(result) === 1;
}

function requireQueue(queue: string): string {
  const name = requireText(queue, "QUEUE", 64);
  if (!QUEUE_NAME.test(name)) throw new StoreError("QUEUE");
  return name;
}

function requireProvider(provider: string): (typeof PROVIDERS)[number] {
  if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) throw new StoreError("PROVIDER");
  return provider as (typeof PROVIDERS)[number];
}

function requireLimits(limits: QuotaLimits): QuotaLimits {
  return {
    sharedLimit: requireInteger(limits.sharedLimit, "QUOTA_LIMIT", 1, 1_000_000_000),
    userLimit: requireInteger(limits.userLimit, "QUOTA_LIMIT", 1, 1_000_000_000),
    maxUserConcurrent: requireInteger(limits.maxUserConcurrent, "QUOTA_LIMIT", 1, 1_000_000),
    maxGlobalConcurrent: requireInteger(limits.maxGlobalConcurrent, "QUOTA_LIMIT", 1, 1_000_000),
  };
}

function encodePayload(payload: Record<string, unknown>): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new StoreError("PAYLOAD");
  let encoded = "";
  try {
    encoded = JSON.stringify(payload);
  } catch {
    throw new StoreError("PAYLOAD");
  }
  if (!encoded || encoded.length > 1_000_000) throw new StoreError("PAYLOAD");
  return encoded;
}

function readPositive(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  return requireInteger(Number(value), "QUOTA_CONFIG", 1, 1_000_000_000);
}
