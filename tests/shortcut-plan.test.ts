import path from "node:path";
import { describe, expect, it } from "vitest";
import { PHONE_VERIFICATION_MESSAGE, modelUseBlock } from "@/domain/auth/model-gate";
import { signSession } from "@/domain/auth/session";
import { planRuns } from "@/domain/comparison/plan";
import { AppError } from "@/domain/errors";
import { COMPARISON_PRESET, SHORTCUTS } from "@/domain/models/catalog";
import { assertSelectable } from "@/domain/models/endpoints";
import { dispatchModel } from "@/domain/models/dispatch";
import { HAIKU_URL } from "@/domain/models/haiku";
import { COMPARISON_MODEL_IDS } from "@/domain/workspace-start";
import { sessionFromRequest } from "@/server/google-session";
import { insertUser } from "@/server/db/accounts";
import { migrateDatabase, openDatabase } from "@/server/db/index";
import { createComparison } from "@/server/comparisons/store";

const draft = {
  question: "ما الفرق؟",
  evidenceMode: "native" as const,
  evidenceText: "",
  attachments: [],
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
  userId: "user-1",
};

describe("shortcut plans", () => {
  it("plans chat and code shortcuts and rejects a paid model id", () => {
    const chat = planRuns({ ...draft, answerModelIds: [SHORTCUTS.conversation] });
    const code = planRuns({ ...draft, answerModelIds: [SHORTCUTS.code] });
    expect(chat.map((run) => run.modelId)).toEqual(["google/gemma-4-31b-it:free"]);
    expect(code.map((run) => run.modelId)).toEqual(["recursive/flint-v1.0:free"]);
    expect(chat[0]?.status).toBe("queued");
    expect(code[0]?.status).toBe("queued");
    expect(chat[0]?.request).toMatchObject({ model: SHORTCUTS.conversation, reasoning: { enabled: true } });
    expect(JSON.stringify(chat[0]?.request)).not.toContain("effort");
    expect(JSON.stringify(code[0]?.request)).not.toContain("effort");
    expect([...COMPARISON_PRESET]).toEqual([...COMPARISON_MODEL_IDS]);
    const comparison = planRuns({ ...draft, answerModelIds: [...COMPARISON_PRESET] });
    const haiku = comparison.find((run) => run.modelId === "claude-haiku-5-5");
    expect(haiku?.status).toBe("queued");
    expect(haiku?.endpoint).toBe(HAIKU_URL);
    expect(haiku?.requestedSettings).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
    expect(JSON.stringify(haiku?.request)).not.toMatch(/temperature|top_p|top_k/);
    expect(() => assertSelectable("openai/gpt-4o")).toThrow(AppError);
    expect(() => planRuns({ ...draft, answerModelIds: ["google/gemma-4-31b-it"] })).toThrow(AppError);
  });

  it("keeps an unverified phone blocked and accepts only a signed session", () => {
    expect(modelUseBlock({
      name: "ليان",
      email: "layan@example.com",
      phoneE164: null,
      phoneVerifiedAt: null,
      age: null,
      city: null,
      status: "active",
    }, false)?.message).toBe(PHONE_VERIFICATION_MESSAGE);
    const previous = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "test-session-secret";
    const db = openDatabase(":memory:");
    try {
      migrateDatabase(db, path.join(process.cwd(), "migrations"));
      insertUser(db, { id: "user-1", googleSub: "user-1", email: "layan@example.com", name: "ليان" });
      const now = 1_700_000_000;
      const token = signSession(
        { userId: "user-1", googleSub: "user-1", exp: now + 60, csrf: "csrf", iat: now },
        "test-session-secret",
      );
      const signed = new Request("http://localhost/api/comparisons", { headers: { cookie: `chate_session=${token}` } });
      expect(sessionFromRequest(signed, now, db)?.userId).toBe("user-1");
      expect(sessionFromRequest(new Request("http://localhost/api/comparisons"), now, db)).toBeNull();
      // A correctly signed token for a user that is not stored must be rejected:
      // the HMAC proves issuance, not that the account still exists.
      const ghost = signSession(
        { userId: "ghost", googleSub: "ghost", exp: now + 60, csrf: "csrf", iat: now },
        "test-session-secret",
      );
      const forged = new Request("http://localhost/api/comparisons", { headers: { cookie: `chate_session=${ghost}` } });
      expect(sessionFromRequest(forged, now, db)).toBeNull();
    } finally {
      if (db.isOpen) db.close();
      if (previous === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previous;
    }
  });

  it("stores one comparison job and separates Anthropic quota from the free pool", () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db, path.join(process.cwd(), "migrations"));
    insertUser(db, { id: "user-1", googleSub: "user-1", email: "layan@example.com", name: "ليان" });
    const runs = planRuns({
      ...draft,
      answerModelIds: [SHORTCUTS.conversation, SHORTCUTS.code, "claude-haiku-5-5"],
    });
    const created = createComparison(db, {
      userId: "user-1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      question: draft.question,
      evidenceMode: "native",
      runs,
      limits: { sharedLimit: 20, userLimit: 20, maxUserConcurrent: 4, maxGlobalConcurrent: 8 },
    });
    expect(created.ok).toBe(true);
    const jobs = db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
    const free = db.prepare("SELECT reserved_units FROM quota_accounts WHERE id = 'shared'").get() as { reserved_units: number };
    const paid = db.prepare("SELECT reserved_units FROM quota_accounts WHERE id = 'shared:anthropic'").get() as { reserved_units: number };
    expect(jobs.n).toBe(1);
    expect(free.reserved_units).toBe(2);
    expect(paid.reserved_units).toBe(1);
    db.close();
  });

  it("sends a free model to OpenRouter and Haiku to Anthropic without a paid route", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      const body = String(init?.body ?? "");
      expect(body).not.toContain("test-openrouter-key");
      expect(body).not.toContain("test-anthropic-key");
      if (String(url).includes("anthropic")) {
        expect(body).toContain('"effort":"medium"');
        return new Response(JSON.stringify({
          model: "claude-haiku-5-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "جواب Haiku" }],
          usage: { input_tokens: 10, output_tokens: 4 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        model: "google/gemma-4-31b-it:free",
        choices: [{ finish_reason: "stop", message: { content: "جواب Gemma" } }],
      }), { status: 200 });
    }) as typeof fetch;
    const free = await dispatchModel({
      provider: "openrouter",
      modelId: SHORTCUTS.conversation,
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      request: { model: SHORTCUTS.conversation, messages: [{ role: "user", content: "سؤال" }] },
    }, { fetchImpl, openRouterKey: "test-openrouter-key", appUrl: "http://localhost:3211" });
    expect(free.outputText).toBe("جواب Gemma");
    expect(free.costUsd).toBeNull();
    const haikuRun = planRuns({ ...draft, answerModelIds: ["claude-haiku-5-5"] })[0];
    const haiku = await dispatchModel({
      provider: "anthropic",
      modelId: "claude-haiku-5-5",
      endpoint: HAIKU_URL,
      request: haikuRun?.request ?? null,
    }, { fetchImpl, anthropicKey: "test-anthropic-key", appUrl: "http://localhost:3211", env: { HAIKU_LIVE_CALLS: "1" } });
    expect(haiku.outputText).toBe("جواب Haiku");
    expect(haiku.costUsd).not.toBeNull();
    const paid = await dispatchModel({
      provider: "openrouter",
      modelId: "openai/gpt-4o",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      request: { model: "openai/gpt-4o", messages: [] },
    }, {
      fetchImpl: (async () => {
        throw new Error("paid route was called");
      }) as typeof fetch,
      openRouterKey: "test-openrouter-key",
      appUrl: "http://localhost:3211",
    });
    expect(paid.attempted).toBe(false);
    expect(paid.errorCode).toBe("PAID_ROUTE");
    expect(calls).toEqual([
      "https://openrouter.ai/api/v1/chat/completions",
      "https://api.anthropic.com/v1/messages",
    ]);
  });
});
