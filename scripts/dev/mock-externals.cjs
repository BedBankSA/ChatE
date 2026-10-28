// Test-only preload for local end-to-end runs. Loaded with:
//   NODE_OPTIONS=--require ./scripts/dev/mock-externals.cjs CHATE_E2E_MOCK=1 npm start
// It is never imported by the application build. It exists so QA can exercise
// the real UI and APIs against the production build without spending provider
// money or depending on Cloudflare/Anthropic/OpenRouter uptime.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const realFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
const mockProviders = process.env.CHATE_E2E_MOCK === "1";
const otpUrl = (process.env.OTP_HTTP_URL || "").trim();
const otpLog = process.env.CHATE_E2E_OTP_LOG || path.join(process.cwd(), "tmp", "otp-codes.jsonl");

function toUrl(input) {
  if (typeof input === "string") return input;
  if (input && typeof input.url === "string") return input.url;
  try {
    return String(input);
  } catch {
    return "";
  }
}

function bodyText(init) {
  const body = init && init.body;
  if (typeof body === "string") return body;
  if (body && typeof body.toString === "function") return body.toString();
  return "";
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function recordOtp(text) {
  try {
    const parsed = JSON.parse(text || "{}");
    if (!parsed || typeof parsed.code !== "string") return;
    fs.mkdirSync(path.dirname(otpLog), { recursive: true });
    fs.appendFileSync(otpLog, JSON.stringify({ to: parsed.to, code: parsed.code, at: new Date().toISOString() }) + "\n", "utf8");
  } catch {
    // A malformed provider payload is ignored; the real provider path is untouched.
  }
}

function turnstilePayload(token) {
  // qa.<action>.<hostname>.<epochMs> is the only token shape this harness accepts.
  const parts = token.split(".");
  const action = parts[1] || "";
  // The hostname itself contains dots, so everything between the action and the
  // final timestamp segment is the hostname.
  const hostname = parts.slice(2, -1).join(".") || "chate.test";
  const issued = Number(parts[parts.length - 1]);
  return {
    success: true,
    action,
    hostname,
    challenge_ts: new Date(Number.isFinite(issued) ? issued : Date.now()).toISOString(),
    "error-codes": [],
  };
}

globalThis.fetch = async function chateMockFetch(input, init) {
  try {
    const url = toUrl(input);
    if (url.startsWith("https://challenges.cloudflare.com/turnstile/v0/siteverify")) {
      const token = new URLSearchParams(bodyText(init)).get("response") || "";
      if (token.startsWith("qa.")) return jsonResponse(turnstilePayload(token));
      // Real tokens from a real widget still go to Cloudflare.
    }
    if (mockProviders && url.startsWith("https://openrouter.ai/api/v1/chat/completions")) {
      let request = {};
      try {
        request = JSON.parse(bodyText(init) || "{}");
      } catch {
        request = {};
      }
      return jsonResponse({
        id: "gen-e2e-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: typeof request.model === "string" ? request.model : "mock/free",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "إجابة تجريبية من مزود وهمي محلي (ليست استجابة نموذج حقيقي). الغرض منها اختبار الواجهة والمسار فقط.",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 48, completion_tokens: 32, total_tokens: 80 },
      });
    }
    if (mockProviders && url.startsWith("https://api.anthropic.com/v1/messages")) {
      return jsonResponse({
        id: "msg_e2e",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [{ type: "text", text: "إجابة تجريبية محلية من مزود Anthropic الوهمي." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 8 },
      });
    }
    if (otpUrl && url.split("?")[0] === otpUrl.split("?")[0]) {
      recordOtp(bodyText(init));
      return jsonResponse({ ok: true });
    }
  } catch {
    // Fall through to the real fetch so only the intended hosts are mocked.
  }
  if (!realFetch) throw new TypeError("fetch is not available");
  return realFetch(input, init);
};

if (mockProviders) {
  process.stderr.write("[e2e-mock] provider calls mocked; Turnstile qa.* tokens accepted\n");
  if (otpUrl) process.stderr.write("[e2e-mock] OTP codes appended to " + otpLog + "\n");
}
