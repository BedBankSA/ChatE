import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { PublicRun } from "@/domain/comparison/view";
import { readComparison } from "@/server/comparisons/store";

/** Default page size shared by the page and the JSON API. */
export const HISTORY_PAGE_SIZE = 20;
export const HISTORY_MAX_LIMIT = 50;

export type HistoryItem = {
  id: string;
  question: string;
  status: string;
  createdAt: string;
  runCount: number;
  completedCount: number;
  modelIds: string[];
};

export type HistoryAttachment = {
  id: string;
  name: string;
  detectedType: string;
};

export type HistoryComparison = {
  id: string;
  question: string;
  status: string;
  createdAt: string;
  runs: PublicRun[];
  attachments: HistoryAttachment[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Newest-first page of a single user's comparisons. Reads only the comparison
 * rows, run counts, and the model ids of the page; the question is returned in
 * full so callers (not SQL) decide how to shorten it.
 *
 * `before` is an opaque cursor produced by encodeHistoryCursor() from the last
 * row of the previous page. An unreadable cursor is ignored and the newest page
 * is returned instead of failing the request.
 */
export function listComparisons(
  db: DatabaseSync,
  userId: string,
  options: { limit: number; before?: string },
): HistoryItem[] {
  const limit = clampHistoryLimit(options.limit);
  const cursor = options.before ? decodeHistoryCursor(options.before) : null;
  const params: (string | number)[] = [userId];
  let sql = `
    SELECT c.id, c.question, c.status, c.created_at,
           COUNT(mr.id) AS run_count,
           COALESCE(SUM(CASE WHEN mr.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count
    FROM comparisons c
    LEFT JOIN model_runs mr ON mr.comparison_id = c.id
    WHERE c.user_id = ?`;
  if (cursor) {
    sql += " AND (c.created_at < ? OR (c.created_at = ? AND c.id < ?))";
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  sql += " GROUP BY c.id ORDER BY c.created_at DESC, c.id DESC LIMIT ?";
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as unknown as Record<string, SQLOutputValue>[];
  const modelIds = readModelIds(db, rows.flatMap((row) => (typeof row.id === "string" ? [row.id] : [])));
  return rows.flatMap((row) => {
    if (typeof row.id !== "string" || typeof row.question !== "string" || typeof row.status !== "string") return [];
    if (typeof row.created_at !== "string") return [];
    return [{
      id: row.id,
      question: row.question,
      status: row.status,
      createdAt: row.created_at,
      runCount: numberValue(row.run_count),
      completedCount: numberValue(row.completed_count),
      modelIds: modelIds.get(row.id) ?? [],
    }];
  });
}

/**
 * Read-only detail for one owner. Reuses the store's comparison/run read and
 * adds the creation date plus the attachment names recorded with the evidence
 * snapshot when the comparison has any.
 */
export function readComparisonForUser(
  db: DatabaseSync,
  userId: string,
  comparisonId: string,
): HistoryComparison | null {
  if (!isComparisonId(comparisonId)) return null;
  const comparison = readComparison(db, userId, comparisonId);
  if (!comparison) return null;
  const createdAt = readCreatedAt(db, userId, comparisonId);
  if (createdAt == null) return null;
  return {
    id: comparison.id,
    question: comparison.question,
    status: comparison.status,
    createdAt,
    runs: comparison.runs,
    attachments: readAttachments(db, userId, comparisonId),
  };
}

/** Opaque keyset cursor: the creation timestamp and id of the last seen row. */
export function encodeHistoryCursor(item: { createdAt: string; id: string }): string {
  return `${item.createdAt}|${item.id}`;
}

export function decodeHistoryCursor(before: string): { createdAt: string; id: string } | null {
  const separator = before.indexOf("|");
  if (separator <= 0) return null;
  const createdAt = before.slice(0, separator);
  const id = before.slice(separator + 1);
  if (!Number.isFinite(Date.parse(createdAt))) return null;
  if (!UUID_PATTERN.test(id)) return null;
  return { createdAt, id };
}

export function clampHistoryLimit(limit: number): number {
  if (!Number.isFinite(limit)) return HISTORY_PAGE_SIZE;
  return Math.min(HISTORY_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function isComparisonId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function readCreatedAt(db: DatabaseSync, userId: string, comparisonId: string): string | null {
  const row = db
    .prepare("SELECT created_at FROM comparisons WHERE id = ? AND user_id = ?")
    .get(comparisonId, userId) as Record<string, SQLOutputValue> | undefined;
  return typeof row?.created_at === "string" ? row.created_at : null;
}

/** Model ids per comparison, in run creation order, for the comparisons on the page. */
function readModelIds(db: DatabaseSync, comparisonIds: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (comparisonIds.length === 0) return result;
  const placeholders = comparisonIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`
      SELECT comparison_id, model_id
      FROM model_runs
      WHERE comparison_id IN (${placeholders})
      ORDER BY created_at, id
    `)
    .all(...comparisonIds) as unknown as Record<string, SQLOutputValue>[];
  for (const row of rows) {
    if (typeof row.comparison_id !== "string" || typeof row.model_id !== "string") continue;
    const ids = result.get(row.comparison_id) ?? [];
    if (!ids.includes(row.model_id)) ids.push(row.model_id);
    result.set(row.comparison_id, ids);
  }
  return result;
}

/**
 * Attachment names recorded with the comparison. The uploads pipeline persists
 * an `attachmentIds` array in the evidence payload and may persist a ready-made
 * `attachments` array; both shapes are accepted. Ids are resolved through the
 * owner's files rows so a payload can never expose another account's file name.
 */
function readAttachments(db: DatabaseSync, userId: string, comparisonId: string): HistoryAttachment[] {
  const row = db
    .prepare("SELECT payload FROM evidence_snapshots WHERE comparison_id = ? AND user_id = ? ORDER BY rowid LIMIT 1")
    .get(comparisonId, userId) as Record<string, SQLOutputValue> | undefined;
  const payload = parseJson(row?.payload);
  const fromPayload = payloadAttachments(payload?.attachments);
  if (fromPayload.length > 0) return fromPayload;
  return resolveAttachmentIds(db, userId, payloadAttachmentIds(payload?.attachmentIds));
}

function payloadAttachments(value: unknown): HistoryAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    // The uploads pipeline may persist PublicComparison-style entries ({id}) or
    // plan snapshots ({fileId}); both are accepted, everything else is ignored.
    const id = boundedId(record.id) ?? boundedId(record.fileId);
    if (!id) return [];
    const name = typeof record.name === "string" ? record.name : typeof record.originalName === "string" ? record.originalName : id;
    const detectedType = typeof record.detectedType === "string" ? record.detectedType : "";
    return [{ id, name, detectedType }];
  });
}

function payloadAttachmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const id = boundedId(item);
    return id ? [id] : [];
  });
}

function boundedId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

function resolveAttachmentIds(db: DatabaseSync, userId: string, ids: string[]): HistoryAttachment[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT id, original_name, detected_type FROM files WHERE user_id = ? AND id IN (${placeholders})`)
    .all(userId, ...ids) as unknown as Record<string, SQLOutputValue>[];
  const byId = new Map<string, HistoryAttachment>();
  for (const row of rows) {
    if (typeof row.id !== "string" || typeof row.original_name !== "string") continue;
    byId.set(row.id, {
      id: row.id,
      name: row.original_name,
      detectedType: typeof row.detected_type === "string" ? row.detected_type : "",
    });
  }
  return ids.map((id) => byId.get(id) ?? { id, name: id, detectedType: "" });
}

function parseJson(value: SQLOutputValue | undefined): Record<string, unknown> | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function numberValue(value: SQLOutputValue | undefined): number {
  return typeof value === "number" ? value : 0;
}
