// QA-only preload for MOCK-mode release verification. Loaded in the production
// server process with NODE_OPTIONS=--require <this file>. It:
//   1. installs scripts/qa/turnstile-preload.cjs (qa.* Turnstile tokens only), and
//   2. when CHATE_E2E_MOCK=1, mocks ONLY the two paid providers:
//        - https://openrouter.ai/api/v1/chat/completions
//        - https://api.anthropic.com/v1/messages
//      with obviously-marked Arabic mock responses that carry the marker
//      "إجابة تجريبية" so live evidence can assert the marker is ABSENT.
// Every other fetch (OTP loopback HTTP, Cloudflare, etc.) stays real. Mock mode
// never needs real provider keys: the harness configures throwaway dummy keys.
"use strict";

require("./turnstile-preload.cjs");

if (!globalThis.__chateQaMockProviders) {
  globalThis.__chateQaMockProviders = true;

  const innerFetch =
    typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
  const mockProviders = process.env.CHATE_E2E_MOCK === "1";
  const MOCK_MARKER = "إجابة تجريبية";

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

  function jsonResponse(payload) {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  globalThis.fetch = async function chateQaMockProviderFetch(input, init) {
    try {
      const url = toUrl(input);
      if (mockProviders && url.startsWith("https://openrouter.ai/api/v1/chat/completions")) {
        let request = {};
        try {
          request = JSON.parse(bodyText(init) || "{}");
        } catch {
          request = {};
        }
        return jsonResponse({
          id: "gen-qa-mock-" + Date.now(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: typeof request.model === "string" ? request.model : "mock/free",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: MOCK_MARKER + " — رد وهمي محلي من OpenRouter للاختبار فقط، وليس استجابة نموذج حقيقي.",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 48, completion_tokens: 32, total_tokens: 80 },
        });
      }
      if (mockProviders && url.startsWith("https://api.anthropic.com/v1/messages")) {
        return jsonResponse({
          id: "msg_qa_mock",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [
            {
              type: "text",
              text: MOCK_MARKER + " — رد وهمي محلي من Anthropic للاختبار فقط، وليس استجابة نموذج حقيقي.",
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 27, output_tokens: 4 },
        });
      }
    } catch {
      // Fall through to the real fetch on any parsing surprise.
    }
    if (!innerFetch) throw new TypeError("fetch is not available");
    return innerFetch(input, init);
  };

  if (mockProviders) {
    process.stderr.write(
      "[qa-mock-preload] OpenRouter + Anthropic mocked (CHATE_E2E_MOCK=1); Turnstile qa.* accepted; all other fetch real\n",
    );
  } else {
    process.stderr.write("[qa-mock-preload] CHATE_E2E_MOCK!=1: provider mocking inactive\n");
  }
}
