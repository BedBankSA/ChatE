# deploy/ — launch artifacts for ChatE

These artifacts are consistent with the app as it exists on 2026-10-28:
`npm run db:migrate`, `npm run worker`, `npm start` (`next start`),
port **3211**, `SQLITE_PATH`, `STORAGE_DIR`, and Node **24**.

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage Node 24 image, non-root, `next start`; no standalone output because next.config.ts is not modified. |
| `docker-compose.yml` | web + worker + named SQLite volume, loopback-bound port, healthchecks, log rotation. |
| `Caddyfile` | Automatic-TLS reverse proxy (recommended). |
| `nginx.conf` | nginx + certbot alternative. |
| `systemd/chate-web.service` | Native systemd web unit (recommended profile). |
| `systemd/chate-worker.service` | Native systemd worker unit. |
| `.env.production.example` | Production env template, all secrets empty. |
| `scripts/backup.sh` | Online SQLite backup (sqlite3 `.backup` or node `VACUUM INTO`), integrity check, checksum, retention, optional storage archive. |
| `scripts/restore.sh` | Verified restore with pre-restore copy, migration, health check. |

Related release tooling outside this directory:
[`scripts/deploy/public-demo.ps1`](../scripts/deploy/public-demo.ps1) (temporary public
demo evidence) and [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) (CI quality
gates; it does not deploy).

The authoritative procedure, capacity thresholds, incident runbook and rollback
steps are in [`docs/launch/DEPLOYMENT-RUNBOOK.md`](../docs/launch/DEPLOYMENT-RUNBOOK.md).

## Temporary public demo (no account, no VPS)

A reproducible, **non-durable** public URL can be produced on the Windows dev box with a
Cloudflare quick tunnel (`*.trycloudflare.com`, no Cloudflare account needed):

```powershell
# from the repository root; add -Build after code changes so the demo serves current code
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy\public-demo.ps1 -Build
# prints the public URL and writes docs/evidence/public-deployment.md

# stop the local production server + tunnel recorded by that run
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy\public-demo.ps1 -Stop
```

The script loads `.env.local` into the child process environment without printing values,
starts `next start` on `127.0.0.1:3223`, downloads `cloudflared.exe` into `.tools/` only
when it is missing, and probes the public origin plus the local server.

**What it proves:** the production build serves the Arabic RTL pages, `/privacy`,
`/terms` and `GET /api/models` over public HTTPS through the Cloudflare edge, with
HSTS/CSP/COOP headers and anonymous API rejection intact.

**What it does not prove:** durable hosting, a product domain, TLS certificate
management, uptime, capacity, or end-to-end product flows. Quick tunnels are ephemeral
and unsuitable for production. `NEXT_PUBLIC_*` values are baked at build time, so a
throwaway hostname cannot be an authorized Google OAuth origin or a registered Turnstile
widget hostname; sign-in and Turnstile-gated interactions fail closed there. See
[`docs/evidence/deployment-readiness.md`](../docs/evidence/deployment-readiness.md) for
the proven vs. owner-gated split.

## Durable deployment (owner-gated)

The durable path remains the VPS procedure:
[`docs/launch/DEPLOYMENT-RUNBOOK.md`](../docs/launch/DEPLOYMENT-RUNBOOK.md) (systemd +
Caddy + Cloudflare, or the Docker Compose profile above), with staging, TLS, backups,
monitoring and production provider/Turnstile/SMS credentials supplied by the owner.
CI proves the committed tree builds and tests; it does not deploy.

No durable public deployment has been performed; these files are reviewed, not executed
against a live VPS in this repository. A temporary quick-tunnel demo can be generated as
above; that run's evidence lives in `docs/evidence/public-deployment.md`.

