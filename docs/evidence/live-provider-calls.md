# Live provider calls — evidence

**Date:** 2026-10-28T14:06:54.260Z (run 2026-10-28T14-06-48-361Z)
**Mode:** live — `providerCallsReal: true` (real OpenRouter + Anthropic network calls)
**Build:** `vMZH_347l9JjLHbF8SvV8` built 2026-10-28T14:06:06.393Z
**Server:** production `next start` on 127.0.0.1:3222 with `Host: chate.test:3222`
**Comparison:** `384d078d-6c90-454b-a026-104db44a82bd` (attempts: 1)
**Turnstile:** QA `qa.*` token preload (not a browser widget) — see caveats.
**Session:** seeded HMAC session cookie (no Google sign-in).
**OTP:** real HTTPS POST over loopback to the local OTP provider stub (throwaway self-signed QA cert; no carrier SMS gateway).
**Command:** `C:\Pak\node.exe scripts/qa/verify-release.mjs --mode=live` (harness spawned the production server and cleaned it up).

## What this proves

- Anthropic `claude-haiku-5-5` returned a real completion: status **completed**, tokens 433 in / 6 out, cost $0.000046, 1935 ms, finish `end_turn`.
- OpenRouter `cohere/north-mini-code:free` returned a real completion: status **completed**, tokens 178 in / 152 out, 2678 ms, finish `stop`.
- The comparison question was «ما عاصمة الأردن؟ … اعتمادًا على الأدلة المرفقة» with 3 real uploaded attachments (txt+pdf+png, attachment ids bound in `evidence_snapshots.payload`). Both completed models returned the real answer «عمّان» — not a mock/fallback string.
- All 4 runs settled independently: `claude-haiku-5-5:completed, cohere/north-mini-code:free:completed, recursive/flint-v1.0:free:failed, google/gemma-4-31b-it:free:failed`. The two failures are upstream OpenRouter `RATE_LIMIT` (429) responses and did not break the other runs — that is the product behavior the gate expects.
- No mock marker text (`إجابة تجريبية`) appeared in any live output, and the evidence JSON records `providerCallsReal: true`.
- **This closes the previously verified documentation gap** ("no successful live OpenRouter/Anthropic call has ever been observed"): both providers are now observed working against this build, with model ids, token counts, cost, timings, and output excerpts recorded.

## Run table

| model | provider | status | finish | prompt tok | completion tok | cost USD | ms | output excerpt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claude-haiku-5-5` | anthropic | completed | end_turn | 433 | 6 | 0.000046 | 1935 | `عمّان` |
| `cohere/north-mini-code:free` | openrouter | completed | stop | 178 | 152 | — | 2678 | `عمّان` |
| `recursive/flint-v1.0:free` | openrouter | failed | — | — | — | — | 3269 | `` |
| `google/gemma-4-31b-it:free` | openrouter | failed | — | — | — | — | 3245 | `` |

## Honest caveats

- Turnstile was satisfied via the QA `qa.*` token preload, not a real browser widget; a real Cloudflare rejection path is still exercised for invalid tokens.
- Sessions were seeded signed cookies; no Google OAuth sign-in was performed.
- OTP/SMS delivery is a real HTTPS request over loopback to the local provider stub; no carrier gateway account exists in this environment, so no real SMS was sent.
- Some free OpenRouter models may fail with upstream 429/RATE_LIMIT; those failures are recorded above and are expected product behavior (one provider's failure must not break the others).
- No API key values were printed or stored; only model ids, token counts, costs, timings, and short output excerpts are recorded.

## Raw evidence

- Live run (all probes, redacted): `docs/evidence/release-verification-2026-10-28T14-06-54-260Z.json` (`mode: live`, `providerCallsReal: true`, 13 PASS / 0 FAIL / 1 SKIP).
- Mock run (same gate with providers mocked): `docs/evidence/release-verification-2026-10-28T14-06-35-947Z.json` (`mode: mock`, `providerCallsReal: false`, 13 PASS / 0 FAIL / 1 SKIP).
- Harness: `scripts/qa/verify-release.mjs` + `scripts/qa/turnstile-preload.cjs` / `scripts/qa/mock-provider-preload.cjs`.
