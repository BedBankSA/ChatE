import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { classifyOfficeZip, detectContent, type DetectedKind } from "@/domain/files/content";
import { AppError } from "@/domain/errors";

export const DEFAULT_STORAGE_DIR = "storage";
export const DEFAULT_MAX_FILE_BYTES = 26_214_400; // 25 MiB
export const MAX_FILES_PER_REQUEST = 5;
export const MAX_TOTAL_UPLOAD_BYTES = 52_428_800; // 50 MiB

export type StorageEnv = Record<string, string | undefined>;

export type StoredFile = {
  id: string;
  storageKey: string;
  byteSize: number;
  sha256: string;
  detectedType: DetectedKind;
};

const IMAGE_MEDIA: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Largest upload size the server accepts for one file, from MAX_FILE_BYTES. */
export function maxFileBytes(env: StorageEnv = process.env): number {
  const raw = env.MAX_FILE_BYTES?.trim() ?? "";
  if (!raw) return DEFAULT_MAX_FILE_BYTES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_MAX_FILE_BYTES;
  return Math.min(value, 2_000_000_000);
}

/**
 * Private storage root. Relative STORAGE_DIR values resolve from the project
 * root (same convention as SQLITE_PATH). The browser never receives a path or
 * a public URL for this directory; reads always go through an owned file row.
 */
export function storageRoot(env: StorageEnv = process.env, cwd = process.cwd()): string {
  const raw = env.STORAGE_DIR?.trim() || DEFAULT_STORAGE_DIR;
  if (raw.includes("\0")) throw new AppError("مسار التخزين غير صالح.", "FILE_STORAGE", 500);
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

/**
 * Display-only name. The stored path is always a server-generated UUID, so a
 * client name can never reach the filesystem; we still strip separators and
 * control characters to keep the DB row and UI clean.
 */
export function sanitizeDisplayName(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "ملف";
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

/** One path segment; UUIDs and internal ids match. Nothing containing "." or separators does. */
export function isSafeStorageSegment(segment: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(segment);
}

export function imageMediaType(detectedType: string): string | null {
  return IMAGE_MEDIA[detectedType] ?? null;
}

export function isImageKind(detectedType: string): boolean {
  return imageMediaType(detectedType) != null;
}

/**
 * Type detection is content based (src/domain/files/content.ts). A ZIP container
 * is inspected for the OOXML markers so a DOCX/XLSX is not stored as a generic
 * ZIP; the entry listing is read from the central directory only, no extraction.
 */
export async function detectStoredType(bytes: Uint8Array, claimedName: string): Promise<DetectedKind> {
  const detected = detectContent(bytes, claimedName);
  if (detected !== "zip") return detected;
  try {
    const zip = await JSZip.loadAsync(bytes);
    return classifyOfficeZip(Object.keys(zip.files));
  } catch {
    return "zip";
  }
}

/**
 * Writes bytes once, privately and atomically: `<STORAGE_DIR>/<userId>/<fileId>`
 * (0700 directory / 0600 file on POSIX), temp file fsynced then renamed into
 * place. The id is server generated, so the client name never influences the
 * path. Throws AppError("file_size") before writing when the limit is exceeded.
 */
export async function storeFile(input: {
  userId: string;
  bytes: Uint8Array;
  originalName: string;
  detectedType?: DetectedKind;
  env?: StorageEnv;
  cwd?: string;
}): Promise<StoredFile> {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  if (!isSafeStorageSegment(input.userId)) {
    throw new AppError("مسار التخزين غير صالح.", "FILE_STORAGE", 500);
  }
  const bytes = Buffer.from(input.bytes);
  if (bytes.byteLength > maxFileBytes(env)) {
    throw new AppError("حجم أحد الملفات يتجاوز الحد المسموح.", "file_size", 413);
  }
  const detectedType = input.detectedType ?? (await detectStoredType(bytes, input.originalName));
  const id = randomUUID();
  const storageKey = `${input.userId}/${id}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const root = storageRoot(env, cwd);
  const directory = path.join(root, input.userId);
  const target = path.join(directory, id);
  if (!insideRoot(root, target)) {
    throw new AppError("مسار التخزين غير صالح.", "FILE_STORAGE", 500);
  }
  const temp = `${target}.tmp`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  let handle: number | null = null;
  try {
    handle = openSync(temp, "wx", 0o600);
    writeSync(handle, bytes);
    fsyncSync(handle);
    closeSync(handle);
    handle = null;
    chmodSync(temp, 0o600);
    renameSync(temp, target);
  } catch (error) {
    if (handle != null) {
      try {
        closeSync(handle);
      } catch {
        // Already closed or unusable.
      }
    }
    try {
      rmSync(temp, { force: true });
    } catch {
      // A leftover temp file is harmless; the target was never published.
    }
    if (error instanceof AppError) throw error;
    throw new AppError("تعذر حفظ الملف على القرص.", "FILE_STORAGE", 500);
  }
  return { id, storageKey, byteSize: bytes.byteLength, sha256, detectedType };
}

/**
 * Reads bytes for an owned file row. Only a two-segment `<userId>/<fileId>` key
 * belonging to the caller is accepted, and the resolved path must stay inside
 * the storage root; anything else returns null (no existence oracle).
 */
export function readStoredBytes(input: {
  userId: string;
  storageKey: string;
  env?: StorageEnv;
  cwd?: string;
}): Buffer | null {
  const segments = input.storageKey.split("/");
  if (segments.length !== 2) return null;
  const [owner, fileId] = segments;
  if (!owner || !fileId || owner !== input.userId) return null;
  if (!isSafeStorageSegment(owner) || !isSafeStorageSegment(fileId)) return null;
  const root = storageRoot(input.env ?? process.env, input.cwd ?? process.cwd());
  const target = path.join(root, owner, fileId);
  if (!insideRoot(root, target)) return null;
  try {
    return readFileSync(target);
  } catch {
    return null;
  }
}

function insideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
