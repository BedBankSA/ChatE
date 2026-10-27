import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { evaluateAccess, isAdmin } from "@/domain/auth/access";
import { assertGoogleClaims, profileFromVerifiedClaims } from "@/domain/auth/google-claims";
import { createOtpProvider, issueChallenge, verifyChallenge } from "@/domain/auth/otp";
import { normalizePhone, profileGate, withUnverifiedPhone, withVerifiedPhone, type Profile } from "@/domain/auth/profile";
import { readSession, sessionCookie, signSession } from "@/domain/auth/session";
import { assertTurnstileConfig, evaluateTurnstile, siteverify, turnstileTokenProblem, verifyTurnstileRequest } from "@/domain/auth/turnstile";
import {
  applySafetyResult,
  buildAnswerPrompt,
  cancelLocally,
  followUpContext,
  planRuns,
  requestsAreIndependent,
  sameQuestion,
  settleIndependent,
  sortRuns,
} from "@/domain/comparison/plan";
import { beginIdempotent, reserve, retryDecision } from "@/domain/quota/reserve";
import {
  classifyOfficeZip,
  detectContent,
  inspectZipEntry,
  officeRoute,
  parseJsonDocument,
  reportPages,
} from "@/domain/files/content";
import { findModel, listPublicModels, MODEL_CATALOG } from "@/domain/models/catalog";
import {
  acceptReturnedModel,
  assertSelectable,
  embeddingBody,
  indexCompatible,
  openRouterChatBody,
  planDefaultEmbedding,
} from "@/domain/models/endpoints";
import { buildHaikuRequest, HAIKU_LIVE_CALLS_ENABLED, postHaiku } from "@/domain/models/haiku";
import { buildMaxQualityFree, completionCap, estimateTokens, interpretFinish } from "@/domain/models/max-quality";
import { escapeHtml } from "@/domain/security/markdown";
import { redact } from "@/domain/security/redact";
import { AppError } from "@/domain/errors";

const profile: Profile = {
  name: "ليان",
  email: "layan@example.com",
  phoneE164: null,
  phoneVerifiedAt: null,
  age: null,
  city: null,
  status: "active",
};

const draft = {
  question: "اشرح الفرق بين النموذجين",
  evidenceMode: "native" as const,
  evidenceText: "دليل مشترك",
  attachments: [{ fileId: "f1", name: "a.png", detectedType: "png", text: "نص مستخرج", image: { mediaType: "image/png", byteSize: 20 }, failedParts: [] }],
  answerModelIds: ["google/gemma-4-31b-it:free", "recursive/flint-v1.0:free"],
  decisionModelIds: [] as string[],
  evalModelIds: [] as string[],
  safetyModelIds: [] as string[],
  speechModelIds: [] as string[],
  router: false,
  decision: null,
  behavior: null,
  speechText: null,
  profile: { name: "ليان", email: "layan@example.com", phone: "+966512345678" },
  userId: "11111111-1111-1111-1111-111111111111",
};

describe("access and identity", () => {
  it("blocks an anonymous caller before models or uploads", () => {
    const result = evaluateAccess({
      session: null,
      profileComplete: false,
      suspended: false,
      adminRoute: false,
      isAdmin: false,
      turnstileRequired: true,
      turnstileOk: true,
      quotaOk: true,
      modelAllowed: true,
    });
    expect(result).toMatchObject({ ok: false, status: 401, code: "anonymous" });
  });

  it("rejects a Google token with the wrong audience", () => {
    expect(() =>
      assertGoogleClaims(
        { aud: "other", iss: "https://accounts.google.com", exp: 100, sub: "s", email: "a@b.c", email_verified: true, nonce: "n" },
        "expected",
        10,
        "n",
      ),
    ).toThrow("GOOGLE_AUDIENCE");
  });

  it("takes name and email from verified claims only", () => {
    const claims = assertGoogleClaims(
      { aud: "aud", iss: "accounts.google.com", exp: 100, sub: "sub-1", email: "real@example.com", email_verified: true, name: "اسم موثّق", nonce: "n" },
      "aud",
      10,
      "n",
    );
    const stored = profileFromVerifiedClaims(claims, { name: "مزور", email: "fake@example.com" });
    expect(stored).toEqual({ googleSub: "sub-1", email: "real@example.com", name: "اسم موثّق" });
  });

  it("keeps the phone unverified until OTP succeeds", () => {
    const phone = normalizePhone("SA", "0512345678");
    expect(phone.ok).toBe(true);
    if (!phone.ok) return;
    const unverified = withUnverifiedPhone(profile, phone.e164);
    expect(profileGate(unverified).locked).toBe(true);
    const pepper = "pepper";
    const issued = issueChallenge("123456", pepper, 1_000, null);
    const failed = verifyChallenge(issued, "000000", pepper, 1_100);
    expect(failed.ok).toBe(false);
    const passed = verifyChallenge(issued, "123456", pepper, 1_100);
    expect(passed.ok).toBe(true);
    if (!passed.ok) return;
    expect(profileGate(withVerifiedPhone(unverified, phone.e164, "2026-10-27T00:00:00Z"))).toEqual({ locked: false });
    expect(() => createOtpProvider({ nodeEnv: "production", provider: "fake", httpUrl: undefined })).toThrow(AppError);
  });

  it("refuses admin APIs to a non-admin", () => {
    expect(isAdmin({ googleSub: "u", email: "u@example.com" }, { subs: ["admin"], emails: [] })).toBe(false);
    const result = evaluateAccess({
      session: { userId: "u" },
      profileComplete: true,
      suspended: false,
      adminRoute: true,
      isAdmin: false,
      turnstileRequired: false,
      turnstileOk: true,
      quotaOk: true,
      modelAllowed: true,
    });
    expect(result).toMatchObject({ code: "not_admin", status: 403 });
  });
});

describe("turnstile", () => {
  const base = {
    token: "token",
    expectedAction: "comparison",
    requestHostname: "chate.example",
    expectedHostnames: ["chate.example"],
    nodeEnv: "production",
    now: Date.parse("2026-10-27T12:00:00Z"),
    remote: { success: true, action: "comparison", hostname: "chate.example", challenge_ts: "2026-10-27T11:58:00.000Z" },
    alreadyUsed: false,
  };

  it("rejects a missing, reused, wrong-action, or wrong-hostname token", () => {
    expect(evaluateTurnstile({ ...base, token: null }).ok).toBe(false);
    expect(evaluateTurnstile({ ...base, alreadyUsed: true })).toMatchObject({ code: "reused" });
    expect(evaluateTurnstile({ ...base, remote: { ...base.remote, action: "upload" } })).toMatchObject({ code: "action" });
    expect(evaluateTurnstile({ ...base, remote: { ...base.remote, hostname: "evil.example" } })).toMatchObject({ code: "hostname" });
    expect(() => assertTurnstileConfig({ nodeEnv: "production", secret: "secret", hostnames: ["localhost"] })).toThrow(AppError);
    expect(() => assertTurnstileConfig({ nodeEnv: "production", secret: "secret", hostnames: ["chate.example"] })).not.toThrow();
    expect(turnstileTokenProblem("")).toBe("missing");
    expect(turnstileTokenProblem("x".repeat(2049))).toBe("shape");
  });

  it("posts siteverify to Cloudflare and rejects a dummy token without accepting the secret check as success", async () => {
    let posted = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      posted = String(init?.body);
      return new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), { status: 200 });
    }) as typeof fetch;
    const remote = await siteverify({ secret: "test-secret", token: "fresh-token", remoteIp: "203.0.113.8", fetchImpl });
    expect(posted).toContain("response=fresh-token");
    expect(posted).toContain("remoteip=203.0.113.8");
    expect(posted).not.toContain("TURNSTILE_SECRET_KEY");
    expect(remote.success).toBe(false);
    const missing = await verifyTurnstileRequest({
      token: "",
      expectedAction: "comparison",
      requestHostname: "localhost",
      expectedHostnames: ["localhost"],
      secret: "test-secret",
      nodeEnv: "development",
      now: base.now,
      alreadyUsed: false,
      fetchImpl,
    });
    expect(missing.ok).toBe(false);
  });
});

describe("comparison", () => {
  it("sends the same question independently and keeps a failure local", async () => {
    const runs = planRuns(draft);
    expect(sameQuestion(runs, draft.question)).toBe(true);
    expect(runs.map((run) => run.modelId)).toEqual(draft.answerModelIds);
    expect(runs.every((run) => run.status === "queued")).toBe(true);
    expect(requestsAreIndependent(runs)).toBe(true);
    expect(runs[0]?.inputLabel).toBe("استقبل الصورة مباشرة");
    expect(runs[1]?.inputLabel).toBe("استقبل النص المستخرج من الصورة");
    const settled = await settleIndependent([async () => "ok", async () => Promise.reject(new Error("x"))]);
    expect(settled[0]?.ok).toBe(true);
    expect(settled[1]?.ok).toBe(false);
    expect(beginIdempotent({ id: "cmp-1", key: "same" }, "same")).toEqual({ duplicate: true, id: "cmp-1" });
  });

  it("does not substitute a model or build a paid route", () => {
    const blocked = planRuns({ ...draft, answerModelIds: ["thinkingmachines/inkling:free"] });
    expect(blocked[0]?.status).toBe("policy_blocked");
    expect(blocked[0]?.request).toBeNull();
    expect(acceptReturnedModel("google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free").ok).toBe(false);
    expect(acceptReturnedModel("openrouter/free", "cohere/north-mini-code:free")).toMatchObject({ displayModelId: "cohere/north-mini-code:free" });
    expect(() => assertSelectable("openai/gpt-4o")).toThrow(AppError);
    expect(() => assertSelectable("google/gemma-4-31b-it")).toThrow(AppError);
    expect(() => assertSelectable("nvidia/nemotron-3-embed-1b:free")).toThrow(AppError);
    const gemma = findModel("google/gemma-4-31b-it:free");
    if (!gemma) throw new Error("missing gemma");
    const body = openRouterChatBody({ model: gemma, messages: [], question: "سؤال", evidenceText: "", userId: draft.userId });
    expect(body.body.model).toBe(gemma.id);
    expect(body.body.models).toBeUndefined();
    expect(String(body.body.model).endsWith(":free")).toBe(true);
  });

  it("does not mix indexes and does not call the blocked embedding default", () => {
    expect(planDefaultEmbedding()).toMatchObject({ ok: false, modelId: "nvidia/nemotron-3.5-embed-1b:free" });
    const embed = findModel("nvidia/nemotron-3.5-embed-1b:free");
    if (!embed) throw new Error("missing embed");
    expect(() => embeddingBody(embed, "text")).toThrow(AppError);
    expect(listPublicModels().some((model) => model.id === "nvidia/nemotron-3-embed-1b:free")).toBe(false);
    expect(indexCompatible(
      { userId: "a", modelId: embed.id, dimensions: 2048, processingVersion: "v1" },
      { userId: "b", modelId: embed.id, dimensions: 2048, processingVersion: "v1" },
    )).toBe(false);
  });
});

describe("MAX_QUALITY_FREE and Haiku", () => {
  it("snapshots Gemma, Flint, Inkling, and Haiku settings", async () => {
    const gemma = findModel("google/gemma-4-31b-it:free");
    const flint = findModel("recursive/flint-v1.0:free");
    const inkling = findModel("thinkingmachines/inkling:free");
    const haiku = findModel("claude-haiku-5-5");
    if (!gemma || !flint || !inkling || !haiku) throw new Error("catalog");
    const gemmaSettings = buildMaxQualityFree(gemma);
    expect(gemmaSettings.reasoning).toEqual({ enabled: true });
    expect(gemmaSettings.labels).toContain("التفكير مفعّل");
    expect(gemmaSettings.labels).not.toContain("أعلى مستوى جهد مدعوم");
    expect(gemmaSettings.sampling).toEqual({ temperature: 1, top_p: 0.95 });
    expect(gemmaSettings.notes).toContain("مستوى الجهد غير قابل للتحقق");
    const flintSettings = buildMaxQualityFree(flint);
    expect(flintSettings.reasoning).toEqual({ enabled: true });
    expect(flintSettings.notes.join(" ")).toContain("إلزامي");
    expect(JSON.stringify(flintSettings.reasoning)).not.toContain("effort");
    const inklingSettings = buildMaxQualityFree(inkling);
    expect(inklingSettings.reasoning).toEqual({ effort: "max" });
    expect(inklingSettings.labels).toContain("أعلى مستوى جهد مدعوم");
    expect(planRuns({ ...draft, answerModelIds: [inkling.id] })[0]?.request).toBeNull();
    const cap31 = completionCap(gemma, estimateTokens("سؤال"));
    const small = findModel("liquid/lfm-2.5-2.6b:free");
    if (!small || !cap31.applicable) throw new Error("cap");
    const capSmall = completionCap(small, estimateTokens("سؤال"));
    if (!capSmall.applicable || capSmall.exceeded) throw new Error("small cap");
    expect(cap31.maxTokens).toBeGreaterThan(capSmall.maxTokens);
    expect(cap31.visibleReserve).toBeLessThan(cap31.maxTokens);
    const request = buildHaikuRequest({ maxTokens: 128000, system: "نظام", content: [{ type: "text", text: "سؤال" }] });
    expect(request.output_config.effort).toBe("medium");
    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request).not.toHaveProperty("temperature");
    expect(buildMaxQualityFree(haiku).notes.join(" ")).toContain("Haiku");
    expect(HAIKU_LIVE_CALLS_ENABLED).toBe(true);
    let postedUrl = "";
    let postedBody = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      postedUrl = url;
      postedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ content: [{ type: "text", text: "جواب" }] }), { status: 200 });
    }) as typeof fetch;
    const sent = await postHaiku(request, { fetchImpl, apiKey: "test-key", allowLive: true });
    expect(postedUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(postedBody).toContain('"effort":"medium"');
    expect(postedBody).not.toContain("test-key");
    expect(sent.status).toBe(200);
    await expect(postHaiku(request, { fetchImpl, apiKey: "test-key", allowLive: false })).rejects.toBeInstanceOf(AppError);
    expect(interpretFinish({ finishReason: "max_tokens", visibleText: "" })).toBe("incomplete");
  });
});

describe("files and safety", () => {
  const limits = { maxEntries: 2, maxDepth: 2, maxUncompressedBytes: 100, maxMemberBytes: 40 };

  it("sniffs content, reports failed pages, and rejects zip slip", () => {
    expect(detectContent(Uint8Array.from([0x25, 0x50, 0x44, 0x46]), "notes.txt")).toBe("pdf");
    expect(officeRoute(detectContent(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), "old.doc"))).toBe("legacy-doc-worker");
    expect(classifyOfficeZip(["word/document.xml"])).toBe("docx");
    expect(parseJsonDocument("{").ok).toBe(false);
    const pages = reportPages([{ page: 1, text: "موجود" }, { page: 2, text: " " }], () => ({ ok: false }));
    expect(pages).toHaveLength(2);
    expect(pages[1]).toMatchObject({ status: "failed", reason: "ocr_failed" });
    expect(inspectZipEntry({ name: "../evil.txt", uncompressedSize: 10 }, limits, { count: 0, bytes: 0 })).toMatchObject({ reason: "path_traversal" });
    expect(inspectZipEntry({ name: "a.txt", uncompressedSize: 80 }, limits, { count: 0, bytes: 0 })).toMatchObject({ reason: "member_size" });
    expect(escapeHtml("<script>alert(1)</script>")).not.toContain("<script>");
    expect(JSON.stringify(redact({ otp: "123456", question: "سري" }))).not.toContain("123456");
    expect(applySafetyResult({ status: "active" }).status).toBe("active");
  });
});

describe("session, quota, and client source", () => {
  it("signs an HttpOnly cookie and reserves quota without substitution", () => {
    const flags = sessionCookie(true);
    expect(flags).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax" });
    const token = signSession({ userId: "u", googleSub: "s", exp: 100, csrf: "c" }, "secret");
    expect(readSession(token, "secret", 10)?.userId).toBe("u");
    expect(readSession(token, "other", 10)).toBeNull();
    const reserved = reserve({
      sharedLimit: 10, sharedUsed: 0, sharedReserved: 0, userLimit: 4, userUsed: 0, userReserved: 0,
      userInFlight: 0, globalInFlight: 0, maxUserConcurrent: 2, maxGlobalConcurrent: 4,
    }, 2);
    expect(reserved.ok).toBe(true);
    expect(retryDecision(2, 429, 1).retry).toBe(false);
    expect(sortRuns([{ modelId: "a", completionMs: 30, rating: 1 }, { modelId: "b", completionMs: 5, rating: 5 }], "speed", ["a", "b"]).label).toBe("حسب السرعة المقاسة");
    expect(cancelLocally({ status: "queued", message: null }).message).toContain("قد لا يتوقف المزود");
    expect(followUpContext("branch", [{ modelId: "a", text: "1" }, { modelId: "b", text: "2" }], "a")).toEqual([{ modelId: "a", text: "1" }]);
    const prompt = buildAnswerPrompt({ question: "سؤال", evidenceText: "دليل", profile: draft.profile });
    expect(prompt.user).not.toContain(draft.profile.phone);
    expect(prompt.user).not.toContain(draft.profile.email);
  });

  it("keeps provider secrets out of client source", () => {
    const roots = [path.join(process.cwd(), "src", "app"), path.join(process.cwd(), "src", "components")];
    const files = roots.flatMap((root) => walk(root));
    const forbidden = ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "TURNSTILE_SECRET_KEY", "sk-or-"];
    for (const file of files) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      const source = readFileSync(file, "utf8");
      for (const needle of forbidden) expect(source.includes(needle)).toBe(false);
    }
    expect(MODEL_CATALOG.filter((model) => model.availability === "متاح" && model.provider === "openrouter").length).toBeGreaterThan(0);
  });
});

function walk(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  } catch {
    return [];
  }
}
