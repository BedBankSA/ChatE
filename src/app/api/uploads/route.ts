import { publicError } from "@/domain/errors";
import { getDatabase } from "@/server/db/runtime";
import { jsonError, jsonOk } from "@/server/http";
import { gateTurnstile } from "@/server/guard";
import { readComparisonSession } from "@/server/google-session";
import { extractTextForFile } from "@/server/files/extract";
import { persistUpload, type StoredUpload } from "@/server/files/repository";
import {
  MAX_FILES_PER_REQUEST,
  MAX_TOTAL_UPLOAD_BYTES,
  detectStoredType,
  maxFileBytes,
  sanitizeDisplayName,
  storeFile,
} from "@/server/files/storage";

const ANONYMOUS_MESSAGE = "يلزم تسجيل الدخول قبل رفع الملفات";
const FORM_MESSAGE = "تعذر قراءة بيانات الرفع.";
const EMPTY_MESSAGE = "اختر ملفًا واحدًا على الأقل.";
const COUNT_MESSAGE = "أقصى عدد للملفات في الطلب الواحد خمسة.";
const FILE_SIZE_MESSAGE = "حجم أحد الملفات يتجاوز الحد المسموح.";
const TOTAL_SIZE_MESSAGE = "الحجم الكلي للملفات يتجاوز الحد المسموح.";
const STORE_MESSAGE = "تعذر فتح قاعدة الملفات.";

/** Multipart framing (boundaries, part headers) on top of the byte cap. */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

/**
 * POST /api/uploads (multipart/form-data)
 *
 * Order is part of the security contract: the session is checked first, the
 * Turnstile token is gated on the `upload` action second, and only then are the
 * bytes read. Files are stored privately under STORAGE_DIR/<userId>/<fileId>
 * with a server-generated id (the client name is display-only), typed from
 * content, hashed, and persisted with its extracted text for comparison reuse.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await readComparisonSession(request);
  if (!session) return jsonError(ANONYMOUS_MESSAGE, "anonymous", 401);

  const declared = declaredLength(request);
  if (declared != null && declared > MAX_TOTAL_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES) {
    return jsonError(TOTAL_SIZE_MESSAGE, "file_size", 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(FORM_MESSAGE, "upload_form", 400);
  }
  const token = form.get("cf-turnstile-response");
  const blocked = await gateTurnstile(request, { "cf-turnstile-response": token }, "upload");
  if (blocked) return blocked;

  const files = form.getAll("files").filter(isUploadFile);
  if (files.length === 0) return jsonError(EMPTY_MESSAGE, "files", 400);
  if (files.length > MAX_FILES_PER_REQUEST) return jsonError(COUNT_MESSAGE, "files", 400);

  const fileLimit = maxFileBytes(process.env);
  let declaredTotal = 0;
  for (const file of files) {
    if (file.size > fileLimit) return jsonError(FILE_SIZE_MESSAGE, "file_size", 413);
    declaredTotal += file.size;
  }
  if (declaredTotal > MAX_TOTAL_UPLOAD_BYTES) return jsonError(TOTAL_SIZE_MESSAGE, "file_size", 413);

  let db;
  try {
    db = getDatabase();
  } catch {
    return jsonError(STORE_MESSAGE, "store", 500);
  }

  const stored: StoredUpload[] = [];
  let actualTotal = 0;
  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return jsonError(FILE_SIZE_MESSAGE, "file_size", 413);
    }
    if (bytes.byteLength > fileLimit) return jsonError(FILE_SIZE_MESSAGE, "file_size", 413);
    actualTotal += bytes.byteLength;
    if (actualTotal > MAX_TOTAL_UPLOAD_BYTES) return jsonError(TOTAL_SIZE_MESSAGE, "file_size", 413);
    try {
      const detectedType = await detectStoredType(bytes, file.name);
      const extraction = await extractTextForFile({ bytes, detectedType, name: file.name });
      const saved = await storeFile({
        userId: session.userId,
        bytes,
        originalName: file.name,
        detectedType,
      });
      stored.push(persistUpload(db, {
        userId: session.userId,
        stored: saved,
        originalName: sanitizeDisplayName(file.name),
        extraction,
      }));
    } catch (error) {
      const pub = publicError(error);
      return jsonError(pub.message, pub.code, pub.status);
    }
  }

  const response = jsonOk({ files: stored });
  response.headers.set("cache-control", "no-store");
  return response;
}

function declaredLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw == null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Runtime check: FormData entries are attacker-controlled and typed `unknown` at the edge. */
function isUploadFile(value: unknown): value is File {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { name?: unknown; arrayBuffer?: unknown; size?: unknown };
  return typeof candidate.name === "string" && typeof candidate.arrayBuffer === "function" && typeof candidate.size === "number";
}
