# قائمة الإطلاق — ChatE
# Go-live checklist (pre-launch / launch day / post-launch)

**الاستخدام:** علّم كل بند `[x]` فقط بعد تنفيذ أمر التحقق أو إرفاق دليل. المالك = المالك؛ Ops = مشغّل الخادم؛ Dev = الـLead/مهندس التطبيق؛ Legal = المالك/مستشار.
**الحالة الحالية (2026-10-28):** البنود المؤشرة `[x]` فقط هي ما تم التحقق منه فعليًا.

---

## 0) English summary

42 gated items across three phases. **Currently verified:** 371 tests in 26 files (+1 opt-in live SMS test skipped by default), typecheck/lint, client-bundle secret scan, migrations `001`→`006` on a clean DB, online backup+restore drill, deployment artifacts exist and bash scripts pass syntax checks, a release E2E gate (mock + live, 13 PASS / 0 FAIL / 1 SKIP each), real live provider calls recorded (Anthropic + OpenRouter), a **real live SMS through 4jawaly** completing send → verify → `phone_verified_at` (`docs/evidence/sms-live.md`), a temporary public Cloudflare quick-tunnel URL probed 13/13 (not durable hosting), MIT `LICENSE`, and a GitHub Actions CI workflow. **Still unchecked:** durable VPS/TLS/Cloudflare deploy, staging, SMS delivery-receipt/status callbacks, payments, retention/deletion execution, external alerting, browser E2E automation. No item below proves a live VPS deployment; those stay unchecked until the owner executes the runbook.

---

## A. قبل الإطلاق / Pre-launch (T-14 → T-1)

### A1. كود وجودة Gates

- [ ] **CI أخضر على الفرع المرشح** — Dev. أُضيف `.github/workflows/ci.yml` في 2026-10-28 (Node 24، typegen/typecheck/lint/test/build/check:bundle، بلا أسرار، cancel-in-progress)؛ **لم يُشغَّل بعد** — يلزم دفع/PR. تحقق: `gh run list --repo BedBankSA/ChatE --limit 5` ← success. حتى ذلك الحين: `npm run typecheck && npm run lint && npm test && npm run check:bundle` كلها exit 0.
- [x] **typecheck** — Dev/launch-commander. دليل: `npm run typecheck` → exit 0 (2026-10-28).
- [x] **lint** — `npm run lint` → exit 0 (2026-10-28).
- [x] **اختبارات (خط الأساس)** — `npm test` → 78/78 في 10 ملفات (2026-10-28T16:26).
- [x] **اختبارات (شجرة العمل بعد تغييرات OTP/الأمان)** — `npm test` → **185/185 في 17 ملفًا** (2026-10-28T16:40).
- [x] **اختبارات (ما بعد ربط مزود SMS)** — `npm test` → **371/371 في 26 ملفًا، 0 فشل** + اختبار SMS حي واحد مُتخطى افتراضيًا (2026-10-28T17:51، شجرة العمل النهائية). تحقق حي مستقل: `SMS_LIVE_TEST=1 vitest run tests/sms-live.test.ts` → 1/1 PASS مع إرسال SMS حقيقي عبر 4jawaly (`docs/evidence/sms-live.md`).
- [ ] **اختبار E2E متصفح للمسار الحرج** — Dev. لا Playwright آلي في المستودع. البديل المنفَّذ: `scripts/qa/verify-release.mjs` (mock + live، 13 PASS لكل وضع) يغطي API المسار الحرج؛ فحص المتصفح (P14) متخطى كخيار. المطلوب للإغلاق: Playwright أو CDP آلي في CI.
- [x] **فحص تسرب الأسرار إلى حزمة المتصفح** — `npm run check:bundle` → `client bundle clean: 14 files` (2026-10-28).
- [ ] **`npm audit --omit=dev` بلا Critical/High** — Ops/Dev. `C:\Pak\npm.cmd audit --omit=dev --audit-level=high`.
- [x] **بناء إنتاجي ناجح** — Dev/Lead: `next build` PASSED (Next 16.4.3، 17/17 صفحة ثابتة، 21+ مسارًا ديناميكيًا) + `check:bundle` clean (2026-10-28، BUILD_ID `EJffcvoV_rRnCN_gm-1Bg`).
- [x] **دليل عرض عام مؤقت (Cloudflare quick tunnel)** — Lead. شُغِّل في 2026-10-28: `https://relatives-observations-proc-court.trycloudflare.com`، 13/13 فحص PASS (root RTL 200، `/api/models` 200، `/privacy` و`/terms` 200، 401 للمجهولين، HSTS/CSP/XFO/nosniff). الدليل: `docs/evidence/public-deployment.md`. **هذا ليس نشرًا دائمًا**؛ B2 يبقى مفتوحًا حتى تنفيذ Runbook على VPS. للتوقف: `scripts/deploy/public-demo.ps1 -Stop`.
- [ ] **بناء نظيف من الصفر على الخادم** — Ops. `rm -rf .next && npm ci && npm run build && npm run check:bundle`. **لا تنسخ `.next` من وضع dev.**

### A2. الأسرار والإعداد

- [ ] `/etc/chate/chate.env` موجود 0600 root:chate وكل الأسرار الإنتاجية جديدة (لا قيم من `.env.local`). تحقق: `sudo stat -c '%a %U:%G' /etc/chate/chate.env` → `600 root:chate`.
- [ ] `SESSION_SECRET` عشوائي ≥32 بايت: `openssl rand -base64 48` (لا يظهر في السجل).
- [ ] `ANTHROPIC_API_KEY` و`OPENROUTER_API_KEY` إنتاجيان وقابلان للإلغاء. تحقق دون طباعة: `sudo grep -c '^OPENROUTER_API_KEY=.\+' /etc/chate/chate.env` = 1.
- [ ] `TURNSTILE_SECRET_KEY` جديد من لوحة Cloudflare للودجت `0x4AAAAAAFoJLWRjfC1ZYlwB`.
- [ ] `SMS_PROVIDER=4jawaly` و`SMS_API_KEY` و`SMS_API_SECRET` و`SMS_SENDER_ID=BedBank` و`OTP_PEPPER` مضبوطة في بيئة الإنتاج، مع إبقاء `OTP_PROVIDER`/`OTP_HTTP_URL` **فارغين** (قيمة قديمة غير فارغة تسبق `SMS_PROVIDER`). تحقق دون طباعة: `sudo grep -c '^SMS_API_KEY=.\+' /etc/chate/chate.env` = 1 و`sudo grep -c '^OTP_PROVIDER=.\+' /etc/chate/chate.env` = 0.
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

- [x] **OTP يعمل طرفًا لطرف محليًا (B1 جزئيًا):** `POST /api/otp/send` كتب رقمًا بأي صيغة، طبّعه إلى `+966564106506`، أرسل SMS حقيقيًا عبر 4jawaly، ثم `POST /api/otp/verify` وضع `phone_verified_at` (اختبار حي 1/1، `docs/evidence/sms-live.md`). **يبقى مطلوبًا للإغلاق الكامل:** نفس الدورة على staging/نطاق إنتاجي وربطها بـ`dispatchModel` بدليل log/run row، وإثبات delivery-receipt.
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
| Code quality gates (typecheck/lint/tests/bundle) | ✅ verified: typecheck/lint exit 0، **371/371 اختبارًا في 26 ملفًا** (+1 حي مُتخطى)، build ناجح (23 مسارًا ديناميكيًا + 1 ثابت)، bundle clean (2026-10-28) |
| Migrations on clean DB | ✅ verified: `001`→`006` ثم `no pending migrations` |
| Backup/restore technique | ✅ verified (VACUUM INTO + integrity ok + restore drill محلي) |
| Deploy artifacts (Docker/Caddy/nginx/systemd/scripts) | ✅ authoring complete; bash -n clean؛ backup.sh tested؛ public-demo tunnel tooling أُضيف وشُغِّل |
| CI | 🟡 `.github/workflows/ci.yml` أُضيف 2026-10-28؛ أول تشغيل أخضر ينتظر الدفع (يُحدَّث بعد `gh run list`) |
| OTP end-to-end / phone gate | ✅ محليًا: دورة حقيقية عبر 4jawaly حتى `phone_verified_at` (اختبار حي 1/1؛ `docs/evidence/sms-live.md`)؛ بوابة الجوال تعمل. 🟡 المتبقي: إثبات على staging/نطاق إنتاجي + delivery receipt/status callbacks (B8 جزئيًا مغلق) |
| Uploads / history / account deletion / retention | 🟡 الرفع والسجل منفّذان ومُختبران (E2E)؛ link/تنزيل/حذف ملفات وحذف حساب وتطبيق الاحتفاظ ما زالت ❌ (B4/B10) |
| License / legal pages accuracy | 🟡 MIT LICENSE file added 2026-10-28 (B5)؛ privacy/account صُحّحا ليطابقا الواقع؛ terms/legal review الكامل ما زال ❌ (B12) |
| Public deploy, TLS, Cloudflare, staging | 🟡 عرض عام مؤقت عبر Cloudflare quick tunnel تم التحقق منه 13/13 (`docs/evidence/public-deployment.md`)؛ durable VPS/TLS/Cloudflare/staging ما زال ❌ (B2) |
| Health endpoint / observability / external alerts | 🟡 `GET /api/health` منفّذ؛ APM/تنبيه خارجي/صفحة حالة ما زالت ❌ (B11) |
| Payments | ❌ absent (B7) |
| Live provider proof (OpenRouter/Anthropic) | ✅ Anthropic `claude-haiku-5-5` (433/6 توكن، $0.000046، 1935ms) وOpenRouter `cohere/north-mini-code:free` (178/152، 2678ms) في تحقق الإصدار (B6) |
