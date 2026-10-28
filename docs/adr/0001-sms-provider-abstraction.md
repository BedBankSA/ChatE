# ADR 0001 — SMS provider abstraction for OTP delivery

**Status:** accepted (2026-10-28) · **Context:** ChatE phone verification

## Context

The OTP flow needs a Saudi SMS gateway. Only one vendor account (4jawaly) is available today, but the owner
asked for a vendor-neutral adapter so the gateway can change without touching the routes, and a development
stub so local work does not spend SMS credit.

The previous code had a single generic HTTP provider (OTP_PROVIDER=http + OTP_HTTP_URL) whose contract
was route-agnostic JSON. That contract stays supported for existing deployments and QA harnesses.

## Decision

- Introduce src/server/sms/adapter.ts with one SmsSender interface: send({ to, code }), where `to` is the
  already-normalized Saudi E.164 value (+9665XXXXXXXX). Each provider converts it to the vendor wire format.
- Providers: FourJawalyProvider (live), TaqnyatProvider, UnifonicProvider, GenericHttpProvider (legacy JSON
  {to, code}), MockDevProvider (dev/test only, never production).
- Selection order in createSmsSender(env): a non-empty legacy OTP_PROVIDER wins (backwards compatibility),
  else SMS_PROVIDER selects the vendor. Unconfigured or unknown fails closed 503 OTP_FAIL_CLOSED.
- Saudi phone normalization lives in src/domain/auth/saudi-phone.ts (pure domain, no Node imports). The route
  stores only the E.164 form; the provider receives the international digits.
- Failure handling is deliberately opaque: every wire failure becomes 502 OTP_PROVIDER with a fixed Arabic
  message; provider bodies, request ids and OTP codes never leave the process.
- Hardening: 10 s timeout, redirect:error, no-store, 64 KiB response cap, endpoint must be https except a
  loopback host outside production, and a blank NODE_ENV is treated as production (fail closed).

## Consequences

- Adding a vendor is a new SmsSender implementation plus one switch case; routes and tests stay unchanged.
- Two config surfaces exist (legacy OTP_PROVIDER and SMS_PROVIDER). A non-empty OTP_PROVIDER overrides
  SMS_PROVIDER, so templates must ship it blank; this is documented in .env.example and deploy/.env.production.example.
- The legacy provider classes in src/domain/auth/otp.ts remain for the offline HTTP tests and existing
  deployments; new code must use the adapter. Removing them is a follow-up cleanup, not a behaviour change.
- No delivery-receipt/status callback integration yet; success means the gateway accepted the message
  (see docs/evidence/sms-live.md).
