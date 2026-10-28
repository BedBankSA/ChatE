import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatHistoryDate, truncateQuestion } from "@/app/history/format";
import { signSession } from "@/domain/auth/session";
import {
  encodeHistoryCursor,
  HISTORY_PAGE_SIZE,
  listComparisons,
  readComparisonForUser,
} from "@/server/comparisons/history";
import { insertFile, insertUser, migrateDatabase, openDatabase } from "@/server/db/index";

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }));

// The API route resolves the shared database through this module; the data
// layer receives the test database explicitly.
vi.mock("@/server/db/runtime", () => ({
  getDatabase: () => {
    if (!state.db) throw new Error("test database is not ready");
    return state.db;
  },
}));

const MIGRATIONS = path.join(process.cwd(), "migrations");
const SECRET = "history-test-session-secret";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CMP_1 = "11111111-1111-4111-8111-111111111111";
const CMP_2 = "22222222-2222-4222-8222-222222222222";
const CMP_3 = "33333333-3333-4333-8333-333333333333";
const CMP_4 = "44444444-4444-4444-8444-444444444444";
const CMP_5 = "55555555-5555-4555-8555-555555555555";
const CMP_FOREIGN = "66666666-6666-4666-8666-666666666666";
const FILE_1 = "f1111111-1111-4111-8111-111111111111";
const FILE_2 = "f2222222-2222-4222-8222-222222222222";
const MODEL_A = "google/gemma-4-31b-it:free";
const MODEL_B = "recursive/flint-v1.0:free";
const MODEL_C = "google/gemma-4-26b-it:free";

type HistoryItemBody = {
  id: string;
  question: string;
  status: string;
  createdAt: string;
  runCount: number;
  completedCount: number;
  modelIds: string[];
};

type HistoryBody = {
  ok?: boolean;
  data?: { comparisons?: HistoryItemBody[] } | null;
  error?: { message?: string; code?: string } | null;
};

function database(): DatabaseSync {
  if (!state.db) throw new Error("test database is not ready");
  return state.db;
}

function at(minute: number): string {
  return `2026-10-20T10:${String(minute).padStart(2, "0")}:00.000Z`;
}

function seedUser(id: string, sub: string): void {
  insertUser(database(), { id, googleSub: sub, email: `${sub}@example.com`, name: "مستخدم" });
}

function seedComparison(input: {
  id: string;
  userId: string;
  createdAt: string;
  question?: string;
  status?: string;
  payload?: Record<string, unknown>;
}): void {
  const question = input.question ?? "ما الفرق بين النموذجين؟";
  database()
    .prepare(`
      INSERT INTO comparisons (id, user_id, question, evidence_mode, idempotency_key, status, created_at)
      VALUES (?, ?, ?, 'native', ?, ?, ?)
    `)
    .run(input.id, input.userId, question, `key-${input.id}`, input.status ?? "completed", input.createdAt);
  database()
    .prepare("INSERT INTO evidence_snapshots (id, comparison_id, user_id, payload) VALUES (?, ?, ?, ?)")
    .run(
      `ev-${input.id}`,
      input.id,
      input.userId,
      JSON.stringify(
        input.payload ?? { question, evidenceMode: "native", evidenceText: "", attachmentIds: [] },
      ),
    );
}

function seedRun(input: {
  id: string;
  comparisonId: string;
  userId: string;
  modelId: string;
  status: string;
  createdAt: string;
  displayName?: string;
  outputText?: string;
  costUsd?: number | null;
  completionMs?: number | null;
}): void {
  database()
    .prepare(`
      INSERT INTO model_runs
        (id, comparison_id, user_id, model_id, status, requested_settings, output_text, cost_usd, completion_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      input.id,
      input.comparisonId,
      input.userId,
      input.modelId,
      input.status,
      JSON.stringify({ displayName: input.displayName ?? input.modelId, provider: "openrouter", labels: [] }),
      input.outputText ?? "",
      input.costUsd ?? null,
      input.completionMs ?? null,
      input.createdAt,
    );
}

function sessionCookie(userId: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signSession(
    { userId, googleSub: `sub-${userId}`, exp: nowSec + 600, csrf: "csrf-history", iat: nowSec },
    SECRET,
  );
  return "chate_session=" + token;
}

function historyRequest(query = "", anonymous = false): Request {
  const headers: Record<string, string> = {};
  if (!anonymous) headers.cookie = sessionCookie(USER_A);
  return new Request("http://localhost:3211/api/history" + query, { headers });
}

async function getHistory(query = "", anonymous = false): Promise<{ status: number; body: HistoryBody; headers: Headers }> {
  const { GET } = await import("@/app/api/history/route");
  const response = await GET(historyRequest(query, anonymous));
  return { status: response.status, body: (await response.json()) as HistoryBody, headers: response.headers };
}

function seedThreeForUserA(): void {
  seedComparison({ id: CMP_1, userId: USER_A, createdAt: at(1), status: "completed" });
  seedRun({ id: "run-1a", comparisonId: CMP_1, userId: USER_A, modelId: MODEL_A, status: "completed", createdAt: at(1) });
  seedRun({ id: "run-1b", comparisonId: CMP_1, userId: USER_A, modelId: MODEL_B, status: "failed", createdAt: at(2) });
  seedComparison({ id: CMP_2, userId: USER_A, createdAt: at(3), status: "running" });
  seedRun({ id: "run-2a", comparisonId: CMP_2, userId: USER_A, modelId: MODEL_C, status: "running", createdAt: at(3) });
  seedComparison({ id: CMP_3, userId: USER_A, createdAt: at(5), status: "queued" });
}

beforeEach(() => {
  state.db = openDatabase(":memory:");
  migrateDatabase(database(), MIGRATIONS);
  seedUser(USER_A, "google-sub-a");
  seedUser(USER_B, "google-sub-b");
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (state.db && state.db.isOpen) state.db.close();
  state.db = null;
});

describe("listComparisons", () => {
  it("lists the owner's comparisons newest first with run counts and model ids", () => {
    seedThreeForUserA();
    const items = listComparisons(database(), USER_A, { limit: HISTORY_PAGE_SIZE });

    expect(items.map((item) => item.id)).toEqual([CMP_3, CMP_2, CMP_1]);
    expect(items[0]).toMatchObject({
      question: "ما الفرق بين النموذجين؟",
      status: "queued",
      createdAt: at(5),
      runCount: 0,
      completedCount: 0,
      modelIds: [],
    });
    expect(items[1]).toMatchObject({
      status: "running",
      createdAt: at(3),
      runCount: 1,
      completedCount: 0,
      modelIds: [MODEL_C],
    });
    expect(items[2]).toMatchObject({
      status: "completed",
      createdAt: at(1),
      runCount: 2,
      completedCount: 1,
      modelIds: [MODEL_A, MODEL_B],
    });
  });

  it("clamps the limit to 1..50", () => {
    for (let index = 0; index < 55; index += 1) {
      seedComparison({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        userId: USER_A,
        createdAt: new Date(Date.UTC(2026, 8, 1 + index, 10, 0, 0)).toISOString(),
      });
    }
    expect(listComparisons(database(), USER_A, { limit: 999 })).toHaveLength(50);
    expect(listComparisons(database(), USER_A, { limit: 0 })).toHaveLength(1);
    expect(listComparisons(database(), USER_A, { limit: -10 })).toHaveLength(1);
    expect(listComparisons(database(), USER_A, { limit: 3 })).toHaveLength(3);
  });

  it("paginates with the opaque before cursor without gaps or duplicates", () => {
    seedThreeForUserA();
    const first = listComparisons(database(), USER_A, { limit: 2 });
    expect(first.map((item) => item.id)).toEqual([CMP_3, CMP_2]);

    const cursor = encodeHistoryCursor(first[first.length - 1]!);
    const second = listComparisons(database(), USER_A, { limit: 2, before: cursor });
    expect(second.map((item) => item.id)).toEqual([CMP_1]);

    const third = listComparisons(database(), USER_A, {
      limit: 2,
      before: encodeHistoryCursor(second[second.length - 1]!),
    });
    expect(third).toEqual([]);

    const seen = [...first, ...second].map((item) => item.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([CMP_3, CMP_2, CMP_1]);
  });

  it("ignores an unreadable before cursor and starts from the newest row", () => {
    seedThreeForUserA();
    expect(listComparisons(database(), USER_A, { limit: 2, before: "not-a-cursor" }).map((item) => item.id)).toEqual([
      CMP_3,
      CMP_2,
    ]);
  });

  it("breaks created-at ties by id so pagination cannot skip or loop", () => {
    seedComparison({ id: CMP_1, userId: USER_A, createdAt: at(4) });
    seedComparison({ id: CMP_2, userId: USER_A, createdAt: at(4) });
    const first = listComparisons(database(), USER_A, { limit: 1 });
    expect(first.map((item) => item.id)).toEqual([CMP_2]);
    const second = listComparisons(database(), USER_A, {
      limit: 1,
      before: encodeHistoryCursor(first[0]!),
    });
    expect(second.map((item) => item.id)).toEqual([CMP_1]);
  });

  it("isolates each user's comparisons", () => {
    seedThreeForUserA();
    seedComparison({ id: CMP_FOREIGN, userId: USER_B, createdAt: at(9), question: "سؤال حساب آخر" });

    expect(listComparisons(database(), USER_A, { limit: 20 }).map((item) => item.id)).toEqual([CMP_3, CMP_2, CMP_1]);
    const foreign = listComparisons(database(), USER_B, { limit: 20 });
    expect(foreign.map((item) => item.id)).toEqual([CMP_FOREIGN]);
    expect(foreign[0]?.question).toBe("سؤال حساب آخر");
  });

  it("returns an empty list for a user without comparisons", () => {
    expect(listComparisons(database(), USER_A, { limit: 20 })).toEqual([]);
  });
});

describe("readComparisonForUser", () => {
  it("returns the owner's detail with date, runs, cost, latency and attachments", () => {
    insertFile(database(), {
      id: FILE_1,
      userId: USER_A,
      storageKey: `storage/${USER_A}/${FILE_1}`,
      originalName: "تقرير.pdf",
      detectedType: "pdf",
      byteSize: 120,
      sha256: "ab".repeat(32),
      status: "stored",
    });
    seedComparison({
      id: CMP_1,
      userId: USER_A,
      createdAt: at(1),
      question: "ما أهم نتائج التقرير؟",
      payload: { question: "ما أهم نتائج التقرير؟", evidenceMode: "native", evidenceText: "دليل", attachmentIds: [FILE_1] },
    });
    seedRun({
      id: "run-1a",
      comparisonId: CMP_1,
      userId: USER_A,
      modelId: MODEL_A,
      status: "completed",
      createdAt: at(1),
      displayName: "Gemma 4 31B",
      outputText: "الجواب الكامل",
      costUsd: 0.00012,
      completionMs: 1234,
    });

    const detail = readComparisonForUser(database(), USER_A, CMP_1);
    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      id: CMP_1,
      question: "ما أهم نتائج التقرير؟",
      status: "completed",
      createdAt: at(1),
      attachments: [{ id: FILE_1, name: "تقرير.pdf", detectedType: "pdf" }],
    });
    expect(detail?.runs).toHaveLength(1);
    expect(detail?.runs[0]).toMatchObject({
      modelId: MODEL_A,
      displayName: "Gemma 4 31B",
      provider: "openrouter",
      status: "completed",
      outputText: "الجواب الكامل",
      costUsd: 0.00012,
      completionMs: 1234,
    });
  });

  it("prefers explicit attachment metadata stored in the evidence payload", () => {
    seedComparison({
      id: CMP_2,
      userId: USER_A,
      createdAt: at(2),
      payload: {
        question: "سؤال",
        attachmentIds: [FILE_1],
        attachments: [{ id: FILE_1, name: "من الحمولة.txt", detectedType: "text" }],
      },
    });
    expect(readComparisonForUser(database(), USER_A, CMP_2)?.attachments).toEqual([
      { id: FILE_1, name: "من الحمولة.txt", detectedType: "text" },
    ]);
  });

  it("accepts plan-style attachment snapshots keyed by fileId in the evidence payload", () => {
    seedComparison({
      id: CMP_4,
      userId: USER_A,
      createdAt: at(4),
      payload: {
        question: "سؤال",
        attachmentIds: [FILE_2],
        attachments: [{ fileId: FILE_2, name: "صورة.png", detectedType: "png", text: "", image: null, failedParts: [] }],
      },
    });
    expect(readComparisonForUser(database(), USER_A, CMP_4)?.attachments).toEqual([
      { id: FILE_2, name: "صورة.png", detectedType: "png" },
    ]);
  });

  it("tolerates a comparison saved without attachment metadata", () => {
    seedComparison({
      id: CMP_3,
      userId: USER_A,
      createdAt: at(3),
      payload: { question: "سؤال قديم", evidenceMode: "native", evidenceText: "" },
    });
    const detail = readComparisonForUser(database(), USER_A, CMP_3);
    expect(detail?.attachments).toEqual([]);
    expect(detail?.runs).toEqual([]);
  });

  it("returns null for a foreign comparison, an unknown id, or a malformed id", () => {
    seedComparison({ id: CMP_FOREIGN, userId: USER_B, createdAt: at(9) });
    expect(readComparisonForUser(database(), USER_A, CMP_FOREIGN)).toBeNull();
    expect(readComparisonForUser(database(), USER_A, CMP_5)).toBeNull();
    expect(readComparisonForUser(database(), USER_A, "not-a-uuid")).toBeNull();
    expect(readComparisonForUser(database(), USER_A, "../../etc/passwd")).toBeNull();
  });
});

describe("GET /api/history", () => {
  it("rejects an anonymous caller before reading the database", async () => {
    const result = await getHistory("", true);
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ ok: false, data: null, error: { code: "anonymous" } });
    expect(result.body.error?.message).toBeTruthy();
  });

  it("returns only the signed-in user's comparisons with no-store", async () => {
    seedThreeForUserA();
    seedComparison({ id: CMP_FOREIGN, userId: USER_B, createdAt: at(9) });

    const result = await getHistory();
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.error).toBeNull();
    expect(result.headers.get("cache-control")).toBe("no-store");
    const comparisons = result.body.data?.comparisons ?? [];
    expect(comparisons.map((item) => item.id)).toEqual([CMP_3, CMP_2, CMP_1]);
    expect(JSON.stringify(result.body)).not.toContain(CMP_FOREIGN);
    expect(comparisons[2]).toMatchObject({
      id: CMP_1,
      status: "completed",
      createdAt: at(1),
      runCount: 2,
      completedCount: 1,
      modelIds: [MODEL_A, MODEL_B],
    });
  });

  it("pages through the log with the before cursor", async () => {
    seedThreeForUserA();
    const first = await getHistory("?limit=1");
    expect(first.status).toBe(200);
    expect(first.body.data?.comparisons?.map((item) => item.id)).toEqual([CMP_3]);

    const cursor = encodeHistoryCursor(first.body.data?.comparisons?.[0] as HistoryItemBody);
    const second = await getHistory(`?limit=1&before=${encodeURIComponent(cursor)}`);
    expect(second.body.data?.comparisons?.map((item) => item.id)).toEqual([CMP_2]);
  });

  it("returns an empty comparison list for a user without rows", async () => {
    const result = await getHistory();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, data: { comparisons: [] }, error: null });
  });

  it("fails closed for a signed session whose account is gone", async () => {
    seedThreeForUserA();
    database().prepare("DELETE FROM users WHERE id = ?").run(USER_A);
    const result = await getHistory();
    expect(result.status).toBe(401);
    expect(result.body.error?.code).toBe("anonymous");
  });
});

describe("history page formatting", () => {
  it("formats instants in Riyadh time with latin digits", () => {
    const formatted = formatHistoryDate(at(0));
    expect(formatted).toContain("2026");
    expect(formatted).toContain("13:00");
    expect(formatted).not.toMatch(/[٠-٩]/);
  });

  it("keeps short questions and truncates long ones for the list", () => {
    expect(truncateQuestion("سؤال قصير")).toBe("سؤال قصير");
    const long = "س".repeat(300);
    const shortened = truncateQuestion(long);
    expect(shortened.length).toBeLessThan(long.length);
    expect(shortened.endsWith("…")).toBe(true);
  });
});
