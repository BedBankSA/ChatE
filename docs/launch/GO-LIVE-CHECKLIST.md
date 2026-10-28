# قائمة الإطلاق — ChatE
# Go-live checklist (pre-launch / launch day / post-launch)

**الاستخدام:** علّم كل بند `[x]` فقط بعد تنفيذ أمر التحقق أو إرفاق دليل. المالك = المالك؛ Ops = مشغّل الخادم؛ Dev = الـLead/مهندس التطبيق؛ Legal = المالك/مستشار.
**الحالة الحالية (2026-10-28):** البنود المؤشرة `[x]` فقط هي ما تم التحقق منه فعليًا.

---

## 0) English summary

42 gated items across three phases. **Currently verified:** 78 tests, typecheck/lint, client-bundle secret scan, migrations on a clean DB, online backup+restore drill, deployment artifacts exist and bash scripts pass syntax checks. **Added 2026-10-28:** MIT `LICENSE`, a GitHub Actions CI workflow file (first green run pending push), and temporary public-demo tunnel tooling (`scripts/deploy/public-demo.ps1`; its run writes `docs/evidence/public-deployment.md`). **Everything durable-infra/legal/OTP/payments is unchecked.** No item below proves a live VPS deployment; those stay unchecked until the owner executes the runbook.

---

## A. قبل الإطلاق / Pre-launch (T-14 → T-1)

### A1. كود وجودة Gates

- [ ] **CI أخضر على الفرع المرشح** — Dev. أُضيف `.github/workflows/ci.yml` في 2026-10-28 (Node 24، typegen/typecheck/lint/test/build/check:bundle، بلا أسرار، cancel-in-progress)؛ **لم يُشغَّل بعد** — يلزم دفع/PR. تحقق: `gh run list --repo BedBankSA/ChatE --limit 5` ← success. حتى ذلك الحين: `npm run typecheck && npm run lint && npm test && npm run check:bundle` كلها exit 0.
- [x] **typecheck** — Dev/launch-commander. دليل: `npm run typecheck` → exit 0 (2026-10-28).
- [x] **lint** — `npm run lint` → exit 0 (2026-10-28).
- [x] **اختبارات (خط الأساس)** — `npm test` → 78/78 في 10 ملفات (2026-10-28T16:26).
- [x] **اختبارات (شجرة العمل بعد تغييرات OTP/الأمان)** — `npm test` → **185/185 في 17 ملفًا** (2026-10-28T16:40، غير مُودَعة)؛ أعد التشغيل بعد الدمج.
- [ ] **اختبار E2E متصفح للمسار الحرج** — Dev. لا Playwright في المستودع (`docs/test-results.md:52`). المطلوب: login → OTP → إنشاء مقارنة → ظهور 4 نتائج → فشل نموذج لا يكسر البقية.
- [x] **فحص تسرب الأسرار إلى حزمة المتصفح** — `npm run check:bundle` → `client bundle clean: 14 files` (2026-10-28).
- [ ] **`npm audit --omit=dev` بلا Critical/High** — Ops/Dev. `C:\Pak\npm.cmd audit --omit=dev --audit-level=high`.
- [x] **بناء إنتاجي ناجح** — Dev/Lead: `next build` PASSED (Next 16.4.3، 17/17 صفحة ثابتة، 20 مسارًا ديناميكيًا) + `check:bundle` clean (2026-10-28، شجرة العمل الحالية).
- [ ] **دليل عرض عام مؤقت (Cloudflare quick tunnel)** — Lead. الأداة جاهزة: `scripts/deploy/public-demo.ps1` (تتحقق من الصفحات العامة و`GET /api/models` والرؤوس و401 المجهولين، وتكتب `docs/evidence/public-deployment.md`). التشغيل: `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy\public-demo.ps1 -Build` ثم `... -Stop`. **هذا ليس نشرًا دائمًا**؛ B2 يبقى مفتوحًا حتى تنفيذ Runbook على VPS.
- [ ] **بناء نظيف من الصفر على الخادم** — Ops. `rm -rf .next && npm ci && npm run build && npm run check:bundle`. **لا تنسخ `.next` من وضع dev.**

### A2. الأسرار والإعداد

- [ ] `/etc/chate/chate.env` موجود 0600 root:chate وكل الأسرار الإنتاجية جديدة (لا قيم من `.env.local`). تحقق: `sudo stat -c '%a %U:%G' /etc/chate/chate.env` → `600 root:chate`.
- [ ] `SESSION_SECRET` عشوائي ≥32 بايت: `openssl rand -base64 48` (لا يظهر في السجل).
- [ ] `ANTHROPIC_API_KEY` و`OPENROUTER_API_KEY` إنتاجيان وقابلان للإلغاء. تحقق دون طباعة: `sudo grep -c '^OPENROUTER_API_KEY=.\+' /etc/chate/chate.env` = 1.
- [ ] `TURNSTILE_SECRET_KEY` جديد من لوحة Cloudflare للودجت `0x4AAAAAAFoJLWRjfC1ZYlwB`.
- [ ] `OTP_PROVIDER=http` و`OTP_HTTP_URL` و`OTP_PEPPER` و`OTP_HTTP_AUTHORIZATION` مضبوطة (يعتمد على B8 / مزود SMS).
- [ ] `APP_URL=https://<domain>` (وليس http ولا 3211 ولا 3000). تحقق: `sudo grep '^APP_URL=' /etc/chate/chate.env`.
- [ ] `GOOGLE_CLIENT_ID` = `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (نفس القيمة) ومسجل في Google Cloud كأصل JavaScript مصرّح.
- [ ] `TURNSTILE_EXPECTED_HOSTNAMES` = نطاق/نطاقات الإنتاج فقط (لا localhost). الكود يرفض localhost في production (`src/domain/auth/turnstile.ts:21-23`).
- [ ] `ADMIN_GOOGLE_SUBS` يحوي `sub` المالك الفعلي (وليس بريدًا فقط). تحقق من قيمة `sub` عبر الـID token في staging.
- [ ] قرار Haiku مكتوب: الكود الآن يتطلب `HAIKU_LIVE_CALLS=1` لتفعيل الاستدعاء الحي؛ تأكد أن الإنتاج يحمل `HAIKU_LIVE_CALLS=0` حتى موافقة المالك على إنفاق/سقف مكتوب. `sudo grep '^HAIKU_LIVE_CALLS=' /etc/chate/chate.env`.

### A3. الخادم والبنية التحتية

- [ ] VPS: Ubuntu 24.04، 2 vCPU/2GB/40GB، Node 24، `chate` user، `ufw` (22/80/443)، SSH بمفتاح فقط. تحقق: `node -v` → v24.x؛ `sudo ufw status` → active.
- [ ] مجلدات وصلاحيات §4 من الـrunbook: `sudo -u chate test -w /var/lib/chate && echo ok`.
- [ ] الإصدار في `/opt/chate/releases/<sha>` و`/opt/chate/current` symlink. تحقق: `readlink -f /opt/chate/current`.
- [ ] وحدتا systemd مفعّلتان ومستقرتان 10 دقائق: `systemctl is-active chate-web chate-worker` → active؛ `journalctl -u chate-web --since '10 min ago' | grep -ci error` = 0 (أو مبرر).
- [ ] Caddy TLS صحيح: `curl -sI https://<domain>/ | head -1` → 200؛ `openssl s_client -connect <domain>:443 -servername <domain> </dev/null 2>/dev/null | openssl x509 -noout -dates`.
- [ ] TLS auto-renew: `systemctl list-timers | grep -i caddy` (Caddy) أو `systemctl list-timers | grep certbot` (nginx).
- [x] **رؤوس الإنتاج محليًا** — `curl -sI http://127.0.0.1:3213/` → HSTS، CSP بلا unsafe-eval، X-Frame DENY، nosniff، COOP، بلا X-Powered-By، Cache-Control no-store (تحقق 2026-10-28T16:42).
- [ ] Cloudflare: Proxy ON، SSL Full (strict)، Always HTTPS، سجلات DNS صحيحة، ولا كشف مباشر لعنوان origin.
- [ ] DNS/البريد: سجل A، وSPF/DKIM/DMARC لبريد الدعم (إن استُخدم نطاق البريد).

### A4. البيانات والنسخ الاحتياطي

- [x] **ترحيلات من قاعدة فارغة**: 5 ملفات مطبّقة ثم `no pending migrations` (2026-10-28، ملف مؤقت). الأمر في الإنتاج: `sudo -u chate -H bash -lc '... scripts/migrate.ts'`.
- [x] **نسخ/استعادة أُثبتت تقنيًا**: `VACUUM INTO` 13 ms، 417,792 B، integrity ok، استعادة 5 ترحيلات/36 جدولًا (2026-10-28).
- [ ] `chate-backup.timer` مفعّل وينفّذ كل 6 ساعات: `systemctl list-timers chate-backup.timer`؛ `journalctl -u chate-backup.service -n 20` يظهر `OK db backup`.
- [ ] نسخة خارج الخادم (rsync/rclone) تعمل وتم اختبارها: `rclone check /var/backups/chate remote:/chate-backups` (أو ما يعادله).
- [ ] **تدريب استعادة كامل على staging** (لا على prod): restore في مجلد مؤقت + `PRAGMA integrity_check` + عدد الجداول/الهجرات مطابق.
- [ ] سياسة احتفاظ مطبّقة (حتى لو يدوية بلا كود): مذكورة وتاريخ أول مراجعة.
- [ ] تقدير حجم النمو: DB الحالية 417,792 B (مخطط فقط)؛ راقب `du -h /var/lib/chate/chate.sqlite*`.

### A5. المنتج/الوظائف

- [ ] **OTP يعمل طرفًا لطرف** (مانع B1): مسار send/verify + الواجهة موجودة الآن في شجرة العمل (غير مُودَعة)؛ يجب دمجها ثم: `POST /api/otp/send` يرسل رمزًا حقيقيًا، إدخال الرمز يضع `phone_verified_at`، ثم مقارنة تصل لـ`dispatchModel` (دليل log staging أو run row).
- [ ] رفع الملفات: قرار مالك موثّق — إمّا منفّذ (حفظ بايتات + ربط) أو **مُزال من الادعاءات** في الصفحة/الخصوصية (B3).
- [ ] حذف الحساب/السجل: منفّذ فعليًا (مسار delete + cascade + ملفات) أو نصوص الصفحات مصحّحة (B4).
- [ ] صفحة الخصوصية/الشروط: هوية المتحكّم، جهة اتصال، قائمة المزودين (Google/Cloudflare/OpenRouter/Anthropic/SMS)، مدة الاحتفاظ، حقوق المستخدم — مطابقة للواقع (`LEGAL-REVIEW.md`).
- [ ] ترخيص المشروع/شروط الاستخدام: قرار مالك + ملف/صفحة (B5). **ملف الترخيص أُضيف 2026-10-28:** `LICENSE` = MIT، `Copyright (c) 2026 BedBankSA` — تحقق: `Get-Content LICENSE`. يبقى قرار المالك النهائي (اسم الجهة/اختيار MIT) وصفحة/نص شروط يستخدمه المستخدم.
- [ ] كل الاختصارات والنماذج الظاهرة تعمل أو تُعلَّم بوضوح: `GET /api/models` 200 ويعيد السجل.
- [ ] رسائل الأخطاء العربية واضحة لكل فشل (OTP unconfigured، provider down، quota) — موجودة في الكود وتُختبر يدويًا.

### A6. المراقبة والدعم

- [ ] مراقبة uptime خارجية على `https://<domain>/api/models` بكلمة `"ok":true` من منطقتين + تنبيه بريد/هاتف.
- [ ] تنبيه قرص > 70% وذاكرة > 80% و5xx > 1% (خارجي أو cron).
- [ ] بريد دعم منشور في الصفحات + سياسة استجابة (24 ساعة عمل).
- [ ] صفحة حالة (status page) أو على الأقل تغريدة/بريد إعلان عند التوقف.
- [ ] معرفة أن `/api/health` **لا يوجد** (404)؛ لا تعتمد عليه في المراقبة قبل تنفيذه (B11).

## B. يوم الإطلاق / Launch day

- [ ] **T-60m**: نسخة احتياطية يدوية جديدة: `sudo /usr/local/sbin/chate-backup`.
- [ ] **T-45m**: `systemctl status chate-web chate-worker caddy` كلها active؛ `df -h` و`free -m` ضمن الحدود.
- [ ] **T-30m**: فحص دخان كامل على staging ثم prod (الأوامر في `DEPLOYMENT-RUNBOOK.md` §9/§20): root 200، `/api/models` 200، admin 401، comparisons 401، otp/send 401 (مجهول)، otp/verify 401 (مجهول)، health 404 متوقع.
- [ ] **T-20m**: HSTS + CSP + لا `X-Powered-By`: `curl -sI https://<domain>/ | grep -Ei 'strict-transport|content-security|powered-by'`.
- [ ] **T-15m**: تسجيل دخول Google حقيقي؛ تفتيش الكوكي: `chate_session` HttpOnly + Secure + SameSite=Lax.
- [ ] **T-10m**: مقارنة كاملة واحدة 4 نماذج (3 مجانية + Haiku وفق قرار B9) — تظهر 4 نتائج، وفشل نموذج واحد لا يمنع الباقي (إن فشل الكل: توقف الإطلاق).
- [ ] **T-0**: فتح الدعوات/الإعلان.
- [ ] **T+15m**: مراجعة `journalctl -u chate-web --since '20 min ago'` أخطاء؛ `/admin` عدادات الأسئلة/الاستدعاءات تتحرك.
- [ ] **T+30m**: فحص 429 والمزود: `journalctl | grep -c RATE_LIMIT`؛ مراجعة حصة OpenRouter.
- [ ] **T+60m**: تأكيد أن النسخة الاحتياطية التالية (timer) نجحت.
- [ ] **حد توقف الإطلاق (abort criteria):** خطأ 5xx > 5% خلال 15 دقيقة، أو تعذر الدخول لأكثر من 5% من المحاولات، أو أي تسريب أسرار مشتبه → أوقف الدعوات/أغلق التسجيل وأعلن التوقف؛ لا «إصلاح في الحرارة» بلا نسخة رجوع.

## C. بعد الإطلاق / Post-launch

- [ ] **+24h**: مراجعة 5xx/429/زمن الاستجابة من السجلات ولوحة الإدارة؛ توثيق أول 10 بلاغات.
- [ ] **+24h**: التأكد من نجاح timer النسخ الاحتياطي 4 مرات متتالية.
- [ ] **+72h**: مراجعة حصة المستخدمين/المشتركة (`quota_accounts`) مقابل التوقعات، وقرار سعة (1 vs 2 vCPU).
- [ ] **أسبوعيًا**: نسخة خارجية + `PRAGMA quick_check` + مراجعة سجلات الأخطاء + تدوير أي سر انكشف.
- [ ] **شهريًا**: `npm audit`، تحديث Node/الاعتماديات بحذر، مراجعة صلاحيات admin، مراجعة سعة القرص.
- [ ] **ربع سنويًا**: تدريب استعادة كامل؛ مراجعة DPIA/الاحتفاظ/الحذف؛ مراجعة شروط المزودين.
- [ ] **بعد أول أسبوع**: تقييم أداء — إن p95 > الهدف أو 429 مستمر → 2 vCPU/2GB أو رصيد OpenRouter.
- [ ] **قبل أي إطلاق مدفوع**: استيفاء G11 (دفع/فاتورة/استرداد/ضريبة) ومراجعة قانونية — غير موجود اليوم.

## D. سجل الحالة الحالية / Current status snapshot (2026-10-28)

| Area | Status |
| --- | --- |
| Code quality gates (typecheck/lint/tests/bundle) | ✅ verified على خط الأساس؛ ✅ 185 اختبارًا على شجرة العمل (غير مُودَعة) |
| Migrations on clean DB | ✅ verified |
| Backup/restore technique | ✅ verified |
| Deploy artifacts (Docker/Caddy/nginx/systemd/scripts) | ✅ authoring complete; bash -n clean؛ backup.sh tested؛ public-demo tunnel tooling أُضيف (`scripts/deploy/public-demo.ps1`) |
| CI | 🟡 `.github/workflows/ci.yml` أُضيف 2026-10-28؛ أول تشغيل أخضر ينتظر الدفع |
| OTP end-to-end / phone gate | ❌ blocked (B1) |
| Uploads / history / account deletion / retention | ❌ stubs or missing (B3/B4/B10) |
| License / legal pages accuracy | 🟡 MIT LICENSE file added 2026-10-28 (B5)؛ terms/privacy accuracy ما زالت ❌ (B12) |
| Public deploy, TLS, Cloudflare, staging | ❌ durable deploy not executed (B2)؛ temporary Cloudflare quick-tunnel demo tooling جاهز (evidence عند التشغيل) |
| Health endpoint / observability / external alerts | ❌ (B11) |
| Payments | ❌ absent (B7) |
| Live provider proof (OpenRouter/Anthropic) | ❌ none (B6) |
