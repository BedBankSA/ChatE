import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "@/domain/auth/session";
import { CHAT_SHORTCUT_MODEL, COMPARISON_MODEL_IDS } from "@/domain/workspace-start";
import { insertFile, insertUser, migrateDatabase, openDatabase } from "@/server/db/index";
import { MAX_TOTAL_UPLOAD_BYTES } from "@/server/files/storage";

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }));

vi.mock("@/server/db/runtime", () => ({
  getDatabase: () => {
    if (!state.db) throw new Error("test database is not ready");
    return state.db;
  },
}));

// The route under test only persists planned runs; provider execution is a
// separate module and is stubbed so no background job touches the test DB.
vi.mock("@/server/comparisons/execute", () => ({ scheduleComparison: vi.fn() }));

const SECRET = "uploads-route-session-secret";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MIGRATIONS = path.join(process.cwd(), "migrations");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const GOOGLE_SUB = "google-sub-uploads";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type UploadFile = {
  id: string;
  name: string;
  detectedType: string;
  byteSize: number;
  status: string;
  textExtracted: boolean;
};

type JsonBody<T> = { ok?: boolean; data?: T | null; error?: { message?: string; code?: string } | null };

let storageDir = "";
let tokenSeq = 0;

function database(): DatabaseSync {
  if (!state.db) throw new Error("test database is not ready");
  return state.db;
}

function storedFileCount(): number {
  try {
    return readdirSync(storageDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .length;
  } catch {
    return 0;
  }
}

function sessionCookie(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signSession(
    { userId: USER_ID, googleSub: GOOGLE_SUB, exp: nowSec + 600, csrf: "csrf-uploads", iat: nowSec },
    SECRET,
  );
  return "chate_session=" + token;
}

function nextToken(action: "upload" | "comparison"): string {
  tokenSeq += 1;
  return `${action}-${tokenSeq}`;
}

function uploadFile(name: string, bytes: Uint8Array | string): File {
  const body = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return new File([body as BlobPart], name);
}

function uploadRequest(files: File[], options: { token?: string; cookie?: string | null } = {}): Request {
  const form = new FormData();
  if (options.token) form.set("cf-turnstile-response", options.token);
  for (const file of files) form.append("files", file);
  const headers: Record<string, string> = { "x-forwarded-host": "localhost" };
  const cookie = "cookie" in options ? options.cookie : sessionCookie();
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost:3211/api/uploads", { method: "POST", headers, body: form });
}

async function postUpload(files: File[], options: { token?: string; cookie?: string | null } = {}) {
  const request = uploadRequest(files, options);
  const { POST } = await import("@/app/api/uploads/route");
  const response = await POST(request);
  const body = (await response.json()) as JsonBody<{ files?: UploadFile[] }>;
  return { status: response.status, body, request };
}

/**
 * Same multipart bytes as uploadRequest() but delivered as a byte-backed body
 * with the declared length removed, so the route must enforce its own cap while
 * reading request.body.
 */
async function chunkedUploadRequest(
  files: File[],
  options: { token?: string; cookie?: string | null } = {},
): Promise<Request> {
  const source = uploadRequest(files, options);
  const bytes = new Uint8Array(await source.arrayBuffer());
  const headers = new Headers(source.headers);
  const request = new Request("http://localhost:3211/api/uploads", { method: "POST", headers, body: bytes });
  request.headers.delete("content-length");
  return request;
}

/** A body larger than any accepted upload, with no declared Content-Length. */
function oversizedUploadRequest(totalBytes: number): Request {
  const headers = new Headers({
    "x-forwarded-host": "localhost",
    cookie: sessionCookie(),
    "content-type": "multipart/form-data; boundary=chate-oversize",
  });
  const request = new Request("http://localhost:3211/api/uploads", {
    method: "POST",
    headers,
    body: Buffer.alloc(totalBytes),
  });
  request.headers.delete("content-length");
  return request;
}

function comparisonRequest(payload: Record<string, unknown>, cookie: string = sessionCookie()): Request {
  return new Request("http://localhost:3211/api/comparisons", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-host": "localhost",
      cookie,
    },
    body: JSON.stringify(payload),
  });
}

async function postComparison(payload: Record<string, unknown>, cookie?: string) {
  const { POST } = await import("@/app/api/comparisons/route");
  const response = await POST(comparisonRequest(payload, cookie));
  const body = (await response.json()) as JsonBody<{
    id?: string;
    attachments?: { id: string; name: string; detectedType: string }[];
  }>;
  return { status: response.status, body };
}

async function makePdf(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 200]);
  page.drawText(text, { x: 20, y: 150, size: 12, font });
  return new Uint8Array(await pdf.save());
}

function seedAccount(userId: string, googleSub: string): void {
  insertUser(database(), { id: userId, googleSub, email: `${googleSub}@example.com`, name: "مستخدم اختبار" });
  // Migration 009 enforces one verified account per number, so each fixture
  // account owns its own number (the previous shared value would now abort).
  const phone = userId === USER_ID ? "+966501234567" : "+966505555555";
  database()
    .prepare("INSERT INTO profiles (user_id, phone_e164, phone_verified_at) VALUES (?, ?, ?)")
    .run(userId, phone, new Date().toISOString());
}

beforeEach(() => {
  storageDir = mkdtempSync(path.join(tmpdir(), "chate-uploads-route-"));
  state.db = openDatabase(":memory:");
  migrateDatabase(database(), MIGRATIONS);
  seedAccount(USER_ID, GOOGLE_SUB);
  seedAccount(OTHER_USER_ID, "google-sub-uploads-other");
  tokenSeq = 0;
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
  vi.stubEnv("TURNSTILE_EXPECTED_HOSTNAMES", "localhost");
  vi.stubEnv("STORAGE_DIR", storageDir);
  vi.stubEnv("APP_URL", "http://localhost:3211");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("MAX_FILE_BYTES", "");
  vi.stubEnv("OTP_PROVIDER", "");
  vi.stubEnv("OTP_HTTP_URL", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url !== SITEVERIFY) throw new Error("unexpected network call: " + url);
      const token = new URLSearchParams(String(init?.body ?? "")).get("response") ?? "";
      const action = token.startsWith("comparison-") ? "comparison" : "upload";
      return Response.json({
        success: true,
        action,
        hostname: "localhost",
        challenge_ts: new Date().toISOString(),
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (state.db && state.db.isOpen) state.db.close();
  state.db = null;
  rmSync(storageDir, { recursive: true, force: true });
});

describe("POST /api/uploads", () => {
  it("rejects anonymous callers before reading or storing bytes", async () => {
    const result = await postUpload([uploadFile("notes.txt", "بيانات سرية")], {
      cookie: null,
      token: nextToken("upload"),
    });
    expect(result.status).toBe(401);
    expect(result.body.error?.code).toBe("anonymous");
    expect(storedFileCount()).toBe(0);
  });

  it("rejects a missing Turnstile token and stores nothing", async () => {
    const result = await postUpload([uploadFile("notes.txt", "بيانات")]);
    expect(result.status).toBe(403);
    expect(storedFileCount()).toBe(0);
  });

  it("rejects a replayed Turnstile token", async () => {
    const token = "upload-static-replay";
    const first = await postUpload([uploadFile("a.txt", "أول")], { token });
    expect(first.status).toBe(200);
    const second = await postUpload([uploadFile("b.txt", "ثاني")], { token });
    expect(second.status).toBe(403);
    expect(second.body.error?.code).toBe("reused");
    expect(storedFileCount()).toBe(1);
  });

  it("stores real bytes privately and returns the contract JSON shape", async () => {
    const bytes = Buffer.from("محتوى نصي خاص للاختبار", "utf8");
    const { status, body } = await postUpload([uploadFile("notes.txt", bytes)], { token: nextToken("upload") });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.error).toBeNull();
    const files = body.data?.files ?? [];
    expect(files).toHaveLength(1);
    const saved = files[0];
    if (!saved) return;
    expect(saved).toMatchObject({ name: "notes.txt", detectedType: "text", byteSize: bytes.byteLength, status: "stored", textExtracted: true });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(body)).not.toContain(storageDir);

    const disk = path.join(storageDir, USER_ID, saved.id);
    expect(readFileSync(disk).equals(bytes)).toBe(true);
    const row = database()
      .prepare("SELECT storage_key, sha256, detected_type, byte_size, status FROM files WHERE id = ?")
      .get(saved.id) as { storage_key: string; sha256: string; detected_type: string; byte_size: number; status: string };
    expect(row.storage_key).toBe(`${USER_ID}/${saved.id}`);
    expect(row.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(row.detected_type).toBe("text");
    expect(row.byte_size).toBe(bytes.byteLength);
    expect(row.status).toBe("stored");
    const chunks = database()
      .prepare("SELECT c.text FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.file_id = ? ORDER BY c.ordinal")
      .all(saved.id) as { text: string }[];
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("محتوى نصي خاص");
  });

  it("detects the type from bytes rather than the extension", async () => {
    const { status, body } = await postUpload([uploadFile("notes.txt", PNG_BYTES)], { token: nextToken("upload") });
    expect(status).toBe(200);
    expect(body.data?.files?.[0]).toMatchObject({ detectedType: "png", textExtracted: false });
  });

  it("extracts a real PDF text layer through the route", async () => {
    const { status, body } = await postUpload([uploadFile("evidence.pdf", await makePdf("route pdf marker"))], {
      token: nextToken("upload"),
    });
    expect(status).toBe(200);
    expect(body.data?.files?.[0]).toMatchObject({ detectedType: "pdf", textExtracted: true });
    const fileId = body.data?.files?.[0]?.id ?? "";
    const joined = database()
      .prepare("SELECT c.text FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.file_id = ?")
      .all(fileId) as { text: string }[];
    expect(joined.map((chunk) => chunk.text).join("\n")).toContain("route pdf marker");
  });

  it("rejects per-file oversize without storing anything", async () => {
    vi.stubEnv("MAX_FILE_BYTES", "1024");
    const oversized = await postUpload([uploadFile("big.txt", Buffer.alloc(2048, 0x61))], { token: nextToken("upload") });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error?.code).toBe("file_size");
    expect(storedFileCount()).toBe(0);
  });

  it("rejects total oversize without storing anything", async () => {
    vi.stubEnv("MAX_FILE_BYTES", String(MAX_TOTAL_UPLOAD_BYTES));
    const request = await chunkedUploadRequest(
      [uploadFile("a.txt", Buffer.alloc(26 * 1024 * 1024, 0x61)), uploadFile("b.txt", Buffer.alloc(26 * 1024 * 1024, 0x61))],
      { token: nextToken("upload") },
    );
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(request);
    const body = (await response.json()) as JsonBody<{ files?: UploadFile[] }>;
    expect(response.status).toBe(413);
    expect(body.error?.code).toBe("file_size");
    expect(storedFileCount()).toBe(0);
  });

  it("rejects an oversized chunked body before parsing or storing anything", async () => {
    const request = oversizedUploadRequest(MAX_TOTAL_UPLOAD_BYTES + 2 * 1024 * 1024);
    expect(request.headers.get("content-length")).toBeNull();
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(request);
    const body = (await response.json()) as JsonBody<{ files?: UploadFile[] }>;
    expect(response.status).toBe(413);
    expect(body.error?.code).toBe("file_size");
    expect(storedFileCount()).toBe(0);
  });

  it("accepts a chunked multipart upload that has no Content-Length", async () => {
    const request = await chunkedUploadRequest([uploadFile("chunked.txt", "محتوى نصي مقسم")], {
      token: nextToken("upload"),
    });
    expect(request.headers.get("content-length")).toBeNull();
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(request);
    const body = (await response.json()) as JsonBody<{ files?: UploadFile[] }>;
    expect(response.status).toBe(200);
    expect(body.data?.files?.[0]).toMatchObject({ name: "chunked.txt", status: "stored", textExtracted: true });
    expect(storedFileCount()).toBe(1);
  });

  it("rejects more than five files", async () => {
    const files = Array.from({ length: 6 }, (_, index) => uploadFile(`f${index}.txt`, "x"));
    const { status, body } = await postUpload(files, { token: nextToken("upload") });
    expect(status).toBe(400);
    expect(body.error?.code).toBe("files");
    expect(storedFileCount()).toBe(0);
  });
});

describe("POST /api/comparisons with attachments", () => {
  const base = {
    question: "حلّل الملف المرفق",
    evidenceMode: "native",
    answerModelIds: [CHAT_SHORTCUT_MODEL],
  };

  it("carries attachment evidence into planned requests and the stored snapshot", async () => {
    const evidence = "قيمة الدليل الفريدة 42";
    const upload = await postUpload([uploadFile("evidence.txt", evidence)], { token: nextToken("upload") });
    const fileId = upload.body.data?.files?.[0]?.id ?? "";
    expect(fileId).not.toBe("");

    const { status, body } = await postComparison({
      ...base,
      idempotencyKey: randomUUID(),
      attachmentIds: [fileId],
      "cf-turnstile-response": nextToken("comparison"),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data?.attachments).toEqual([{ id: fileId, name: "evidence.txt", detectedType: "text" }]);

    const snapshot = database()
      .prepare("SELECT payload FROM evidence_snapshots WHERE comparison_id = ?")
      .get(body.data?.id ?? "") as { payload: string };
    const payload = JSON.parse(snapshot.payload) as { attachmentIds?: string[]; evidenceText?: string };
    expect(payload.attachmentIds).toEqual([fileId]);
    expect(payload.evidenceText).toContain(evidence);

    const runs = database()
      .prepare("SELECT model_id, requested_settings FROM model_runs WHERE comparison_id = ?")
      .all(body.data?.id ?? "") as { model_id: string; requested_settings: string }[];
    expect(runs.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(runs);
    expect(serialized).toContain(evidence);
  });

  it("rejects a foreign file id with 422 and creates no comparison", async () => {
    const foreignId = randomUUID();
    insertFile(database(), {
      id: foreignId,
      userId: OTHER_USER_ID,
      storageKey: `${OTHER_USER_ID}/${foreignId}`,
      originalName: "secret.txt",
      detectedType: "text",
      byteSize: 10,
      sha256: "0".repeat(64),
      status: "stored",
    });
    const { status, body } = await postComparison({
      ...base,
      idempotencyKey: randomUUID(),
      attachmentIds: [foreignId],
      "cf-turnstile-response": nextToken("comparison"),
    });
    expect(status).toBe(422);
    expect(body.error?.code).toBe("attachments");
    const count = database().prepare("SELECT COUNT(*) AS n FROM comparisons").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("rejects traversal-shaped attachment ids before touching the store", async () => {
    const { status, body } = await postComparison({
      ...base,
      idempotencyKey: randomUUID(),
      attachmentIds: ["../../etc/passwd"],
      "cf-turnstile-response": nextToken("comparison"),
    });
    expect(status).toBe(400);
    expect(body.error?.code).toBe("attachments");
    const count = database().prepare("SELECT COUNT(*) AS n FROM comparisons").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("keeps the empty-attachments payload for comparisons without files", async () => {
    const { status, body } = await postComparison({
      ...base,
      answerModelIds: [...COMPARISON_MODEL_IDS],
      idempotencyKey: randomUUID(),
      "cf-turnstile-response": nextToken("comparison"),
    });
    expect(status).toBe(200);
    const snapshot = database()
      .prepare("SELECT payload FROM evidence_snapshots WHERE comparison_id = ?")
      .get(body.data?.id ?? "") as { payload: string };
    const payload = JSON.parse(snapshot.payload) as { attachmentIds?: string[]; evidenceText?: string };
    expect(payload.attachmentIds).toEqual([]);
    expect(payload.evidenceText).toBe("");
  });
});
