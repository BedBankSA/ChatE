# Live SMS gateway — evidence (4jawaly)

**Date:** 2026-10-28 (local Etc/GMT-3) · **Provider:** 4jawaly · **Sender:** BedBank
**Endpoint:** POST https://api-sms.4jawaly.com/api/v1/account/area/sms/send (HTTP Basic auth)
**Recipient:** owner-approved test number +966564106506 (customer input example 0564106506)
**Credentials:** server-only, configured in the gitignored .env.local; never printed, never committed.
**SMS count:** 3 real messages were sent by this evidence work (1 raw probe + 2 full OTP E2E runs: initial integration and final-tree re-run).

## What was executed

1. **Raw gateway probe** with the owner-provided account (one request, one SMS):

       request body: {"messages":[{"text":"ChatE: رمز التحقق 123456 — اختبار ربط مزود الرسائل","numbers":["966564106506"],"number_iso":"SA","sender":"BedBank"}]}

   Response: **HTTP 200** application/json in 1862 ms:

       {"code":200,"message":"تم حفظ الرسائل بنجاح","messages":[{"job_id":"0460f882-d2dc-11f1-a7fe-f587caf486fb","success_count":1,"error_count":0,"duplicated_count":0,"total_cost":1}],"job_id":"0460f882-d2dc-11f1-a7fe-f587caf486fb","request_id":"req_6ae206d74b46e4.14574979"}

2. **Negative probe** with deliberately wrong Basic credentials (sends nothing):

       HTTP 400 {"code":400,"message":"...","is_token_expired":true}

   The adapter maps this and every non-success envelope to the opaque OTP_PROVIDER 502 without
   copying provider text, request ids or the OTP code.

3. **Live end-to-end OTP test** — tests/sms-live.test.ts (LIVE-gated, SMS_LIVE_TEST=1):
   route POST /api/otp/send with raw input 0564106506 → normalizeSaudiMobile → stored +966564106506 →
   real SMS through 4jawaly → code recovered from the peppered SHA-256 challenge hash (local 10^6 brute
   force, the test owns the pepper) → POST /api/otp/verify → profiles.phone_verified_at set.

   Result (first run 2026-10-28T14:43Z): **1/1 test passed in 2.7 s**

       [sms-live] PASS: real SMS sent via 4jawaly for raw '0564106506', stored +966564106506,
       code verified, profile verified_at=2026-10-28T14:43:16.743Z

   Final-tree re-run after the verification LOW-finding fixes (2026-10-28T14:51Z): **1/1 passed in 2.4 s**

       [sms-live] PASS: real SMS sent via 4jawaly for raw '0564106506', stored +966564106506,
       code verified, profile verified_at=2026-10-28T14:51:18.695Z

## What this proves

- The 4jawaly account, Basic credentials and BedBank sender are valid and accept a Saudi mobile in the
  provider-required international form (9665XXXXXXXX, no leading +).
- The customer-facing contract works: the customer can type the number in any accepted spelling; the system
  stores **only** +9665XXXXXXXX and the gateway receives the international digits.
- The OTP flow is live end to end: send route → adapter → carrier gateway → stored challenge → verify route →
  verified profile. Rate limiting, hashing and single-use consumption are the repository's existing ones.
- Failure handling is real: bad credentials surface to the browser only as the opaque Arabic 502.

## Honest caveats

- The provider success envelope proves **acceptance by the gateway** (success_count=1), not a delivery receipt
  from the handset; no delivery-status callback is integrated, and the automated check does not read the
  owner's phone. The owner received the message on the test number.
- The live test seeds an HMAC session cookie and satisfies Turnstile via the repository's QA token preload: it
  proves the server/API flow, not a browser click-through on the real widget.
- Only 3 SMS were sent. Taqnyat / Unifonic / generic gateway adapters are unit-tested against an injected fake
  fetch; no credentials exist for those vendors, so they are not live-verified (documented in code and .env.example).
- Credentials live in .env.local only. Rotate them in the 4jawaly dashboard if they were ever exposed outside
  the server. .env.example / deploy/.env.production.example contain names with empty values only.

## How to re-run

    # .env.local must contain (server-only): SESSION_SECRET, OTP_PEPPER (or SESSION_SECRET fallback),
    # SMS_PROVIDER=4jawaly, SMS_API_KEY, SMS_API_SECRET, SMS_SENDER_ID=BedBank
    $env:PATH = "C:\\Pak;" + $env:PATH
    $env:SMS_LIVE_TEST = "1"
    & 'C:\\Pak\\npm.cmd' exec -- vitest run tests/sms-live.test.ts

Without SMS_LIVE_TEST=1 the test is reported as skipped by the normal npm test run, so CI stays offline and
spends no SMS credit.

## Related artifacts

- Adapter: src/server/sms/adapter.ts (FourJawalyProvider, TaqnyatProvider, UnifonicProvider,
  GenericHttpProvider, MockDevProvider, createSmsSender).
- Normalizer: src/domain/auth/saudi-phone.ts (normalizeSaudiMobile).
- Route wiring: src/app/api/otp/send/route.ts, src/domain/auth/model-gate.ts.
- Offline tests: tests/sms-adapter.test.ts (67), tests/saudi-phone-normalizer.test.ts (33),
  tests/otp-route.test.ts, tests/model-gate-sms.test.ts.
