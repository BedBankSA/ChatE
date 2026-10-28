// QA-only preload for release verification. Loaded in the production server
// process with NODE_OPTIONS=--require <this file>. It intercepts EXACTLY ONE
// external call: Cloudflare Turnstile siteverify, and only when the submitted
// response token starts with "qa." (the documented QA token shape
// qa.<action>.<hostname>.<epochMs>). Every other fetch call passes through to
// the real network, so live OpenRouter/Anthropic traffic and real loopback OTP
// provider HTTP calls remain real.
//
// This file is never imported by the application build. It is the QA analogue of
// scripts/dev/mock-externals.cjs without that preload's OTP/provider mocking.
"use strict";

if (!globalThis.__chateQaTurnstilePreload) {
  globalThis.__chateQaTurnstilePreload = true;

  const realFetch =
    typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
  const SITEVERIFY_PREFIX = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

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

  // Mirror of the QA token parser in scripts/dev/mock-externals.cjs: the
  // hostname itself contains dots, so the action is segment 2 and the hostname
  // is everything between it and the trailing epoch timestamp.
  function turnstilePayload(token) {
    const parts = token.split(".");
    const action = parts[1] || "";
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

  globalThis.fetch = async function chateQaPreloadFetch(input, init) {
    try {
      const url = toUrl(input);
      if (url.startsWith(SITEVERIFY_PREFIX)) {
        const token = new URLSearchParams(bodyText(init)).get("response") || "";
        if (token.startsWith("qa.")) return jsonResponse(turnstilePayload(token));
        // Any non-QA token falls through to Cloudflare so the server still
        // performs a real rejection path for bad/replayed tokens.
      }
    } catch {
      // Fall through to the real fetch on any parsing surprise.
    }
    if (!realFetch) throw new TypeError("fetch is not available");
    return realFetch(input, init);
  };

  process.stderr.write(
    "[qa-turnstile-preload] qa.* Turnstile tokens accepted; all other fetch calls pass through\n",
  );
}
