# Public deployment evidence - ChatE (temporary Cloudflare quick tunnel)

Generated: 2026-10-28T16:28:08Z (UTC). **Verdict: PASS** (13 PASS / 0 FAIL).

> TEMPORARY public URL from a Cloudflare quick tunnel. It is not durable production hosting, has no SLA, and stops working when the process stops. It is not a substitute for docs/launch/DEPLOYMENT-RUNBOOK.md.

| Field | Value |
| --- | --- |
| Public URL | https://diana-middle-kings-doug.trycloudflare.com |
| Local origin | http://127.0.0.1:3223 (pid 31772) |
| Tunnel | cloudflared version 2026.10.5 (built 2026-10-27T06:05 UTC) (pid 30572) |
| Production build | BUILD_ID=jR_rtk3Nwwq9EaAV5J_XZ |
| Node | v24.22.1 |
| Method | curl.exe from the build machine; same checks as scripts/deploy/public-demo.ps1; origin built and started on current source |

## Checks

| Check | Target | Observed | Result |
| --- | --- | --- | --- |
| root HTTP 200 | https://diana-middle-kings-doug.trycloudflare.com/ | HTTP 200 | PASS |
| root Arabic RTL shell | https://diana-middle-kings-doug.trycloudflare.com/ | dir="rtl" present | PASS |
| GET /api/models 200 + ok:true | https://diana-middle-kings-doug.trycloudflare.com/api/models | HTTP 200; ok=True | PASS |
| GET /privacy -> 200 | https://diana-middle-kings-doug.trycloudflare.com/privacy | HTTP 200 | PASS |
| GET /terms -> 200 | https://diana-middle-kings-doug.trycloudflare.com/terms | HTTP 200 | PASS |
| GET /api/admin/overview -> 401 | https://diana-middle-kings-doug.trycloudflare.com/api/admin/overview | HTTP 401 | PASS |
| GET /api/history -> 401 | https://diana-middle-kings-doug.trycloudflare.com/api/history | HTTP 401 | PASS |
| anonymous POST /api/comparisons -> 401 | https://diana-middle-kings-doug.trycloudflare.com/api/comparisons | HTTP 401 | PASS |
| anonymous POST /api/uploads -> 401/403 | https://diana-middle-kings-doug.trycloudflare.com/api/uploads | HTTP 401 | PASS |
| HSTS present | response header | present | PASS |
| CSP present without unsafe-eval | response header | present | PASS |
| X-Frame-Options DENY | response header | DENY | PASS |
| x-powered-by absent | response header | absent | PASS |

## What this proves

- This exact production build (BUILD_ID=jR_rtk3Nwwq9EaAV5J_XZ) is reachable over public HTTPS from the internet through the Cloudflare edge (no account, ephemeral hostname).
- The Arabic RTL landing page, /privacy, /terms and GET /api/models (200, "ok":true) render anonymously.
- Anonymous API access stays closed: admin/history 401, comparisons 401, uploads 401/403.
- Production security headers are present publicly: HSTS, CSP without unsafe-eval, X-Frame-Options DENY, no x-powered-by.

## What this does NOT prove (honest limitations)

- **No durable hosting**: a quick tunnel is ephemeral; the URL dies with the process. Production still needs the VPS + Caddy + Cloudflare path in docs/launch/DEPLOYMENT-RUNBOOK.md.
- **No product domain / owned DNS / managed TLS**: TLS here is Cloudflare's edge certificate for *.trycloudflare.com.
- **Google sign-in is expected NOT to work on this origin** (the baked NEXT_PUBLIC_GOOGLE_CLIENT_ID is not an authorized JavaScript origin for this hostname, and APP_URL does not match).
- **Turnstile-gated flows are expected NOT to work for real browser users on this origin** (.env.local lists localhost/127.0.0.1, which production mode rejects by design; the throwaway hostname is not registered on the widget). Uploads/OTP/comparison E2E was proven separately on 127.0.0.1 with a QA preload, not through this public URL.
- No load, capacity, uptime monitoring, or provider call is made by this public check.

## Reproduce / stop

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy\public-demo.ps1 -Build
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy\public-demo.ps1 -Stop
```
