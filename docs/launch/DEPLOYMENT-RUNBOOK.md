# دليل نشر ChatE على خادم VPS واحد
# ChatE single-VPS production deployment runbook

**النسخة / Version:** 2026-10-28 · **المسؤول / Owner:** مالك المنتج (يُشار إليه «المالك») + مشغّل واحد (SRE).
**النطاق:** نشر إنتاجي واحد على VPS صغير: Ubuntu + Node 24 + systemd (web + worker) + Caddy/nginx + Cloudflare.
**حالة التحقق:** أوامر الترحيل والنسخ الاحتياطي/الاستعادة نُفِّذت فعليًا على Windows/Node 24 في هذا المستودع (انظر §14). خطوات الخادم نفسه **لم تُنفَّذ** هنا: لا نشر عام، ولا اعتماد على أي خادم حقيقي.

---

## English executive summary

Single-node production topology for ChatE: Ubuntu 24.04 LTS, Node 24 via NodeSource, app in `/opt/chate` run by an unprivileged `chate` user, SQLite in `/var/lib/chate/chate.sqlite` (WAL), private storage in `/var/lib/chate/storage`, secrets in `/etc/chate/chate.env` (0600 root:chate), two systemd units (web on `127.0.0.1:3211`, worker), Caddy for TLS (nginx alternative provided), Cloudflare in front. Backups use SQLite's online backup API (`VACUUM INTO` / `.backup`), are gzip+sha256'd, verified with `PRAGMA integrity_check`, retained 14 days, and a restore drill is mandatory before launch. **Verified locally:** migrations (5 files, idempotent), online backup 13 ms / 417,792 B / integrity ok / restore ok, typecheck+lint+78 tests+client-bundle secret scan pass. **Not verified here:** any VPS execution, TLS issuance, Cloudflare setup, live provider call, real SMS OTP. Hard gate: no paid public launch until phone verification, uploads/history/deletion gaps, license, and observability are closed (see `LAUNCH-READINESS.md`).

---

## 1. الوقائع المرجعية (verified in this repo)

| Fact | Evidence |
| --- | --- |
| Node 24.22.1 + npm 11.19.1 | `C:\Pak\node.exe --version` → v24.22.1; `npm.cmd --version` → 11.19.1 |
| Scripts exist: `db:migrate`, `worker`, `start`, `build`, `check:bundle` | `package.json:5-15` |
| Port used today: 3211 | `README.md:35,40`; live dev server responds on 3211 |
| SQLite default `data/chate.sqlite`, relative to cwd | `src/server/db/path.ts:4-10` |
| WAL + busy_timeout 5s + synchronous NORMAL + FK ON | `src/server/db/connection.ts:12-20` |
| Server auto-applies pending migrations on first DB open | `src/server/db/runtime.ts:11-17` |
| Worker applies migrations + requeues stale claims (15 min) then idles | `scripts/worker.ts:4,15-24` |
| Comparison execution runs in the Next.js process, not the worker | `src/server/comparisons/execute.ts:26-56`; `README.md:44` |
| Migrations applied in alphabetical order, one transaction per file, forward-only | `src/server/db/migrate.ts:12-23` |
| No `/api/health` route | live probe → 404; route list has 10 files, none health |
| Public DB-free probe available | `GET /api/models` → 200 (verified live, 13,456 B) |
| Public env values are baked at build time | `src/components/turnstile.ts:3`, `src/components/google-intent.tsx:7` |
| `next start` accepts `-p`/`PORT` and `-H` | `node_modules/next/dist/bin/next start --help` (verified) |
| `node_modules` is ~558 MB, app DB schema 417,792 B (36 tables) | measured in workspace 2026-10-28 |
| OTP send/verify + UI exist only in the current working tree (uncommitted, 2026-10-28T16:40) | `src/app/api/otp/{send,verify}/route.ts`, `src/server/otp/*`; not yet in HEAD |
| A production-mode `next build` now passes and a prod server was checked locally | Lead report 2026-10-28 (17/17 static pages, 20 dynamic routes) + independent check on 127.0.0.1:3213: root/models 200, admin/OTP 401, health 404, HSTS/CSP/COOP present |

## 2. الطوبولوجيا / Topology

```
Internet
  └─ Cloudflare (DNS proxy, WAF, optional rate limits)
      └─ VPS :443  Caddy (TLS/ACME)  ──►  127.0.0.1:3211  chate-web (Next.js, Node 24)
      │                                   │  ├─ /var/lib/chate/chate.sqlite (WAL)
      │                                   │  └─ /var/lib/chate/storage (private files)
      └─ VPS :22 (key-only, allowlisted IPs)        chate-worker (migrate + requeue; no port)
```

- الخادم الواحد هو وحدة القياس: SQLite بكاتب واحد، وNext.js عملية واحدة تنفّذ المقارنات داخليًا. **لا توسّع أفقيًا** (لا تشغّل نسختين على نفس ملف SQLite، ولا عدة خوادم خلف موازن).
- `chate-web` يستمع على loopback فقط. Caddy/nginx هو المدخل الوحيد.
- `chate-worker` لا يخدم HTTP ولا يستدعي مزودًا؛ وظيفته الترحيل وإرجاع المهام المعلّقة بعد انهيار web.

## 3. تجهيز الخادم / VPS + OS prep

**الحد الأدنى الموصى به:** Ubuntu 24.04 LTS، 2 vCPU، 2 GB RAM، 40 GB SSD (build + releases + backups). 1 vCPU/1 GB ممكن للتشغيل فقط مع swap 2 GB، لكن البناء قد يفشل (Next build + Tailwind + type-check). انظر COST-MODEL.

```bash
# as root on a fresh VPS
adduser --disabled-password --gecos "" chate
usermod -aG sudo chate
apt-get update && apt-get upgrade -y
apt-get install -y curl ca-certificates gnupg git sqlite3 ufw fail2ban unattended-upgrades rsync jq

# Node 24 (NodeSource; node:sqlite needs >= 22.5, app targets 24)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
node --version    # expect v24.x
npm --version

# swap only if RAM <= 1 GB
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=10 && echo 'vm.swappiness=10' >> /etc/sysctl.conf

# time sync + firewall
timedatectl set-timezone UTC
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
systemctl enable --now fail2ban unattended-upgrades
```

> ملاحظة Cloudflare: عند تفعيل البروكسي (الغيوم البرتقالية) يُفضّل تقييد 80/443 على نطاقات Cloudflare عبر `ufw` + ملف تحديث دوري، أو إبقاء origin على منفذ غير قياسي. الحد الأدنى قبل الإطلاق: `ufw` + SSH بمفتاح فقط + تعطيل `PasswordAuthentication`.

## 4. التخطيط على القرص / Layout & permissions

```text
/opt/chate/                     # app, owner chate:chate, not writable by others
  current -> releases/<git-sha> # symlink used by systemd WorkingDirectory
  releases/<git-sha>/           # one directory per release (keep last 3)
  shared/                       # optional: nothing required today
/var/lib/chate/                 # chown chate:chate, chmod 750
  chate.sqlite                  # 0600
  storage/                      # 0750, private file bytes (when uploads land)
/etc/chate/chate.env            # 0600 root:chate  (secrets + config)
/var/backups/chate/             # 0700 root (backup.sh chmod 700)
/var/log/caddy/                 # Caddy access logs (Caddy manages)
```

```bash
install -d -o chate -g chate -m 0750 /opt/chate /opt/chate/releases /var/lib/chate /var/lib/chate/storage
install -d -o root  -g chate -m 0750 /etc/chate
install -d -o root  -g root  -m 0700 /var/backups/chate
```

## 5. تثبيت الإصدار / Install a release

في هذه النسخة لا يوجد نشر عام دائم؛ CI مضاف (`.github/workflows/ci.yml`) لكنه لا ينشر، والنقل يدوي من نسخة المستودع:

```bash
# on the build machine (repo root): produce an archive without secrets/build dirs
git archive --format=tar.gz -o /tmp/chate-<sha>.tar.gz HEAD
scp /tmp/chate-<sha>.tar.gz chate@vps:/tmp/

# on the VPS
SHA=<sha>
sudo -u chate -H bash -lc '
  set -euo pipefail
  mkdir -p /opt/chate/releases/'"$SHA"'
  tar -xzf /tmp/chate-'"$SHA"'.tar.gz -C /opt/chate/releases/'"$SHA"'
  cd /opt/chate/releases/'"$SHA"'
  npm ci --no-audit --no-fund            # full deps: build needs devDeps; worker needs tsx
  set -a; . /etc/chate/chate.env; set +a # public NEXT_PUBLIC_* must be present at build
  npm run build
  npm run check:bundle                   # fails if any server secret name/value reached .next/static
  npm test                               # all suites must pass; 78 tests at the 2026-10-28 evidence cutoff (new OTP/security suites may raise the count)
  npm run typecheck && npm run lint
'
```

ملاحظات حتمية:
1. **لا تنسخ `.env.local`** إلى الخادم، ولا `.next` من جهاز التطوير (في مساحة العمل الحالية `.next` يحتوي آثار `next dev`).
2. `NEXT_PUBLIC_GOOGLE_CLIENT_ID` و`NEXT_PUBLIC_TURNSTILE_SITE_KEY` تُثبَّت داخل حزمة المتصفح **وقت البناء**. تغيير أي منهما = إعادة بناء.
3. `next/font/google` (IBM Plex Sans Arabic، `src/app/layout.tsx:9-15`) يجلب الخط وقت البناء → يحتاج الخادم اتصالًا خارجيًا أثناء `npm run build`. إن كان البناء على جهاز معزول فسيفشل.
4. `node_modules` نحو 558 MB؛ خصّص ≥ 5 GB لـ `/opt/chate` مع 3 إصدارات.

## 6. الأسرار / Secret injection

- الملف `/etc/chate/chate.env` بصيغة systemd `KEY=value` (بلا `export`، بلا علامات اقتباس حول القيم). القالب الكامل: [`deploy/.env.production.example`](../../deploy/.env.production.example). كل قيمة سر تبقى فارغة في Git.
- `sudo install -m 0600 -o root -g chate deploy/.env.production.example /etc/chate/chate.env` ثم املأ القيم عبر `sudoedit /etc/chate/chate.env`.
- تحميل الملف يتم عبر `EnvironmentFile=` في systemd. تغيير أي قيمة يتطلب `systemctl restart chate-web chate-worker`.
- **التحقق دون طباعة القيم:**
  ```bash
  sudo systemctl show chate-web -p EnvironmentFiles
  sudo test -s /etc/chate/chate.env && echo "env file non-empty"
  # confirm the app sees production: server header check + HSTS + no powered-by
  curl -sI https://chate.example.com/ | grep -Ei 'strict-transport-security|powered-by|x-frame-options' || true
  ```
- لا تكتب أسرارًا في `journalctl` ولا في أوامر `ps` (لا تستخدم `FOO=secret cmd`). `writeLog` ينقّي المفاتيح الحساسة (`src/domain/security/redact.ts:1,22-25`).
- `SESSION_SECRET`: قيمة عشوائية ≥ 32 بايت. `openssl rand -base64 48`. تغييرها يبطل كل الجلسات.
- `OTP_PEPPER` و`OTP_HTTP_AUTHORIZATION` تخص مزود الرسائل (مطلوبة لمسار OTP الجديد في شجرة العمل: إرسال/تحقق + واجهة).
- `HAIKU_LIVE_CALLS=0` افتراضيًا في قالب الإنتاج. لا تضبطها على `1` إلا بقرار مالك مكتوب لسقف إنفاق/تنبيه فاتورة؛ عند القيمة `0` يعيد المسار `HAIKU_LIVE_DISABLED` قبل أي اتصال بـAnthropic (`src/domain/models/haiku.ts`).

## 7. الملفات النهائية / Final config files

القيم القياسية في `deploy/`؛ انسخها كما هي:

```bash
# systemd units
sudo install -m 0644 deploy/systemd/chate-web.service    /etc/systemd/system/
sudo install -m 0644 deploy/systemd/chate-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable chate-web chate-worker

# TLS proxy (Caddy recommended)
sudo install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
# replace chate.example.com + ops@example.com first
sudo systemctl enable --now caddy && sudo systemctl reload caddy
```

`chate-web.service` (canonical content in `deploy/systemd/chate-web.service`; key lines):

```ini
[Service]
Type=simple
User=chate
Group=chate
WorkingDirectory=/opt/chate/current
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1
Environment=PORT=3211
EnvironmentFile=/etc/chate/chate.env
ExecStart=/usr/bin/node /opt/chate/current/node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3211
Restart=always
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/chate /opt/chate/current/.next
MemoryMax=768M
```

`chate-worker.service` (canonical in `deploy/systemd/chate-worker.service`; key lines):

```ini
[Service]
User=chate
Group=chate
WorkingDirectory=/opt/chate/current
Environment=NODE_ENV=production
EnvironmentFile=/etc/chate/chate.env
ExecStart=/usr/bin/node /opt/chate/current/node_modules/tsx/dist/cli.mjs scripts/worker.ts
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/chate /opt/chate/current/.next
MemoryMax=256M
```

> إن استخدمت `/opt/chate` مباشرة بدل `releases/` + `current`، عدّل `WorkingDirectory` و`ExecStart` و`ReadWritePaths` في الوحدات وثبّت المسار في كل مرة.

Caddyfile (canonical in `deploy/Caddyfile`):

```caddyfile
chate.example.com {
	encode zstd gzip
	header {
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}
	request_body { max_size 30MB }
	reverse_proxy 127.0.0.1:3211 {
		health_uri /api/models
		health_interval 30s
		header_up X-Forwarded-For {remote_host}
	}
	log {
		output file /var/log/caddy/chate-access.log { roll_size 50MB roll_keep 10 }
		format json
	}
}
```

nginx بديل: [`deploy/nginx.conf`](../../deploy/nginx.conf) (upstream keepalive، `client_max_body_size 30m`، `proxy_buffering off`، `X-Forwarded-*)`. لا تشغّل Caddy وnginx معًا على 443.

## 8. الترحيلات / Migrations

- خمسة ملفات حالية: `001_init.sql` → `005_indexes.sql`، تُطبَّق أبجديًا داخل معاملة لكل ملف، وتُسجَّل في `schema_migrations`. **لا توجد هجرات عكسية (down)**.
- سجل الترحيل المحلي (verified 2026-10-28 على ملف مؤقت): طُبِّقت الخمسة، ثم تشغيل ثانٍ طبع `no pending migrations`؛ الملف الناتج 417,792 بايت و36 جدولًا.
- عند الإقلاع، الخادم يطبّق المعلّق تلقائيًا (`runtime.ts:11-17`). في النشر:
  ```bash
  sudo -u chate -H bash -lc 'set -a; . /etc/chate/chate.env; set +a; cd /opt/chate/current && /usr/bin/node node_modules/tsx/dist/cli.mjs scripts/migrate.ts'
  ```
- **قبل أي ترحيل إنتاجي جديد:** شغّل `/opt/chate/deploy/scripts/backup.sh` واحتفظ بالنسخة، ثم رحّل، ثم افحص. لا تحذف ملف هجرة مُطبَّقًا؛ لا تعدّل ملف هجرة بعد تطبيقه.
- هجرة فاشلة: تُلغى معاملتها (كل ملف داخل معاملة) وتبقى `schema_migrations` بلا اسمه؛ أصلح الملف أو ارجع للنسخة الاحتياطية.

## 9. الإقلاع والتحقق / Start & smoke checks

```bash
sudo systemctl restart chate-web chate-worker
sudo systemctl status chate-web chate-worker --no-pager
journalctl -u chate-web -n 50 --no-pager
journalctl -u chate-worker -n 20 --no-pager

# smoke (localhost)
curl -fsS -o /dev/null -w 'root=%{http_code}\n' http://127.0.0.1:3211/
curl -fsS http://127.0.0.1:3211/api/models | head -c 200; echo
curl -s -o /dev/null -w 'admin_overview_anon=%{http_code}\n' http://127.0.0.1:3211/api/admin/overview   # expect 401
curl -s -o /dev/null -w 'comparisons_anon=%{http_code}\n' -X POST http://127.0.0.1:3211/api/comparisons -H 'content-type: application/json' -d '{}'  # expect 401
curl -s -o /dev/null -w 'uploads_anon=%{http_code}\n' -X POST http://127.0.0.1:3211/api/uploads -H 'content-type: application/json' -d '{}'  # expect 403 (turnstile) or 401
curl -s -o /dev/null -w 'health=%{http_code}\n' http://127.0.0.1:3211/api/health   # 404 expected: no health route
```

**التحقق الإلزامي الأول بعد النشر (يدويًا):**
1. `GET /` بالعربية و`dir="rtl"`، وزر Google يظهر عند ضبط `GOOGLE_CLIENT_ID`.
2. تسجيل دخول Google حقيقي؛ الكوكي `chate_session` يظهر `HttpOnly` و`Secure` (يتطلب `APP_URL=https://...`).
3. `/privacy` و`/terms` و`/history` تعمل؛ `/admin` يرفض غير المدرج في `ADMIN_GOOGLE_SUBS`/`ADMIN_EMAILS`.
4. إرسال مقارنة: مع نقص OTP الحالي ستظهر رسالة `OTP_UNCONFIGURED`/phone gate — هذا سلوك متوقع حتى يكتمل مسار OTP (انظر LAUNCH-READINESS §4.1).
5. HSTS موجود: `curl -sI https://chate.example.com/ | grep -i strict-transport-security`.

## 10. Cloudflare (اختياري لكنه موصى به)

1. DNS: سجل A للساحة → IP الخادم، Proxy **ON** (غيوم برتقالية).
2. SSL/TLS mode: **Full (strict)** مع شهادة Let's Encrypt من Caddy؛ لا تستخدم Flexible.
3. Always Use HTTPS ON، الحماية من البوت: Bot Fight Mode (يفحص أولًا أثره على Google/Turnstile).
4. WAF rate limit مقترح: `/api/otp/send` و`/api/auth/google` و`/api/comparisons` — 20 طلب/دقيقة/IP و100/ساعة/IP؛ رد 429.
5. Turnstile: أضف نطاق الإنتاج في إعدادات الودجت، وضع `TURNSTILE_EXPECTED_HOSTNAMES=chate.example.com` فقط (بلا localhost — يرفضه الكود في production، `src/domain/auth/turnstile.ts:21-23`).
6. لا تضع `cf-connecting-ip` من مصدر غير Cloudflare إلى التطبيق؛ إن كان الـorigin مكشوفًا فقيّد 80/443 بنطاقات Cloudflare.

## 11. النسخ الاحتياطي الدوري / Scheduled backups

النسخة **الإنتاجية** هي ملف SQLite مع `.db` فقط (الملفات الخاصة خارج القاعدة عند تفعيل الرفع). استخدم سكربتات `deploy/scripts` (تم اختبارها):

```bash
sudo install -m 0750 -o root -g chate deploy/scripts/backup.sh  /usr/local/sbin/chate-backup
sudo install -m 0750 -o root -g chate deploy/scripts/restore.sh /usr/local/sbin/chate-restore

# manual test (safe, read-only on live DB; writes a snapshot)
sudo SQLITE_PATH=/var/lib/chate/chate.sqlite BACKUP_DIR=/var/backups/chate /usr/local/sbin/chate-backup --with-storage
```

`/etc/systemd/system/chate-backup.service`:

```ini
[Unit]
Description=ChatE SQLite online backup
After=network-online.target
[Service]
Type=oneshot
User=root
Environment=SQLITE_PATH=/var/lib/chate/chate.sqlite
Environment=BACKUP_DIR=/var/backups/chate
Environment=STORAGE_DIR=/var/lib/chate/storage
Environment=BACKUP_RETENTION_DAYS=14
ExecStart=/usr/local/sbin/chate-backup --with-storage
Nice=10
IOSchedulingClass=idle
```

`/etc/systemd/system/chate-backup.timer`:

```ini
[Unit]
Description=ChatE backup every 6 hours
[Timer]
OnCalendar=*-*-* 00/6:05:00
Persistent=true
RandomizedDelaySec=300
[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now chate-backup.timer
systemctl list-timers chate-backup.timer
journalctl -u chate-backup.service -n 30 --no-pager
```

- التشفير في الراحة: `/var/backups` على قرص VPS فقط غير كافٍ. انسخ خارجيًا (rsync/rclone) واحتفظ بالمفاتيح بعيدًا. لا تشفّر بـ GPG قبل اختبار الاستعادة (المفتاح المفقود = نسخة ميتة).
- السقف: قرص 40 GB يكفي ~14 يومًا من نسخ صغيرة؛ راقب `df -h` عند نمو القاعدة.

## 12. تدريب الاستعادة / Restore drill (إلزامي قبل الإطلاق، ثم ربع سنوي)

**تحقق محلي فعلي (2026-10-28، Windows + Node 24.22.1):** نسخة `VACUUM INTO` من قاعدة حيّة (WAL) استغرقت **13 ms**، الحجم 417,792 B، `PRAGMA integrity_check` = `ok`، وبعد نسخ النسخة إلى ملف جديد: 5 ترحيلات، 36 جدولًا، وقيم `retention_settings` (90/30) سليمة. هذا يثبت صلاحية الطريقة لا صلاحية خادم بعينه.

**تدريب بلا مساس بالإنتاج:**

```bash
# 1) take a fresh backup
sudo SQLITE_PATH=/var/lib/chate/chate.sqlite BACKUP_DIR=/var/backups/chate /usr/local/sbin/chate-backup

# 2) restore-drill to a scratch path (never /var/lib/chate/chate.sqlite for a drill)
sudo -u chate bash -lc '
  set -euo pipefail
  B=$(ls -1t /var/backups/chate/chate-*.sqlite.gz | head -1)
  D=$(mktemp -d)
  gzip -dc "$B" > "$D/drill.sqlite"
  sqlite3 "$D/drill.sqlite" "PRAGMA integrity_check;"          # ok
  sqlite3 "$D/drill.sqlite" "SELECT COUNT(*) FROM schema_migrations;"   # 5
  sqlite3 "$D/drill.sqlite" "SELECT COUNT(*) FROM sqlite_master WHERE type="table";"  # 36
  rm -rf "$D"
'
```

**استعادة كاملة (كارثة):** تُوقف الخدمتين، تتحقق من checksum، تحتفظ بالملف الحالي جانبًا، تزيل $DB-wal/$DB-shm، تثبّت النسخة، تشغّل الترحيلات، ثم تفحص الصحة — السكربت ينفّذ ذلك بالكامل:
```bash
sudo ENV_FILE=/etc/chate/chate.env APP_DIR=/opt/chate/current \
  /usr/local/sbin/chate-restore /var/backups/chate/chate-<stamp>.sqlite.gz
# it prints the pre-restore copy path; rollback if health check fails is printed too
```

## 13. الترقية والرجوع / Upgrade & rollback

```bash
# 1) back up first (always, even for "code-only" releases)
sudo /usr/local/sbin/chate-backup

# 2) build new release directory (see §5), then switch the symlink atomically
sudo ln -sfn /opt/chate/releases/<new-sha> /opt/chate/current.new
sudo mv -Tf /opt/chate/current.new /opt/chate/current
sudo systemctl restart chate-web chate-worker

# 3) verify
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3211/
journalctl -u chate-web -n 40 --no-pager

# rollback (code only; DB schema is forward-only)
sudo ln -sfn /opt/chate/releases/<previous-sha> /opt/chate/current.new
sudo mv -Tf /opt/chate/current.new /opt/chate/current
sudo systemctl restart chate-web chate-worker
```

- إذا كانت النسخة الجديدة قد طبّقت هجرة جديدة، فرجوع الكود **لا يكفي**؛ استعد النسخة الاحتياطية السابقة (الحالة الوحيدة المدعومة) أو اكتب هجرة إصلاح للأمام.
- احتفظ بآخر 3 إصدارات: `find /opt/chate/releases -maxdepth 1 -mindepth 1 -type d | sort | head -n -3 | xargs rm -rf`.
- راقب الأخطاء 10 دقائق بعد كل ترقية قبل إغلاق نافذة التغيير.

## 14. الأداء والسعة / Capacity & thresholds (عتبات تصعيد)

| Signal | Warning | Critical | Action |
| --- | --- | --- | --- |
| RSS chate-web | > 620 MB (81% of 768M cap) | OOM restart loop | restart; move to 2 GB; check huge comparison count |
| Heap / CPU | p95 CPU > 70% 5 min | > 90% 10 min | 2 vCPU; reduce `MAX_GLOBAL_CONCURRENCY` to 4 |
| Disk /var | > 70% | > 85% | prune old releases; move backups off-box |
| `chate.sqlite` | > 2 GB | > 5 GB | enforce retention (not implemented yet); consider Postgres |
| `-wal` file | > 256 MB (no checkpoint) | > 1 GB | check long-running readers; backup/restart to checkpoint |
| Jobs `status='queued'` | > 20 for 5 min | > 50 for 15 min | provider rate limit (20 rpm), check 429; reduce concurrency |
| 5xx rate (journal/nginx) | > 1% | > 5% | incident runbook §15 |
| Provider 429 | burst | sustained | buy OpenRouter credits (1000 rpd vs 50 rpd) or reduce traffic |
| Health probe fail | 2 consecutive | 4 consecutive | restart + incident |

- `MAX_GLOBAL_CONCURRENCY=8` counts **comparisons in flight per provider pool** (openrouter and anthropic separately), not raw model calls; a 4-model comparison can hold 3 OR + 1 Anthropic units. SQLite single writer means concurrency above ~8 comparisons brings little throughput.
- لا توجد معايير أداء مقاسة على هذا الخادم. **لا يوجد load test بعد**؛ أول اختبار حمل يجب أن يكون على staging قبل الفتح العام.

## 15. دليل الحوادث / Incident runbook

| Symptom | First checks | Action |
| --- | --- | --- |
| 502/503 من Caddy | `systemctl status chate-web`; `journalctl -u chate-web -n 100`; `ss -lntp \| grep 3211` | restart web; إن تكرر مع OOM راجع §14؛ تحقق من `SQLITE_PATH` و`/var/lib/chate` perms |
| `SQLITE_BUSY`/database is locked | `ls -l /var/lib/chate`; `fuser`; هل عامل ثانٍ يكتب؟ | لا تشغّل نسختين؛ تأكد من worker واحد؛ افحص استعلامات طويلة؛ أعد التشغيل؛ last resort: backup ثم `PRAGMA wal_checkpoint(TRUNCATE)` |
| تعذر الدخول إلى /admin | `ADMIN_GOOGLE_SUBS` يطابق `sub` الفعلي؛ البريد يطابق Google | صحّح البيئة وأعد التشغيل؛ لا تضف بريدًا في URL (غير مدعوم أصلًا) |
| فشل Google login (GOOGLE_TOKEN) | `GOOGLE_CLIENT_ID` = `NEXT_PUBLIC_GOOGLE_CLIENT_ID`؛ الأصل مصرّح في Google Cloud؛ `APP_URL` https | صحّح الإعداد؛ اختبر نافذة تصفح خاصة |
| Turnstile fail | `TURNSTILE_EXPECTED_HOSTNAMES` يطابق `Host` العام؛ السر صحيح؛ `cf-connecting-ip` صالح | صحّح النطاقات؛ تحقق من ودجت Cloudflare |
| 429 متزايد من المزود | `journalctl -u chate-web \| grep RATE_LIMIT`؛ حدود OpenRouter 20 rpm | خفّض `MAX_GLOBAL_CONCURRENCY` مؤقتًا؛ أضف رصيدًا؛ لا تعِد المحاولة يدويًا بلا حد |
| فشل Anthropic auth | المفتاح صالح؟ الفاتورة محدّثة؟ | تدوير المفتاح (§16)؛ أو عطّل Haiku من الاختيار (قرار مالك — لا يوجد قاطع مالي في الكود) |
| قرص ممتلئ | `df -h`; `du -sh /var/backups/chate /opt/chate/releases` | احذف نسخًا قديمة/إصدارات؛ أفرغ journald؛ لا تحذف القاعدة |
| تلف بيانات محتمل | `PRAGMA integrity_check` | أوقف الخدمات واستعد آخر نسخة سليمة (§12) |
| تسريب سر | المفتاح ظهر في سجل/لقطة؟ | دوّر فورًا (§16)، أعد تشغيل الخدمتين، راجع السجلات |

**التصعيد:** مالك المنتج خلال 30 دقيقة لأي حادث يمس الأسرار أو البيانات أو توقف > 5 دقائق. لا يوجد on-call خارجي في هذا البناء.

## 16. تدوير الأسرار / Secret rotation

1. **OpenRouter**: أنشئ مفتاحًا جديدًا → ضعه في `/etc/chate/chate.env` → `systemctl restart chate-web` → تحقق من استجابة `/api/models` ومقارنة حقيقية إن أمكن → ألغِ القديم.
2. **Anthropic**: نفس الخطوات لـ`ANTHROPIC_API_KEY`؛ تعطيل القديم فورًا بعد التحقق.
3. **SESSION_SECRET**: `openssl rand -base64 48` → استبدال → restart → كل الجلسات تُبطل (متوقع).
4. **Turnstile**: أنشئ سرًا جديدًا من Cloudflare للودجت `0x4AAAAAAFoJLWRjfC1ZYlwB` → استبدال `TURNSTILE_SECRET_KEY` → restart. المفتاح العام لا يتغير إلا إذا أُنشئ ودجت آخر.
5. **OTP**: بدّل `OTP_PEPPER` و`OTP_HTTP_AUTHORIZATION` مع مزود الرسائل؛ الرموز غير المنتهية تُبطل.
6. بعد كل تدوير: راجع `journalctl` بحثًا عن الأخطاء، وثبّت السجل في سجل التغييرات (تاريخ، متغير، مسؤول). لوحة الإدارة تعرض آخر 4 محارف من إصدارات الأسرار فقط، ولا تنفّذ التدوير.

الأسرار الحالية في `.env.local` على جهاز التطوير **يجب اعتبارها مكشوفة عند أي مشاركة للجهاز** ولا تُنقل للإنتاج؛ أنشئ قيمًا إنتاجية جديدة.

## 17. Docker Compose بديل / Alternative profile

```bash
cp deploy/.env.production.example deploy/.env.production && chmod 600 deploy/.env.production
# fill values (no build-time secrets needed; NEXT_PUBLIC_* passed as build args via --env-file)
docker compose --env-file deploy/.env.production -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3211/
docker compose -f deploy/docker-compose.yml logs --tail=60 web worker
```

- مأخذ مهم: `NEXT_PUBLIC_*` تُمرَّر كـbuild args في `docker-compose.yml` من ملف البيئة؛ تغييرها يستلزم `--build`.
- الحجم: الصورة ≈ Node 24 slim + 558 MB node_modules (devDeps مطلوبة لـtsx/worker). لا تستخدم `output: standalone` (غير مضبوط في `next.config.ts`، وتعديله خارج نطاق هذه الحزمة).
- النسخ الاحتياطي في Compose: `docker compose exec -T web /bin/sh /app/deploy/scripts/backup.sh` (السكربت يكتب داخل الحاوية؛ `BACKUP_DIR` يجب أن يكون على volume مثل `/data/backups`) — وإلا شغّل السكربت على المضيف مع مسار volume الصحيح.

## 18. السجلات / Log rotation

- systemd/journald: `/etc/systemd/journald.conf` → `SystemMaxUse=500M` ثم `systemctl restart systemd-journald`. تدوير تلقائي. `journalctl --vacuum-size=500M` عند الحاجة.
- Caddy يدوّر `/var/log/caddy/chate-access.log` (roll_size 50MB، roll_keep 10، 30 يومًا).
- nginx: `/etc/logrotate.d/nginx` موجود افتراضيًا (daily/14). تأكد أن `chate-access.log` مشمول.
- Docker: `json-file` max-size 10m / max-file 5 مضبوط في compose.
- **لا تسجّل الأسرار.** `writeLog` ينقّي؛ لكن لا تضع قيمًا حساسة في متغيرات بيئة أوامر يراها `ps`.

## 19. المراقبة والتنبيه / Monitoring & alerting (صادق: لا شيء موصول)

لا يوجد في التطبيق APM/Sentry/OpenTelemetry، ولا `/api/health`، ولا تنبيه خارجي. `externalAlertResult()` في `src/domain/admin/alerts.ts:42-44` يعيد حرفيًا «التنبيهات الخارجية غير موصولة». لذلك المراقبة الحالية = **خارجية + سجلات + لوحة إدارة محلية**:

1. **Uptime خارجي** (UptimeRobot/BetterStack/Cloudflare Health Check): `https://chate.example.com/api/models` بكلمة مفتاحية `"ok":true` كل 60s من منطقتين. تنبيه بريد/هاتف للمالك.
2. **عدادات داخلية:** `/admin` (أسئلة/استدعاءات/أخطاء/429) من جداول `operation_stats`/`operation_buckets`; البيانات محلية فقط.
3. **Error rate من السجلات:**
   ```bash
   journalctl -u chate-web --since '15 min ago' --no-pager | grep -c 'comparison.failed' || true
   journalctl -u chate-web --since '15 min ago' --no-pager | grep -c 'ECONN|ETIMEDOUT|PROVIDER' || true
   ```
4. **Checks دورية (cron/systemd timer)** لكل: `curl -fsS --max-time 5 http://127.0.0.1:3211/api/models`، `df -h /`، `sqlite3 $DB "PRAGMA quick_check;"`، وحجم `-wal`، وعدد jobs المعلّقة. أرسل بريدًا عند الفشل (`mail` أو webhook).
5. **ما يجب إضافته قبل الدفع العام:** `/api/health` (DB + provider reachability)، Sentry أو ما يعادله من جانب الخادم، وتنبيه خارجي لـ: 5xx، فشل التنبيه، نفاد الحصة، انقطاع المزود. هذه ليست موجودة الآن.

## 20. أوامر تحقق جاهزة لمالك البناء الإنتاجي (يطلبها الـLead)

```bash
# after a production-mode rebuild on the same machine (port 3211)
curl -fsS -o /dev/null -w 'root=%{http_code}\n' http://127.0.0.1:3211/
curl -fsS http://127.0.0.1:3211/api/models | grep -o '"ok":true' | head -1
curl -sI http://127.0.0.1:3211/ | grep -Ei 'content-security-policy|strict-transport-security|x-frame-options|powered-by'
curl -s -o /dev/null -w 'admin_anon=%{http_code}\n' http://127.0.0.1:3211/api/admin/overview
curl -s -o /dev/null -w 'comparisons_anon=%{http_code}\n' -X POST http://127.0.0.1:3211/api/comparisons -H 'content-type: application/json' -d '{}'
curl -s -o /dev/null -w 'uploads_anon=%{http_code}\n' -X POST http://127.0.0.1:3211/api/uploads -H 'content-type: application/json' -d '{}'
curl -s -o /dev/null -w 'otp_send_anon=%{http_code}\n' -X POST http://127.0.0.1:3211/api/otp/send -H 'content-type: application/json' -d '{}'   # expect 401 (session required)
curl -s -o /dev/null -w 'otp_verify_anon=%{http_code}\n' -X POST http://127.0.0.1:3211/api/otp/verify -H 'content-type: application/json' -d '{}' # expect 401
curl -s -o /dev/null -w 'health=%{http_code}\n' http://127.0.0.1:3211/api/health   # 404 expected
# Haiku spend guard (after production env is loaded):
sudo grep '^HAIKU_LIVE_CALLS=' /etc/chate/chate.env   # expect 0 until owner approval
```

## 21. سجل ما لم يُنفَّذ / Honestly not executed

- لا خادم VPS، لا DNS، لا شهادة TLS، لا Cloudflare، لا نشر عام.
- لم يُشغَّل `chate-worker` كخدمة هنا (في مساحة العمل لا عملية عامل؛ منطق الترحيل وrequeue مُختبر في الكود/الاختبارات فقط).
- بناء إنتاجي محلي PASSED بقيادة الـLead (17/17 صفحة ثابتة) وخادم إنتاجي محلي على :3213 تحققت رؤوسه/مساره في 2026-10-28؛ لكن **لا نشر على VPS**، لذا خطوات §3-§12 تبقى غير منفَّذة على خادم حقيقي.
- لا اختبار حمل، ولا قياس p95، ولا فحص اختراق خارجي، ولا مراجعة اعتماديات (`npm audit` غير موصول بأي CI).

---

## 22. تحديث ما بعد إصلاحات ECC / Post-fix delta (2026-10-28 ~17:20)

هذا القسم يوثّق الفروق عن النص الأصلي أعلاه، ولا يغيّر أن **خطوات VPS/TLS/Cloudflare نفسها لم تُنفَّذ**.

**جديد منذ كتابة الـrunbook:**

- **CI:** `.github/workflows/ci.yml` (Node 24: `npm ci` ← `next typegen` ← typecheck ← lint ← `npm test` ← build ببيئة عامة وهمية ← `check:bundle`)؛ بلا أسرار؛ لا ينشر. التفعيل: دفع/PR إلى `main`؛ التحقق `gh run list --repo BedBankSA/ChatE --limit 5`. **لم يُشغَّل بعد على GitHub عند كتابة هذا السطر.**
- **الترخيص:** `LICENSE` (MIT، 2026 BedBankSA) وأُضيف إلى README.
- **رفع الملفات جاهز للنشر:** يحتاج `STORAGE_DIR` مشتركًا بين عملية الويب وعملية التنفيذ (نفس القرص)، وكتابة إلى مجلد التخزين عبر `systemd` (`ReadWritePaths`). الملفات خاصة (0700/0600) وتحت `<STORAGE_DIR>/<userId>/<fileId>`؛ النسخ الاحتياطي `--with-storage` أصبح ذا معنى فعليًا.
- **OTP:** المسار والواجهة منفّذان. الإنتاج يحتاج `OTP_PROVIDER=http` و`OTP_HTTP_URL=https://...` و`OTP_HTTP_AUTHORIZATION` و`OTP_PEPPER`؛ عقد المزود: `POST` JSON `{"to":"+E164","code":"######"}` وأي 2xx نجاح. **لا مزود SMS تجاري في هذه البيئة، ولا إرسال SMS حي.** قبل فتح البيتا اختبر رقمًا حقيقيًا على staging.
- **معالجة الأخطاء:** مزود الرسائل يعيد 502 غامضًا عند أي فشل شبكي/HTTP/مهلة 10 ثوانٍ، ولا يعيد نص المزود.
- **العرض العام المؤقت:** `scripts/deploy/public-demo.ps1` يبني (اختياريًا) ويشغّل `next start` على 3223 وCloudflare quick tunnel ويكتب `docs/evidence/public-deployment.md`. **ليس نشرًا إنتاجيًا** ولا يُغني عن هذا الدليل.
- **التحقق المطلوب عند النشر:** `npm test` الآن **258 اختبارًا**، و`node scripts/qa/verify-release.mjs --mode=mock` يجب أن يخرج PASS على نسخة البناء المنشورة (يغطي الرفع/Sجل/OTP/bootstrap).
- **`/api/health`:** صار منفّذًا؛ يمكن استخدامه في health checks لـCaddy/الموازن بدل `/api/models` (لكنه لا يفحص المزودين).
- **النسخ الاحتياطي:** يبقى كما هو؛ ومع تفعيل الرفع، شغّل `backup.sh --with-storage` وتحقق من النسخ خارج الخادم.
- **`HAIKU_LIVE_CALLS`:** يبقى `0` افتراضيًا في قالب الإنتاج. أُجري استدعاء حي واحد مخوَّل أثناء تحقق الإصدار (تكلفة 0.000046 دولار) — قرار السقف/الفاتورة للمالك ما زال مطلوبًا قبل الإنتاج.

**عناصر ما زالت مفتوحة:** VPS/DNS/TLS/Cloudflare، staging، load test، external uptime alerts، `npm audit` triage، مزود SMS، حذف/احتفاظ، دفع.
