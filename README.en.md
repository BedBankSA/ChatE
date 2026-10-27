[العربية](README.md)

# ChatE

Arabic web app for comparing models. One question, optional files, and answers shown side by side as they arrive. One model failing does not stop the others. The browser does not call OpenRouter or Anthropic; provider keys stay on the server.

## What it does

The workspace at `/workspace` sends the question to the models the user selects, then reads the comparison from the server. Visible shortcuts: conversation (Gemma 4 31B), code (Flint), light (Gemma 4 26B), and a comparison of those three plus Claude Haiku 5.5. This is not a multi-turn chat transcript. `/history` is explanatory text and does not list saved rows.

File support is partial. Domain code detects type from bytes: PDF, PNG, JPEG, GIF, WebP, DOCX, XLSX, ZIP, OLE, text, JSON, CSV, TSV, Markdown, audio, and video. The picker posts file names only to `POST /api/uploads`. That route checks Turnstile and then returns 401. It does not store bytes. Creating a comparison passes empty attachments.

Sign-in uses the Google Identity Services button and an ID token, with a nonce cookie. This identity flow does not use a Google client secret. Turnstile runs in `interaction-only` mode with `execution: execute`: no visible checkbox unless Cloudflare asks for interaction. The server verifies the token once and does not accept reuse.

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

Do not start a second dev server if one is already listening on 3211. Do not use port 3000 for ChatE on this machine; that port is another application. The Google authorized JavaScript origin must match the origin actually used. Locally that is `http://localhost:3211`.

`npm run build` and then `npm start` produce a production build. This repository has no public deployment.

`npm run worker` opens the same SQLite file, applies pending migrations, and requeues stale claims. Its loop does not take comparisons and does not call a provider. Comparison execution runs inside the Next.js process.

## Database

`npm run db:migrate` runs `scripts/migrate.ts`. The path comes from `SQLITE_PATH`, default `data/chate.sqlite`, resolved from the project root. The command creates the file when missing and applies every `migrations/*.sql` file in alphabetical order. Present now: `001_init.sql`, then `002_admin.sql`. Applied names are stored in `schema_migrations`. A second run prints `no pending migrations`. The first time the app server opens the database, it applies pending migrations too.

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

Public values, not secrets:

- `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SITE_KEY`: the public Turnstile site key, already written in the example.
- `GOOGLE_CLIENT_ID` and `NEXT_PUBLIC_GOOGLE_CLIENT_ID`: the same public Google web client id.
- `APP_URL`: `http://localhost:3211` in the example.
- `TURNSTILE_EXPECTED_HOSTNAMES`
- `SQLITE_PATH=data/chate.sqlite`
- `STORAGE_DIR` and `DOWNLOAD_URL_TTL_SECONDS`
- `USER_QUOTA_UNITS`, `SHARED_QUOTA_UNITS`, `MAX_USER_CONCURRENCY`, `MAX_GLOBAL_CONCURRENCY`, `MODEL_TIMEOUT_MS`, and `MAX_PROVIDER_RETRIES`
- Upload limits: `MAX_FILE_BYTES`, `MAX_ZIP_ENTRIES`, `MAX_ZIP_DEPTH`, and `MAX_ZIP_UNCOMPRESSED_BYTES`
- `OTP_PROVIDER` and `OTP_HTTP_URL`
- `ADMIN_GOOGLE_SUBS` and `ADMIN_EMAILS`
- `RETENTION_COMPARISON_DAYS` and `RETENTION_FILE_DAYS`

## Models and quotas

Only a model marked available in the catalog, with `policyAllowsTraffic` and `liveNetwork`, may be called. Restricted models stay on `GET /api/models` and in the UI. `executeRun` stores `POLICY_BLOCKED` and does not call `dispatchModel`.

Marked available: `google/gemma-4-31b-it:free`, `recursive/flint-v1.0:free`, `google/gemma-4-26b-a4b-it:free`, `xingchen-agi/xing4.0-29b-a4b:free`, `cohere/north-mini-code:free`, `baseten/mammoth-1:free`, `baseten/elephant-1:free`, `respan/span-01-lite:free`, `openrouter/free`, and `claude-haiku-5-5`.

Restricted, still listed, not called: Super VL, Lightning, Inkling, Inkling Small, Ultra, Nano Omni, LFM2.5, Embed 1B, Embed 8B, LFM embedding, Rerank 8B, Content Safety, and Fish S2.1.

`POST /api/comparisons` plans answer models only. Decision, evaluation, embedding, rerank, and speech models are not sent by that route even when the catalog says available. `openrouter/free` is outside the controlled comparison, and the OpenRouter sender rejects any id that does not end in `:free`. It is not a silent fallback.

Claude Haiku 5.5 is `claude-haiku-5-5` through Anthropic directly at `https://api.anthropic.com/v1/messages`. Thinking is `thinking.type=adaptive` and effort is `output_config.effort=medium`. It is not OpenRouter, and it is not called in place of a free model that failed or is missing. Its cost is a separate Anthropic account from OpenRouter units. This document does not claim a live call succeeded.

Quota: a comparison with N queued OpenRouter models reserves N OpenRouter units. Haiku is reserved on the `anthropic` provider account and is not drawn from the OpenRouter balance. Example defaults: `USER_QUOTA_UNITS=200` and `SHARED_QUOTA_UNITS=2000`. The numeric limits come from the same environment variables; the accounts are split by provider.

Three old embedding and rerank ids are rejected if requested and are not in the choices: `nvidia/nemotron-3-embed-1b:free`, `nvidia/llama-nemotron-embed-vl-1b-v2:free`, and `nvidia/llama-nemotron-rerank-vl-1b-v2:free`.

## License

A license for this project has not been selected. Do not assume an open-source license because the repository exists. Third-party dependency licenses and the model providers' terms still apply.

## Status

Present in code, and covered by logic tests plus a temporary database file, without a live provider:

- Google button and session completion when the client id and `SESSION_SECRET` are set.
- Turnstile widget and server verification when the Turnstile secret is set.
- Comparison planning, blocking a restricted model, and the Haiku request shape at effort `medium`.
- SQLite migrations, quota reservation, and binding a comparison to the session user.
- Phone gate: without a verified number, a model call is not sent.

Not done:

- Admin dashboard. `/admin` is a static paragraph, and `GET /api/admin/overview` always returns 401 without reading a session. No page shows users, usage, or API keys. Unwired server code exists: an account query returns name, email, phone, city, and counters without question text; `002_admin.sql` adds operation tables without message text or file names; the secret-status view exposes the last four characters. `stripPrivateKeys` drops keys such as `question` and `output_text`. `npm test` does not cover these files, so the rule and the dashboard are not done.
- Real SMS is not configured. The example sets `OTP_PROVIDER=fake`, and production rejects anything other than `http`. Even with `OTP_PROVIDER=http` and a send URL, `POST /api/otp/send` reports that a real send is not enabled. Model calls stay blocked until the phone is verified.
- The Google origin must include the port actually used: `http://localhost:3211` locally, because 3000 is another application.
- No public deployment.
- This preparation does not claim a live OpenRouter or Anthropic success. No test observed here performed one.
- Uploading, storing, and attaching files to the question is unfinished. The `storage` directory is configured and gitignored.
- Comparison history and account deletion are page text, with no route that performs deletion.
- Playwright tests are not part of the checks run for this preparation.
