import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { AttachmentSnapshot } from "@/domain/comparison/plan";
import type { DetectedKind } from "@/domain/files/content";
import type { ExtractionResult } from "@/server/files/extract";
import { PROCESSING_VERSION } from "@/server/files/extract";
import { imageMediaType, isImageKind, type StoredFile } from "@/server/files/storage";
import { insertFile } from "@/server/db/accounts";
import { immediateTransaction } from "@/server/db/transaction";

const CHUNK_CHARS = 4_000;
/** Cap applied when the extracted text is assembled into one shared prompt. */
export const MAX_PER_FILE_EVIDENCE_CHARS = 40_000;
export const MAX_EVIDENCE_CHARS = 120_000;
const EVIDENCE_TRUNCATION_MARKER = "\n…[اقتُطع الدليل]";
const CLIP_MARKER = "\n…[اقتُطع]";

export type StoredUpload = {
  id: string;
  name: string;
  detectedType: DetectedKind;
  byteSize: number;
  status: "stored";
  textExtracted: boolean;
};

export type OwnedFileRow = {
  id: string;
  originalName: string;
  storageKey: string;
  detectedType: string;
  byteSize: number;
};

export type AttachmentLoadResult =
  | { ok: true; evidenceText: string; attachments: AttachmentSnapshot[] }
  | { ok: false; message: string; code: string; status: number };

/**
 * Persists one stored upload: the owned files row, the extracted text as a
 * documents row (processing_version v1) plus ordered chunks, and the extraction
 * job report used later to explain failed/unsupported parts to the planner.
 */
export function persistUpload(db: DatabaseSync, input: {
  userId: string;
  stored: StoredFile;
  originalName: string;
  extraction: ExtractionResult;
}): StoredUpload {
  const name = input.originalName;
  return immediateTransaction(db, () => {
    insertFile(db, {
      id: input.stored.id,
      userId: input.userId,
      storageKey: input.stored.storageKey,
      originalName: name,
      detectedType: input.stored.detectedType,
      byteSize: input.stored.byteSize,
      sha256: input.stored.sha256,
      status: "stored",
    });
    const text = input.extraction.text;
    if (input.extraction.textExtracted && text.trim().length > 0) {
      const documentId = randomUUID();
      db.prepare(`
        INSERT INTO documents (id, file_id, user_id, processing_version)
        VALUES (?, ?, ?, ?)
      `).run(documentId, input.stored.id, input.userId, PROCESSING_VERSION);
      const insertChunk = db.prepare(`
        INSERT INTO chunks (id, document_id, user_id, ordinal, text, source)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      splitIntoChunks(text).forEach((chunk, ordinal) => {
        insertChunk.run(
          randomUUID(),
          documentId,
          input.userId,
          ordinal,
          chunk,
          JSON.stringify({
            kind: "file",
            fileId: input.stored.id,
            detectedType: input.stored.detectedType,
            ordinal,
          }),
        );
      });
    }
    db.prepare(`
      INSERT INTO extraction_jobs (id, file_id, user_id, status, progress, report, error_code)
      VALUES (?, ?, ?, ?, 100, ?, ?)
    `).run(
      randomUUID(),
      input.stored.id,
      input.userId,
      input.extraction.status,
      JSON.stringify({
        detectedType: input.stored.detectedType,
        byteSize: input.stored.byteSize,
        textExtracted: input.extraction.textExtracted,
        failedParts: input.extraction.failedParts,
        parts: input.extraction.parts,
        pages: input.extraction.pages,
      }),
      input.extraction.errorCode,
    );
    return {
      commit: true,
      value: {
        id: input.stored.id,
        name,
        detectedType: input.stored.detectedType,
        byteSize: input.stored.byteSize,
        status: "stored" as const,
        textExtracted: input.extraction.textExtracted,
      },
    };
  });
}

/**
 * Loads the owned attachment snapshots and the shared evidence text for one
 * comparison. Every id must belong to the session user (all-or-nothing), and
 * text is read from the persisted v1 rows only; there is no plan-time
 * re-extraction, so all models see identical bytes-to-text output.
 */
export function loadAttachmentSnapshots(
  db: DatabaseSync,
  userId: string,
  attachmentIds: readonly string[],
): AttachmentLoadResult {
  const ids = [...new Set(attachmentIds)];
  const attachments: AttachmentSnapshot[] = [];
  for (const fileId of ids) {
    const row = readOwnedFileRow(db, userId, fileId);
    if (!row) {
      return {
        ok: false,
        message: "أحد الملفات المرفقة غير موجود أو لا يخص الحساب.",
        code: "attachments",
        status: 422,
      };
    }
    const text = readDocumentText(db, userId, fileId);
    const failedParts = readFailedParts(db, userId, fileId, row.detectedType);
    attachments.push({
      fileId: row.id,
      name: row.originalName,
      detectedType: row.detectedType,
      text,
      image: isImageKind(row.detectedType)
        ? { mediaType: imageMediaType(row.detectedType) ?? "application/octet-stream", byteSize: row.byteSize }
        : null,
      failedParts,
    });
  }
  return { ok: true, evidenceText: buildEvidenceText(attachments), attachments };
}

/** Shared evidence format for every model in a comparison. Bounded twice: per file and in total. */
export function buildEvidenceText(attachments: readonly AttachmentSnapshot[]): string {
  const blocks: string[] = [];
  for (const attachment of attachments) {
    const header = `— ملف: ${attachment.name} (${attachment.detectedType})`;
    const text = attachment.text.trim();
    if (text) {
      blocks.push(`${header}\n${clip(text, MAX_PER_FILE_EVIDENCE_CHARS)}`);
      continue;
    }
    if (attachment.image) {
      blocks.push(`${header}\n[صورة مرفقة: يُرسل المحتوى كصورة، ولا نص مستخرج]`);
      continue;
    }
    const reasons = attachment.failedParts.map((part) => part.reason).join("، ");
    blocks.push(`${header}\n[لا يوجد نص مستخرج${reasons ? `: ${reasons}` : ""}]`);
  }
  const joined = blocks.join("\n\n");
  if (joined.length <= MAX_EVIDENCE_CHARS) return joined;
  return joined.slice(0, MAX_EVIDENCE_CHARS) + EVIDENCE_TRUNCATION_MARKER;
}

/** One file row owned by the caller; used by the executor before reading bytes. */
export function readOwnedFileRow(db: DatabaseSync, userId: string, fileId: string): OwnedFileRow | null {
  const row = db.prepare(`
    SELECT id, original_name, storage_key, detected_type, byte_size
    FROM files
    WHERE id = ? AND user_id = ?
  `).get(fileId, userId) as Record<string, SQLOutputValue> | undefined;
  if (
    !row
    || typeof row.id !== "string"
    || typeof row.original_name !== "string"
    || typeof row.storage_key !== "string"
    || typeof row.detected_type !== "string"
    || typeof row.byte_size !== "number"
  ) {
    return null;
  }
  return {
    id: row.id,
    originalName: row.original_name,
    storageKey: row.storage_key,
    detectedType: row.detected_type,
    byteSize: row.byte_size,
  };
}

function readDocumentText(db: DatabaseSync, userId: string, fileId: string): string {
  const document = db.prepare(`
    SELECT id FROM documents
    WHERE file_id = ? AND user_id = ? AND processing_version = ?
    ORDER BY rowid LIMIT 1
  `).get(fileId, userId, PROCESSING_VERSION) as Record<string, SQLOutputValue> | undefined;
  if (!document || typeof document.id !== "string") return "";
  const rows = db.prepare(`
    SELECT text FROM chunks WHERE document_id = ? AND user_id = ? ORDER BY ordinal
  `).all(document.id, userId) as unknown as Record<string, SQLOutputValue>[];
  return rows
    .map((row) => (typeof row.text === "string" ? row.text : ""))
    .join("\n");
}

function readFailedParts(
  db: DatabaseSync,
  userId: string,
  fileId: string,
  detectedType: string,
): { label: string; reason: string }[] {
  const row = db.prepare(`
    SELECT report, status FROM extraction_jobs
    WHERE file_id = ? AND user_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(fileId, userId) as Record<string, SQLOutputValue> | undefined;
  const report = parseJson(row?.report);
  if (report && Array.isArray(report.failedParts)) {
    return report.failedParts.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const record = part as Record<string, unknown>;
      if (typeof record.label !== "string" || typeof record.reason !== "string") return [];
      return [{ label: record.label, reason: record.reason }];
    });
  }
  if (row?.status === "failed") return [{ label: detectedType, reason: "extract_failed" }];
  return [];
}

function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_CHARS);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline > start + CHUNK_CHARS / 2) end = newline + 1;
    }
    const chunk = text.slice(start, end);
    if (chunk.length > 0) chunks.push(chunk);
    start = end;
  }
  return chunks;
}

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + CLIP_MARKER : text;
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
