import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "@/domain/auth/session";
import { MODEL_CATALOG } from "@/domain/models/catalog";
import { CHAT_SHORTCUT_MODEL, MAX_COMPARISON_MODELS, MODEL_LIMIT_MESSAGE } from "@/domain/workspace-start";
import { insertUser, migrateDatabase, openDatabase } from "@/server/db/index";

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

const SECRET = "comparison-limits-session-secret";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MIGRATIONS = path.join(process.cwd(), "migrations");
const USER_ID = "33333333-3333-4333-8333-333333333333";
const GOOGLE_SUB = "google-sub-comparison-limits";

/**
 * The five approved catalog champions (taskType إجابة/محادثة/برمجة), all
 * sendable after the owner-enabled NVIDIA decision; the accepted request stores
 * one model_runs row per model id.
 */
const ANSWER_MODEL_IDS = [
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "recursive/flint-v1.0:free",
  "cohere/north-mini-code:free",
  "claude-haiku-5-5",
] as const;

/**
 * Shape-valid ids that do not exist in the catalog. The nine-id test relies on
 * the request-size validation firing BEFORE catalog planning, so these prove
 * the cap independently of how many models the catalog currently holds.
 */
function syntheticIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `future/model-${index}:free`);
}

type JsonBody<T> = { ok?: boolean; data?: T | null; error?: { message?: string; code?: string } | null };
type ComparisonData = { id?: string; runs?: { modelId: string; status: string }[] };

let tokenSeq = 0;

function database(): DatabaseSync {
  if (!state.db) throw new Error("test database is not ready");
  return state.db;
}

function sessionCookie(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signSession(
    { userId: USER_ID, googleSub: GOOGLE_SUB, exp: nowSec + 600, csrf: "csrf-comparison-limits", iat: nowSec },
    SECRET,
  );
  return "chate_session=" + token;
}

function nextToken(): string {
  tokenSeq += 1;
  return `comparison-${tokenSeq}`;
}

function comparisonRequest(payload: Record<string, unknown>): Request {
  return new Request("http://localhost:3211/api/comparisons", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-host": "localhost",
      cookie: sessionCookie(),
    },
    body: JSON.stringify(payload),
  });
}

async function postComparison(payload: Record<string, unknown>) {
  const { POST } = await import("@/app/api/comparisons/route");
  const response = await POST(comparisonRequest(payload));
  const body = (await response.json()) as JsonBody<ComparisonData>;
  return { status: response.status, body };
}

function comparisonBody(answerModelIds: unknown[]): Record<string, unknown> {
  return {
    question: "ما الفرق بين النماذج المختارة؟",
    evidenceMode: "native",
    answerModelIds,
    idempotencyKey: randomUUID(),
    "cf-turnstile-response": nextToken(),
  };
}

function comparisonCount(): number {
  const row = database().prepare("SELECT COUNT(*) AS n FROM comparisons").get() as { n: number } | undefined;
  return row?.n ?? 0;
}

function modelRunCount(): number {
  const row = database().prepare("SELECT COUNT(*) AS n FROM model_runs").get() as { n: number } | undefined;
  return row?.n ?? 0;
}

beforeEach(() => {
  state.db = openDatabase(":memory:");
  migrateDatabase(database(), MIGRATIONS);
  insertUser(database(), { id: USER_ID, googleSub: GOOGLE_SUB, email: "limits@example.com", name: "مستخدم اختبار" });
  database()
    .prepare("INSERT INTO profiles (user_id, phone_e164, phone_verified_at) VALUES (?, ?, ?)")
    .run(USER_ID, "+966501234567", new Date().toISOString());
  tokenSeq = 0;
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
  vi.stubEnv("TURNSTILE_EXPECTED_HOSTNAMES", "localhost");
  vi.stubEnv("APP_URL", "http://localhost:3211");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("OTP_PROVIDER", "");
  vi.stubEnv("OTP_HTTP_URL", "");
  vi.stubEnv("SHARED_QUOTA_UNITS", "2000");
  vi.stubEnv("USER_QUOTA_UNITS", "200");
  vi.stubEnv("MAX_USER_CONCURRENCY", "8");
  vi.stubEnv("MAX_GLOBAL_CONCURRENCY", "8");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url !== SITEVERIFY) throw new Error("unexpected network call: " + url);
      const token = new URLSearchParams(String(init?.body ?? "")).get("response") ?? "";
      return Response.json({
        success: true,
        action: token.startsWith("comparison-") ? "comparison" : "upload",
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
});

describe("comparison model limit", () => {
  it("exposes only the five approved champion models", () => {
    const byId = new Map(MODEL_CATALOG.map((model) => [model.id, model]));
    expect(MODEL_CATALOG).toHaveLength(5);
    expect(new Set(MODEL_CATALOG.map((model) => model.id))).toEqual(new Set(ANSWER_MODEL_IDS));
    for (const id of ANSWER_MODEL_IDS) {
      const model = byId.get(id);
      expect(model, `catalog is missing ${id}`).toBeDefined();
      expect(["إجابة", "محادثة", "برمجة"]).toContain(model?.taskType);
    }
    expect(new Set(ANSWER_MODEL_IDS).size).toBe(5);
    expect(ANSWER_MODEL_IDS.length).toBeLessThan(MAX_COMPARISON_MODELS);
  });

  it("accepts the whole five-model catalog and stores one run per model", async () => {
    const { status, body } = await postComparison(comparisonBody([...ANSWER_MODEL_IDS]));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.error).toBeNull();
    expect(body.data?.runs).toHaveLength(ANSWER_MODEL_IDS.length);
    // The response orders runs by storage time, not by request order.
    expect(new Set(body.data?.runs?.map((run) => run.modelId))).toEqual(new Set(ANSWER_MODEL_IDS));
    expect(comparisonCount()).toBe(1);
    expect(modelRunCount()).toBe(ANSWER_MODEL_IDS.length);
  });

  it("rejects nine distinct ids with the visible eight-model message before planning", async () => {
    const ids = syntheticIds(MAX_COMPARISON_MODELS + 1);
    expect(new Set(ids).size).toBe(MAX_COMPARISON_MODELS + 1);
    const { status, body } = await postComparison(comparisonBody(ids));
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("models");
    expect(body.error?.message).toBe(MODEL_LIMIT_MESSAGE);
    expect(body.error?.message).toContain("8");
    expect(comparisonCount()).toBe(0);
    expect(modelRunCount()).toBe(0);
  });

  it("deduplicates a repeated model before counting and stores one run per model", async () => {
    const ids = [...ANSWER_MODEL_IDS, ...ANSWER_MODEL_IDS];
    expect(ids).toHaveLength(10);
    const { status, body } = await postComparison(comparisonBody(ids));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data?.runs).toHaveLength(ANSWER_MODEL_IDS.length);
    expect(comparisonCount()).toBe(1);
    expect(modelRunCount()).toBe(ANSWER_MODEL_IDS.length);
  });

  it("trims duplicate ids before counting them", async () => {
    const duplicate = [...ANSWER_MODEL_IDS.map((id) => `  ${id}  `), ...ANSWER_MODEL_IDS];
    expect(duplicate).toHaveLength(10);
    const { status, body } = await postComparison(comparisonBody(duplicate));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data?.runs?.map((run) => run.modelId)).toContain(ANSWER_MODEL_IDS[0]);
    expect(new Set(body.data?.runs?.map((run) => run.modelId)).size).toBe(ANSWER_MODEL_IDS.length);
    expect(modelRunCount()).toBe(ANSWER_MODEL_IDS.length);
  });

  it("rejects the free router with ROUTER_SEPARATE and stores nothing", async () => {
    const { status, body } = await postComparison(comparisonBody([CHAT_SHORTCUT_MODEL, "openrouter/free"]));
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("ROUTER_SEPARATE");
    expect(comparisonCount()).toBe(0);
    expect(modelRunCount()).toBe(0);
  });

  it("rejects an empty model list with code models", async () => {
    const { status, body } = await postComparison(comparisonBody([]));
    expect(status).toBe(400);
    expect(body.error?.code).toBe("models");
    expect(body.error?.message).toBe("اختر نموذجًا واحدًا على الأقل.");
    expect(comparisonCount()).toBe(0);
    expect(modelRunCount()).toBe(0);
  });

  it("rejects a blank model id with code models", async () => {
    const { status, body } = await postComparison(comparisonBody(["google/gemma-4-31b-it:free", "  "]));
    expect(status).toBe(400);
    expect(body.error?.code).toBe("models");
    expect(body.error?.message).toBe("قائمة النماذج غير صالحة.");
    expect(comparisonCount()).toBe(0);
  });
});
