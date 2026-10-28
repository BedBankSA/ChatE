[العربية](README.md)

# ChatE

Arabic web app for comparing models. One question, optional files, and answers shown side by side as they arrive. One model failing does not stop the others. The browser does not call OpenRouter or Anthropic; provider keys stay on the server.

## What it does

The workspace at `/workspace` sends the question to the models the user selects, then reads the comparison from the server. Visible shortcuts: conversation (Gemma 4 31B), code (Flint), light (Gemma 4 26B), and a comparison of those three plus Claude Haiku 5.5. This is not a multi-turn chat transcript. `/history` lists the signed-in user's saved comparisons newest first (20 per page) with a read-only detail page at `/history/[id]`, and `GET /api/history` returns the same rows for that account.

File support is implemented. The picker sends real bytes as `multipart/form-data` to `POST /api/uploads` with a Turnstile token (action `upload`). The route requires the session first, then Turnstile, then stores bytes at `STORAGE_DIR/<userId>/<fileId>` with a server-generated path (0700 directory, 0600 file, atomic write); it detects the type from bytes (PDF, PNG, JPEG, GIF, WebP, DOCX, XLSX, ZIP, OLE, text, JSON, CSV, TSV, Markdown, audio, video), computes sha256, and inserts a `files` row with status `stored`. Limits: `MAX_FILE_BYTES` (default 25 MiB) per file, five files per request, 50 MiB total. PDF text is extracted with `unpdf`, DOCX with `mammoth`, and text formats with `decodeText`, then persisted in `documents`/`chunks` with `processing_version=v1`; images have no text and other types record an extraction failure. Comparison creation accepts `attachmentIds` (up to five ids owned by the session user), builds one shared evidence text for all models from the extracted text, sends images natively to image-capable models (≤ 5 MiB), and stores the ids in `evidence_snapshots.payload`. No public download URL exists.

Sign-in uses the official Google Identity Services button. That button opens one account window, then the session is completed with an ID token and a nonce cookie. This identity flow does not use a Google client secret. Turnstile runs in `interaction-only` mode with `execution: execute`: no visible checkbox unless Cloudflare asks for interaction. The server verifies the token once and does not accept reuse.

## Stack

- Next.js 16, React 19, and TypeScript.
- Tailwind CSS 4. Styles live in `src/app/globals.css`.
- shadcn/ui-style packages are dependencies: `class-variance-authority`, `clsx`, `tailwind-merge`, and `@radix-ui/react-slot`. There is no `components.json` and no `src/components/ui`, and application code under `src` does not import those packages.
- SQLite through `node:sqlite` on Node.js 24. One file. Docker and Postgres are not required to run the app.
- `@tanstack/react-table` and `@tremor/react` are declared in `package.json` and are not imported from `src`.

`package.json` sets `"private": true`, so publishing to the npm registry is refused. That is separate from publishing a GitHub repository.

## Run

Node.js 24 is required. On this machine `node` and `npm` may be absent from PATH. The binary used here is `C:\Pak\node.exe`, with `C:\Pak\npm.cmd`.

```powershell
Copy-Item .env.example .env.local
$env:PATH = "C:\Pak;" + $env:PATH
npm install
npm run db:migrate
npm test
npm run dev -- --port 3211
```

Fill `.env.local` locally and do not commit it. If install fails on a TLS certificate, set `$env:NODE_OPTIONS='--use-system-ca'` and run `npm install` again.

Do not start a second dev server if one is already listening on 3211. Do not use port 3000 for ChatE on this machine; that port is another application. The dev origin must be listed in Google Cloud as an authorized JavaScript origin: `http://localhost:3211`.

`npm run build` and then `npm start` produce a production build. After the build, run `npm run check:bundle` to prove no server secret name or value reached the browser bundle. This repository has no durable public deployment. CI lives in `.github/workflows/ci.yml` (Node 24: typegen/typecheck/lint/test/build/check:bundle, no secrets) and does not deploy. A temporary public demo URL can be produced with the Cloudflare quick-tunnel tool `scripts/deploy/public-demo.ps1` (evidence in `docs/evidence/public-deployment.md`); it is not production hosting and does not replace `docs/launch/DEPLOYMENT-RUNBOOK.md`.

`npm run worker` opens the same SQLite file, applies pending migrations, and requeues stale claims. Its loop does not take comparisons and does not call a provider. Comparison execution runs inside the Next.js process.

## Database

`npm run db:migrate` runs `scripts/migrate.ts`. The path comes from `SQLITE_PATH`, default `data/chate.sqlite`, resolved from the project root. The command creates the file when missing and applies every `migrations/*.sql` file in alphabetical order. Present now: `001_init.sql`, then `002_admin.sql`, then `003_security.sql` (Turnstile replay expiry index), then `004_stats.sql` (counter buckets and latency histogram), then `005_indexes.sql` (read-path indexes for runs, sessions, events, and audit lookups), then `006_uploads.sql` (attachment read indexes for documents, chunks, extraction_jobs, and files). Applied names are stored in `schema_migrations`. A second run prints `no pending migrations`. The first time the app server opens the database, it applies pending migrations too.

The operational file and its `-wal`, `-shm`, and `-journal` sidecars are gitignored. Do not delete `data/chate.sqlite` while preparing the repository.

## Backup

SQLite here is a single-writer file. The connection enables WAL. The web process and the worker share the file, and writes are serialized with a busy timeout. The file is not for several machines writing at once.

The app does not ship a backup command. Stop the app and the worker, then copy the file. If `data/chate.sqlite-wal` or `data/chate.sqlite-shm` is still present, copy those sidecars with the main file. The alternative is the SQLite backup API (`backup` or `VACUUM INTO`) instead of copying a file that a writer still has open.

## Environment

Names and empty placeholders are in [`.env.example`](.env.example). Do not put a secret value in Git.

Server secrets, empty in the example:

- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY`
- `SESSION_SECRET`
- `TURNSTILE_SECRET_KEY`
- `OTP_HTTP_AUTHORIZATION`
- `OTP_PEPPER`
- `SMS_API_KEY` and `SMS_API_SECRET` (SMS gateway credentials; for 4jawaly the secret is the HTTP Basic password)

Public values, not secrets:

- `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SITE_KEY`: the public Turnstile site key, already written in the example.
- `GOOGLE_CLIENT_ID` and `NEXT_PUBLIC_GOOGLE_CLIENT_ID`: the same public Google web client id.
- `APP_URL`: `http://localhost:3211` in the example.
- `TURNSTILE_EXPECTED_HOSTNAMES`
- `SQLITE_PATH=data/chate.sqlite`
- `STORAGE_DIR`: private file storage root (default `storage`, gitignored). `DOWNLOAD_URL_TTL_SECONDS` is not read yet because no public download route exists.
- `USER_QUOTA_UNITS`, `SHARED_QUOTA_UNITS`, `MAX_USER_CONCURRENCY`, `MAX_GLOBAL_CONCURRENCY`, `MODEL_TIMEOUT_MS`, and `MAX_PROVIDER_RETRIES`
- Enforced upload limits: `MAX_FILE_BYTES` (default 26214400), five files, and 50 MiB per request. `MAX_ZIP_ENTRIES`, `MAX_ZIP_DEPTH`, and `MAX_ZIP_UNCOMPRESSED_BYTES` are documented but not read yet.
- `SMS_PROVIDER` (`4jawaly`, `taqnyat`, `unifonic`, `generic`, `mock`), `SMS_SENDER_ID`, `SMS_OTP_TEXT`, and optional `SMS_ENDPOINT` (blank = each provider's default endpoint; `generic` requires it or falls back to `OTP_HTTP_URL`). `OTP_PROVIDER`/`OTP_HTTP_URL` stay supported for backwards compatibility and take precedence when non-empty; keep them blank in a real deployment.
- `ADMIN_GOOGLE_SUBS` and `ADMIN_EMAILS`
- `RETENTION_COMPARISON_DAYS` and `RETENTION_FILE_DAYS`

## Models and quotas

Only a model marked available in the catalog, with `policyAllowsTraffic` and `liveNetwork`, may be called. Restricted models stay on `GET /api/models` and in the UI. `executeRun` stores `POLICY_BLOCKED` and does not call `dispatchModel`.

Marked available: `google/gemma-4-31b-it:free`, `recursive/flint-v1.0:free`, `google/gemma-4-26b-a4b-it:free`, `xingchen-agi/xing4.0-29b-a4b:free`, `cohere/north-mini-code:free`, `baseten/mammoth-1:free`, `baseten/elephant-1:free`, `respan/span-01-lite:free`, `openrouter/free`, and `claude-haiku-5-5`.

Restricted, still listed, not called: Super VL, Lightning, Inkling, Inkling Small, Ultra, Nano Omni, LFM2.5, Embed 1B, Embed 8B, LFM embedding, Rerank 8B, Content Safety, and Fish S2.1.

`POST /api/comparisons` plans answer models only. Decision, evaluation, embedding, rerank, and speech models are not sent by that route even when the catalog says available. `openrouter/free` is outside the controlled comparison, and the OpenRouter sender rejects any id that does not end in `:free`. It is not a silent fallback.

Claude Haiku 5.5 is `claude-haiku-5-5` through Anthropic directly at `https://api.anthropic.com/v1/messages`. Thinking is `thinking.type=adaptive` and effort is `output_config.effort=medium`. It is not OpenRouter, and it is not called in place of a free model that failed or is missing. Its cost is a separate Anthropic account from OpenRouter units. Live calls are off by default: Haiku is only sent when `HAIKU_LIVE_CALLS=1` is set explicitly after the owner approves spend. One successful live call was recorded once in release verification (2026-10-28) as documented under "Live evidence"; the environment gate remains the default.

Quota: a comparison with N queued OpenRouter models reserves N OpenRouter units. Haiku is reserved on the `anthropic` provider account and is not drawn from the OpenRouter balance. Example defaults: `USER_QUOTA_UNITS=200` and `SHARED_QUOTA_UNITS=2000`. The numeric limits come from the same environment variables; the accounts are split by provider.

Three old embedding and rerank ids are rejected if requested and are not in the choices: `nvidia/nemotron-3-embed-1b:free`, `nvidia/llama-nemotron-embed-vl-1b-v2:free`, and `nvidia/llama-nemotron-rerank-vl-1b-v2:free`.

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE). Copyright (c) 2026 BedBankSA. Third-party dependency licenses and the model providers' terms still apply.

## Status

Present in code, and covered by tests plus a local production server and live provider verification (see "Live evidence" below):

- The official Google button opens one account window, and session completion works when the client id and `SESSION_SECRET` are set. The dev origin `http://localhost:3211` must be listed in Google Cloud.
- Turnstile widget and server verification when the Turnstile secret is set, including SQLite-backed replay rejection.
- Comparison planning, blocking a restricted model, and the Haiku request shape at effort `medium`, with live Haiku calls gated behind `HAIKU_LIVE_CALLS=1`.
- SQLite migrations, quota reservation, binding a comparison to the session user, and session validation against the stored account (immediate suspension/revocation).
- Phone gate: without a verified number, a model call is not sent.
- Phone verification is implemented: `POST /api/otp/send` and `POST /api/otp/verify` with a hashed challenge, send limits (3 per 15 minutes) and attempt limits (5), plus a two-step UI at `/profile/complete`. The customer may type the mobile in any format (national `05…`/`5…`, international `+966…`/`00966…`/`966…`, Arabic-Indic digits, spaces/dashes); the server always normalizes and stores `+9665XXXXXXXX` only (`src/domain/auth/saudi-phone.ts`). The gateway layer (`src/server/sms/adapter.ts`) supports 4jawaly (live), Taqnyat, Unifonic, generic HTTP and a dev mock, selected by `SMS_PROVIDER` plus credentials. Missing configuration fails closed 503 `OTP_FAIL_CLOSED`; gateway failures are the opaque 502 `OTP_PROVIDER` with no provider text or OTP code.
- Uploads: private byte storage, content-based detection, PDF/DOCX/text extraction, and `attachmentIds` wired into comparison creation with evidence/image delivery to models.
- Real read-only comparison history: `/history`, `/history/[id]`, and `GET /api/history` with account isolation.
- `GET /api/health` liveness/readiness probe (database only, no sensitive data), and `Cache-Control: no-store` on comparison responses.
- MIT license, secret-free CI in `.github/workflows/ci.yml`, and a temporary public-demo tool at `scripts/deploy/public-demo.ps1`.
- Dependency-free browser check tooling: `scripts/qa/run-e2e.mjs` over the Chrome DevTools Protocol, a local mock-provider server `scripts/dev/mock-externals.cjs`, and a release E2E gate at `scripts/qa/verify-release.mjs`.

Not done:

- Admin dashboard. `/admin` is gated by the stored Google session and the `ADMIN_GOOGLE_SUBS`/`ADMIN_EMAILS` allowlist, never by an email typed into the URL. It shows local counters (questions, calls, failures, tokens, files, storage), a user table with no question or answer text, the audit log, and the last four characters of secret versions. `GET /api/admin/overview` returns 401/403 or the admin payload, and `POST /api/admin/users` accepts suspend, restore, or quota changes only with a matching origin and session CSRF. Counters are written from the comparison path into `operation_stats`, `operation_buckets`, and `latency_histogram` (`004_stats.sql`). No presence heartbeat is wired, so the two presence cards report "unavailable" instead of a misleading zero. The page rotates no secrets and sends no external alert.
- A real SMS was sent through 4jawaly to the owner-approved `+966564106506` (test input `0564106506`) and the full `send` → gateway → `verify` → `phone_verified_at` round-trip completed (evidence: `docs/evidence/sms-live.md`, live test: `tests/sms-live.test.ts`). Not yet integrated: automated handset delivery-receipt proof, real-browser verification, and live credentials for Taqnyat/Unifonic (unit-tested only).
- No durable public deployment, domain, production TLS, or payments. The temporary Cloudflare quick-tunnel demo is presentation tooling, not production hosting (B2).
- No live call is claimed beyond what is recorded under "Live evidence" with a named provider and date.
- Uploads are implemented, but a public download route, file deletion, and `RETENTION_FILE_DAYS` enforcement are not; the code does not read `DOWNLOAD_URL_TTL_SECONDS` or `MAX_ZIP_*` yet.
- Account deletion has no route yet, and `retention_settings` is not enforced by a periodic worker.
- There is no Playwright suite; browser checking in this repository uses the in-repo CDP scripts under `scripts/qa`.

## Live evidence

- **Live provider calls (2026-10-28):** a full comparison ran through a local production server against the real network. `claude-haiku-5-5` returned a real completion (433 input / 6 output tokens, 1935 ms, $0.000046), and `cohere/north-mini-code:free` returned a real completion (178/152 tokens, 2678 ms). Two other free models failed with provider 429 and did not prevent the others from completing. Raw evidence: `docs/evidence/live-provider-calls.md` and `docs/evidence/release-verification-2026-10-28T14-06-54-260Z.json`. Stated limits: Turnstile passed via a QA token rather than a browser widget, the session was seeded rather than Google sign-in, and OTP used a local HTTP stub rather than a carrier SMS gateway.
- **Live SMS gateway (2026-10-28):** three real messages were sent through 4jawaly to `+966564106506` (sender `BedBank`). Raw probe: HTTP 200, `code=200`, `success_count=1`, `error_count=0` (job `0460f882-d2dc-11f1-a7fe-f587caf486fb`). Full live test: input `0564106506` → normalized `+966564106506` → real SMS → code recovered from the local peppered hash → `verify` → `phone_verified_at` (1/1 PASS in 2.7 s). Evidence: `docs/evidence/sms-live.md`.
- **Release verification (mock + live):** `scripts/qa/verify-release.mjs` runs 14 probes (13 PASS + 1 SKIP for optional browser smoke) in both modes: health and headers, catalog, anonymous 401s, Turnstile (missing/bad/replayed), real loopback-HTTP OTP through `phone_verified_at`, real txt/pdf/png uploads, an attachment comparison with four independently settled runs, database evidence binding, `/history` list and `/history/[id]` detail, IDOR isolation, and secret redaction. Raw evidence: `docs/evidence/release-verification-*.json`.
- **CI:** `.github/workflows/ci.yml` runs typegen/typecheck/lint/test/build/check:bundle with no secrets. Durable public deployment remains unimplemented (B2); the temporary demo is not counted as a deployment.
