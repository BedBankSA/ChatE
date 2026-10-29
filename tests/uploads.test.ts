import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseComparisonBody } from "@/domain/comparison/input";
import { planRuns, type AttachmentSnapshot } from "@/domain/comparison/plan";
import type { DatabaseSync } from "node:sqlite";
import { detectContent } from "@/domain/files/content";
import { createComparison, readComparison } from "@/server/comparisons/store";
import { hydrateImageRefs } from "@/server/comparisons/execute";
import { insertFile, insertUser, migrateDatabase, openDatabase } from "@/server/db/index";
import {
  MAX_EVIDENCE_CHARS,
  loadAttachmentSnapshots,
  persistUpload,
} from "@/server/files/repository";
import {
  MAX_STORED_TEXT_CHARS,
  extractTextForFile,
} from "@/server/files/extract";
import {
  DEFAULT_MAX_FILE_BYTES,
  MAX_FILES_PER_REQUEST,
  MAX_TOTAL_UPLOAD_BYTES,
  imageMediaType,
  maxFileBytes,
  readStoredBytes,
  sanitizeDisplayName,
  storeFile,
  storageRoot,
} from "@/server/files/storage";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const MIGRATIONS = path.join(process.cwd(), "migrations");

// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let storageDir = "";
let db: DatabaseSync;

function env(): Record<string, string | undefined> {
  return { STORAGE_DIR: storageDir };
}

async function makePdf(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 200]);
  page.drawText(text, { x: 20, y: 150, size: 12, font });
  return new Uint8Array(await pdf.save());
}

async function makeDocx(text: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' +
      text +
      "</w:t></w:r></w:p></w:body></w:document>",
  );
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

function storedPath(userId: string, fileId: string): string {
  return path.join(storageDir, userId, fileId);
}

async function uploadFile(input: {
  userId?: string;
  bytes: Uint8Array;
  name: string;
  text?: string;
  detectedType?: Awaited<ReturnType<typeof detectContent>>;
}) {
  const userId = input.userId ?? USER_ID;
  const stored = await storeFile({
    userId,
    bytes: input.bytes,
    originalName: input.name,
    detectedType: input.detectedType,
    env: env(),
  });
  const extraction = await extractTextForFile({
    bytes: input.bytes,
    detectedType: stored.detectedType,
    name: input.name,
  });
  if (input.text != null) {
    extraction.status = "completed";
    extraction.text = input.text;
    extraction.textExtracted = true;
    extraction.failedParts = [];
  }
  const saved = persistUpload(db, {
    userId,
    stored,
    originalName: sanitizeDisplayName(input.name),
    extraction,
  });
  return { stored, extraction, saved };
}

function seedUsers(): void {
  for (const [id, sub] of [
    [USER_ID, "google-uploads-a"],
    [OTHER_USER_ID, "google-uploads-b"],
  ] as const) {
    insertUser(db, { id, googleSub: sub, email: `${sub}@example.com`, name: "مستخدم اختبار" });
  }
}

beforeEach(() => {
  storageDir = mkdtempSync(path.join(tmpdir(), "chate-uploads-"));
  db = openDatabase(":memory:");
  migrateDatabase(db, MIGRATIONS);
  seedUsers();
});

afterEach(() => {
  if (db?.isOpen) db.close();
  rmSync(storageDir, { recursive: true, force: true });
});

describe("upload limits and display names", () => {
  it("reads per-file limits from the environment with a safe default", () => {
    expect(MAX_FILES_PER_REQUEST).toBe(5);
    expect(MAX_TOTAL_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
    expect(maxFileBytes({})).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(DEFAULT_MAX_FILE_BYTES).toBe(26_214_400);
    expect(maxFileBytes({ MAX_FILE_BYTES: "1024" })).toBe(1024);
    expect(maxFileBytes({ MAX_FILE_BYTES: "not-a-number" })).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(maxFileBytes({ MAX_FILE_BYTES: "-5" })).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(maxFileBytes({ MAX_FILE_BYTES: "0" })).toBe(DEFAULT_MAX_FILE_BYTES);
  });

  it("sanitizes client file names: no path separators, control characters, or long values", () => {
    expect(sanitizeDisplayName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeDisplayName("C:\\\\Windows\\\\evil.txt")).toBe("evil.txt");
    expect(sanitizeDisplayName("ملف سري.txt")).toBe("ملف سري.txt");
    expect(sanitizeDisplayName("bad\u0000name\u001f.txt")).toBe("badname.txt");
    expect(sanitizeDisplayName("")).toBe("ملف");
    expect(sanitizeDisplayName(null)).toBe("ملف");
    expect(sanitizeDisplayName("x".repeat(500)).length).toBeLessThanOrEqual(200);
  });

  it("resolves the storage root from STORAGE_DIR and never escapes it", async () => {
    expect(storageRoot(env(), process.cwd())).toBe(path.resolve(storageDir));
    expect(() =>
      storageRoot({ STORAGE_DIR: "bad\u0000dir" }, process.cwd()),
    ).toThrow();
    await expect(
      storeFile({
        userId: "../../escape",
        bytes: Buffer.from("x"),
        originalName: "x.txt",
        env: env(),
      }),
    ).rejects.toThrow();
    await expect(
      storeFile({
        userId: USER_ID,
        bytes: Buffer.from("xx"),
        originalName: "x.txt",
        env: { STORAGE_DIR: storageDir, MAX_FILE_BYTES: "1" },
      }),
    ).rejects.toThrow();
  });
});

describe("private byte storage", () => {
  it("stores bytes atomically under <root>/<userId>/<fileId> with a sha256 and detected type", async () => {
    const bytes = Buffer.from("محتوى الملف النصي للاختبار", "utf8");
    const stored = await storeFile({ userId: USER_ID, bytes, originalName: "notes.txt", env: env() });
    expect(stored.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(stored.storageKey).toBe(`${USER_ID}/${stored.id}`);
    expect(stored.byteSize).toBe(bytes.byteLength);
    expect(stored.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(stored.detectedType).toBe("text");
    const target = storedPath(USER_ID, stored.id);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target).equals(bytes)).toBe(true);
    expect(readdirSync(path.join(storageDir, USER_ID)).some((name) => name.endsWith(".tmp"))).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(storageDir, USER_ID)).mode & 0o777).toBe(0o700);
    }
  });

  it("detects the type from bytes, not the claimed name", async () => {
    const plain = await storeFile({
      userId: USER_ID,
      bytes: Buffer.from("not a pdf at all"),
      originalName: "report.pdf",
      env: env(),
    });
    expect(plain.detectedType).toBe("text");
    const png = await storeFile({ userId: USER_ID, bytes: PNG_BYTES, originalName: "image.txt", env: env() });
    expect(png.detectedType).toBe("png");
    const docx = await storeFile({ userId: USER_ID, bytes: await makeDocx("نص"), originalName: "doc.zip", env: env() });
    expect(docx.detectedType).toBe("docx");
    const xlsxZip = new JSZip();
    xlsxZip.file("xl/workbook.xml", "<workbook/>");
    const xlsx = await storeFile({
      userId: USER_ID,
      bytes: new Uint8Array(await xlsxZip.generateAsync({ type: "uint8array" })),
      originalName: "sheet.zip",
      env: env(),
    });
    expect(xlsx.detectedType).toBe("xlsx");
  });

  it("reads only owned, safe storage keys", async () => {
    const stored = await storeFile({
      userId: USER_ID,
      bytes: Buffer.from("hello"),
      originalName: "a.txt",
      env: env(),
    });
    expect(readStoredBytes({ userId: USER_ID, storageKey: stored.storageKey, env: env() })?.toString("utf8")).toBe("hello");
    expect(readStoredBytes({ userId: USER_ID, storageKey: "../evil", env: env() })).toBeNull();
    expect(readStoredBytes({ userId: OTHER_USER_ID, storageKey: stored.storageKey, env: env() })).toBeNull();
    expect(readStoredBytes({ userId: USER_ID, storageKey: `${USER_ID}/missing`, env: env() })).toBeNull();
    expect(imageMediaType("png")).toBe("image/png");
    expect(imageMediaType("jpeg")).toBe("image/jpeg");
    expect(imageMediaType("text")).toBeNull();
  });
});

describe("text extraction", () => {
  it("extracts plain text and recognized text formats", async () => {
    const text = await extractTextForFile({
      bytes: Buffer.from("سطر عربي في ملف نصي\nسطر ثانٍ"),
      detectedType: "text",
      name: "notes.txt",
    });
    expect(text.status).toBe("completed");
    expect(text.textExtracted).toBe(true);
    expect(text.text).toContain("سطر عربي");
    expect(text.failedParts).toEqual([]);

    const csv = await extractTextForFile({
      bytes: Buffer.from("name,value\nنموذج,1"),
      detectedType: "csv",
      name: "table.csv",
    });
    expect(csv.textExtracted).toBe(true);
    expect(csv.text).toContain("نموذج");

    const detected = detectContent(Buffer.from('{"ok":true}'), "data.txt");
    expect(detected).toBe("json");
  });

  it("extracts a real PDF text layer", async () => {
    const bytes = await makePdf("ChatE pdf evidence marker");
    const extraction = await extractTextForFile({ bytes, detectedType: "pdf", name: "evidence.pdf" });
    expect(extraction.status).toBe("completed");
    expect(extraction.textExtracted).toBe(true);
    expect(extraction.text).toContain("ChatE pdf evidence marker");
    expect(extraction.pages).toBe(1);
  });

  it("extracts a real DOCX document", async () => {
    const bytes = await makeDocx("دليل مستند وورد للاختبار");
    const extraction = await extractTextForFile({ bytes, detectedType: "docx", name: "evidence.docx" });
    expect(extraction.status).toBe("completed");
    expect(extraction.textExtracted).toBe(true);
    expect(extraction.text).toContain("دليل مستند وورد للاختبار");
  });

  it("records no text for images and failed parts for unsupported types", async () => {
    const image = await extractTextForFile({ bytes: PNG_BYTES, detectedType: "png", name: "shot.png" });
    expect(image.status).toBe("completed");
    expect(image.textExtracted).toBe(false);
    expect(image.text).toBe("");
    expect(image.failedParts).toEqual([]);

    const zip = await extractTextForFile({
      bytes: new Uint8Array(await makeDocx("نص")),
      detectedType: "zip",
      name: "archive.zip",
    });
    expect(zip.status).toBe("failed");
    expect(zip.textExtracted).toBe(false);
    expect(zip.errorCode).toBe("UNSUPPORTED_TYPE");
    expect(zip.failedParts).toEqual([{ label: "zip", reason: "unsupported_type" }]);

    const broken = await extractTextForFile({
      bytes: Buffer.from([0xc3, 0x28, 0xa0, 0xa1]),
      detectedType: "text",
      name: "broken.txt",
    });
    expect(broken.status).toBe("failed");
    expect(broken.textExtracted).toBe(false);
    expect(broken.failedParts.length).toBe(1);
  });

  it("caps persisted text at the processing limit", async () => {
    const extraction = await extractTextForFile({
      bytes: Buffer.from("a".repeat(500)),
      detectedType: "text",
      name: "long.txt",
      maxChars: 100,
    });
    expect(extraction.textExtracted).toBe(true);
    expect(extraction.text.length).toBeLessThanOrEqual(160);
  });
});

describe("persisted extraction and attachment loading", () => {
  it("persists files, documents (v1), chunks, and an extraction job report", async () => {
    const bytes = Buffer.from("نص الملف المرفق الفريد للأدلة");
    const { stored, saved } = await uploadFile({ bytes, name: "../../secret/evidence.txt" });
    expect(saved.name).toBe("evidence.txt");
    expect(saved.status).toBe("stored");
    expect(saved.textExtracted).toBe(true);

    const fileRow = db
      .prepare("SELECT user_id, storage_key, original_name, detected_type, byte_size, sha256, status FROM files WHERE id = ?")
      .get(stored.id) as Record<string, string | number>;
    expect(fileRow.user_id).toBe(USER_ID);
    expect(fileRow.detected_type).toBe("text");
    expect(fileRow.status).toBe("stored");
    expect(fileRow.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

    const document = db
      .prepare("SELECT id, processing_version FROM documents WHERE file_id = ?")
      .get(stored.id) as { id: string; processing_version: string };
    expect(document.processing_version).toBe("v1");
    const chunks = db
      .prepare("SELECT text FROM chunks WHERE document_id = ? ORDER BY ordinal")
      .all(document.id) as { text: string }[];
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("نص الملف المرفق الفريد");

    const job = db
      .prepare("SELECT status, report FROM extraction_jobs WHERE file_id = ?")
      .get(stored.id) as { status: string; report: string };
    expect(job.status).toBe("completed");
    const report = JSON.parse(job.report) as { textExtracted?: boolean; failedParts?: unknown[] };
    expect(report.textExtracted).toBe(true);
    expect(report.failedParts).toEqual([]);
  });

  it("builds attachment snapshots and shared evidence text from persisted rows", async () => {
    const { stored } = await uploadFile({ bytes: Buffer.from("دليل مشترك فريد"), name: "shared.txt" });
    const loaded = loadAttachmentSnapshots(db, USER_ID, [stored.id]);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.attachments).toHaveLength(1);
    expect(loaded.attachments[0]).toMatchObject({
      fileId: stored.id,
      name: "shared.txt",
      detectedType: "text",
      image: null,
    });
    expect(loaded.attachments[0]?.text).toContain("دليل مشترك فريد");
    expect(loaded.evidenceText).toContain("shared.txt");
    expect(loaded.evidenceText).toContain("دليل مشترك فريد");
  });

  it("represents images without text and records unsupported parts", async () => {
    const image = await uploadFile({ bytes: PNG_BYTES, name: "photo.png" });
    const loaded = loadAttachmentSnapshots(db, USER_ID, [image.stored.id]);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.attachments[0]?.image).toEqual({ mediaType: "image/png", byteSize: PNG_BYTES.byteLength });
    expect(loaded.attachments[0]?.text).toBe("");

    const zip = await uploadFile({
      bytes: new Uint8Array(await makeDocx("x")),
      name: "archive.zip",
      detectedType: "zip",
    });
    const unsupported = loadAttachmentSnapshots(db, USER_ID, [zip.stored.id]);
    expect(unsupported.ok).toBe(true);
    if (!unsupported.ok) return;
    expect(unsupported.attachments[0]?.failedParts).toEqual([{ label: "zip", reason: "unsupported_type" }]);
  });

  it("rejects foreign or unknown file ids instead of leaking them", async () => {
    const foreign = randomUUID();
    insertFile(db, {
      id: foreign,
      userId: OTHER_USER_ID,
      storageKey: `${OTHER_USER_ID}/${foreign}`,
      originalName: "secret.txt",
      detectedType: "text",
      byteSize: 4,
      sha256: "0".repeat(64),
      status: "stored",
    });
    const foreignResult = loadAttachmentSnapshots(db, USER_ID, [foreign]);
    expect(foreignResult.ok).toBe(false);
    if (!foreignResult.ok) {
      expect(foreignResult.code).toBe("attachments");
      expect(foreignResult.status).toBe(422);
    }
    const missing = loadAttachmentSnapshots(db, USER_ID, [randomUUID()]);
    expect(missing.ok).toBe(false);
    const traversal = loadAttachmentSnapshots(db, USER_ID, ["../../etc/passwd"]);
    expect(traversal.ok).toBe(false);
  });

  it("caps shared evidence text so one large file cannot flood every prompt", async () => {
    const big = "ب".repeat(MAX_STORED_TEXT_CHARS + 1000);
    const { stored } = await uploadFile({
      bytes: Buffer.from("x"),
      name: "big.txt",
      text: big,
      detectedType: "text",
    });
    const loaded = loadAttachmentSnapshots(db, USER_ID, [stored.id]);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.evidenceText.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS + 100);
  });
});

describe("comparison attachment input and persistence", () => {
  const baseBody = {
    question: "ما الفرق؟",
    evidenceMode: "native",
    answerModelIds: ["google/gemma-4-31b-it:free"],
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
  };

  it("validates attachmentIds: max five, UUIDs only, deduplicated", () => {
    const id = randomUUID();
    const good = parseComparisonBody({ ...baseBody, attachmentIds: [id, id] });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value.attachmentIds).toEqual([id]);

    const absent = parseComparisonBody({ ...baseBody });
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.value.attachmentIds).toEqual([]);

    for (const bad of [
      [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()],
      ["../../etc/passwd"],
      [123],
      "not-an-array",
    ]) {
      const parsed = parseComparisonBody({ ...baseBody, attachmentIds: bad });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe("attachments");
    }
  });

  it("persists attachmentIds and evidence text and exposes attachments in the public view", async () => {
    const { stored } = await uploadFile({ bytes: Buffer.from("دليل محفوظ"), name: "saved.txt" });
    const created = createComparison(db, {
      userId: USER_ID,
      idempotencyKey: randomUUID(),
      question: "سؤال الدليل",
      evidenceMode: "native",
      runs: [],
      limits: { sharedLimit: 20, userLimit: 20, maxUserConcurrent: 4, maxGlobalConcurrent: 8 },
      attachmentIds: [stored.id],
      evidenceText: "دليل محفوظ",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.comparison.attachments).toEqual([
      { id: stored.id, name: "saved.txt", detectedType: "text" },
    ]);
    const reread = readComparison(db, USER_ID, created.comparison.id);
    expect(reread?.attachments?.[0]?.name).toBe("saved.txt");
    const snapshot = db
      .prepare("SELECT payload FROM evidence_snapshots WHERE comparison_id = ?")
      .get(created.comparison.id) as { payload: string };
    const payload = JSON.parse(snapshot.payload) as { attachmentIds?: string[]; evidenceText?: string };
    expect(payload.attachmentIds).toEqual([stored.id]);
    expect(payload.evidenceText).toBe("دليل محفوظ");
    // Another user never sees the attachments or evidence.
    expect(readComparison(db, OTHER_USER_ID, created.comparison.id)).toBeNull();
  });
});

describe("comparison planning with attachments", () => {
  const draft = {
    question: "اشرح الصورة المرفقة",
    evidenceMode: "native" as const,
    answerModelIds: [] as string[],
    decisionModelIds: [] as string[],
    evalModelIds: [] as string[],
    safetyModelIds: [] as string[],
    speechModelIds: [] as string[],
    router: false,
    decision: null,
    behavior: null,
    speechText: null,
    profile: { name: "ليان", email: "layan@example.com", phone: "" },
    userId: USER_ID,
  };

  function imageAttachment(fileId: string): AttachmentSnapshot {
    return {
      fileId,
      name: "photo.png",
      detectedType: "png",
      text: "",
      image: { mediaType: "image/png", byteSize: PNG_BYTES.byteLength },
      failedParts: [],
    };
  }

  function contentOf(request: Record<string, unknown> | null, index: number): unknown[] {
    const messages = request?.messages as { content: unknown }[] | undefined;
    const content = messages?.[index]?.content;
    return Array.isArray(content) ? content : [];
  }

  it("plans an image_ref for native-capable models and hydrates it before dispatch", async () => {
    const { stored } = await uploadFile({ bytes: PNG_BYTES, name: "photo.png" });
    const runs = planRuns({
      ...draft,
      evidenceText: "— ملف: photo.png (png)\n[صورة مرفقة]",
      attachments: [imageAttachment(stored.id)],
      answerModelIds: ["claude-haiku-5-5", "google/gemma-4-31b-it:free"],
    });

    const haiku = runs.find((run) => run.modelId === "claude-haiku-5-5");
    expect(haiku?.status).toBe("queued");
    const haikuRef = contentOf(haiku?.request ?? null, 0).find(
      (part) => (part as { type?: unknown }).type === "image_ref",
    ) as { fileId?: string } | undefined;
    expect(haikuRef?.fileId).toBe(stored.id);
    const hydratedHaiku = hydrateImageRefs(db, USER_ID, "anthropic", haiku?.request ?? null, { env: env() });
    const haikuImage = contentOf(hydratedHaiku, 0).find((part) => (part as { type?: unknown }).type === "image") as
      | { source?: { data?: string } }
      | undefined;
    expect(haikuImage?.source?.data).toBe(PNG_BYTES.toString("base64"));

    const gemma = runs.find((run) => run.modelId === "google/gemma-4-31b-it:free");
    expect(gemma?.status).toBe("queued");
    const gemmaRef = contentOf(gemma?.request ?? null, 1).find(
      (part) => (part as { type?: unknown }).type === "image_ref",
    ) as { fileId?: string } | undefined;
    expect(gemmaRef?.fileId).toBe(stored.id);
    const hydratedGemma = hydrateImageRefs(db, USER_ID, "openrouter", gemma?.request ?? null, { env: env() });
    const gemmaImage = contentOf(hydratedGemma, 1).find(
      (part) => (part as { type?: unknown }).type === "image_url",
    ) as { image_url?: { url?: string } } | undefined;
    expect(gemmaImage?.image_url?.url?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("keeps unified evidence mode text-only", () => {
    const runs = planRuns({
      ...draft,
      evidenceMode: "unified",
      evidenceText: "— ملف: photo.png (png)\n[صورة مرفقة]",
      attachments: [imageAttachment(randomUUID())],
      answerModelIds: ["claude-haiku-5-5", "google/gemma-4-31b-it:free"],
    });
    for (const run of runs) {
      const parts = contentOf(run.request, run.modelId === "claude-haiku-5-5" ? 0 : 1);
      expect(parts.some((part) => (part as { type?: unknown }).type === "image_ref")).toBe(false);
    }
  });
});

describe("image hydration for provider requests", () => {
  async function storedPng(userId = USER_ID) {
    const { stored } = await uploadFile({ userId, bytes: PNG_BYTES, name: "photo.png" });
    return stored;
  }

  function request(provider: "anthropic" | "openrouter", fileId: string, mediaType = "image/png") {
    return {
      model: provider === "anthropic" ? "claude-haiku-5-5" : "google/gemma-4-31b-it:free",
      messages: [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [
            { type: "text", text: "اشرح الصورة" },
            { type: "image_ref", fileId, mediaType },
          ],
        },
      ],
    } satisfies Record<string, unknown>;
  }

  function lastContentPart(hydrated: Record<string, unknown> | null, index = 1): Record<string, unknown> {
    const messages = hydrated?.messages as { content: unknown[] }[];
    const parts = messages?.[1]?.content ?? [];
    const part = parts[index];
    return part && typeof part === "object" ? (part as Record<string, unknown>) : {};
  }

  it("hydrates Anthropic base64 images and OpenRouter data URLs from stored bytes", async () => {
    const stored = await storedPng();
    const anthropic = hydrateImageRefs(db, USER_ID, "anthropic", request("anthropic", stored.id), { env: env() });
    const anthropicPart = lastContentPart(anthropic);
    expect(anthropicPart.type).toBe("image");
    const source = anthropicPart.source as Record<string, unknown>;
    expect(source.type).toBe("base64");
    expect(source.media_type).toBe("image/png");
    expect(source.data).toBe(PNG_BYTES.toString("base64"));

    const openrouter = hydrateImageRefs(db, USER_ID, "openrouter", request("openrouter", stored.id), { env: env() });
    const openrouterPart = lastContentPart(openrouter);
    expect(openrouterPart.type).toBe("image_url");
    const url = (openrouterPart.image_url as { url?: string }).url ?? "";
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(url).toContain(PNG_BYTES.toString("base64"));
  });

  it("falls back to text for foreign, non-image, oversized, or missing files", async () => {
    const foreign = await storedPng(OTHER_USER_ID);
    expect(lastContentPart(hydrateImageRefs(db, USER_ID, "anthropic", request("anthropic", foreign.id), { env: env() })).type).toBe("text");

    const textFile = await uploadFile({ bytes: Buffer.from("نص"), name: "a.txt" });
    expect(lastContentPart(hydrateImageRefs(db, USER_ID, "anthropic", request("anthropic", textFile.stored.id, "text/plain"), { env: env() })).type).toBe("text");

    const stored = await storedPng();
    db.prepare("UPDATE files SET byte_size = ? WHERE id = ?").run(6 * 1024 * 1024, stored.id);
    expect(lastContentPart(hydrateImageRefs(db, USER_ID, "anthropic", request("anthropic", stored.id), { env: env() })).type).toBe("text");

    const another = await storedPng();
    rmSync(storedPath(USER_ID, another.id), { force: true });
    expect(lastContentPart(hydrateImageRefs(db, USER_ID, "anthropic", request("anthropic", another.id), { env: env() })).type).toBe("text");

    expect(hydrateImageRefs(db, USER_ID, "anthropic", null, { env: env() })).toBeNull();
  });
});
