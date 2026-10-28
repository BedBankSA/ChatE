# التدقيق الأمني والاختبار العدائي — ChatE (Security Audit & Adversarial Test)

| البند | القيمة |
| --- | --- |
| التاريخ | 2026-10-28 |
| المدقق | security-redteam (فريق أمني موازٍ بإشراف Lead) |
| الفرع | `main` (مستودع واحد غير مونوريبو) |
| المكدس | Next.js 16.4.3 (App Router) + React 19 + TypeScript + Tailwind 4 + SQLite (`node:sqlite`) على Node 24 |
| بيئات الاختبار | dev `http://127.0.0.1:3211` (قبل إعادة البناء)؛ production `http://127.0.0.1:3213` (PID 15744، مفاتيح المزودين فارغة)؛ harness production `http://chate.test:3212` (PID 28956، Turnstile/OTP/مزودون بمحاكاة، قاعدة `data/qa.sqlite`) |
| المخرجات المصاحبة | `docs/audit/THREAT-MODEL.md`، `docs/audit/SECRETS-INVENTORY.md`، `tests/security-*.test.ts` (85 اختبارًا جديدًا) |
| الحالة | لا يوجد فتح حرج مفتوح. عالية واحدة أُغلقت أثناء التدقيق (H-01)، ومتوسطة/عالية أُغلقت (H-02). تبقّى توصيات متوسطة/منخفضة موثّقة أدناه. |

---

## الملخص التنفيذي (English Executive Summary)

**Scope.** Full static review of the ChatE application (94 source files, 5 migrations, Next 16 App Router) plus authorized black-box attacks against three local server instances: the pre-rebuild dev server on :3211, a plain production-mode server on :3213 (provider keys blanked), and a production harness on `http://chate.test:3212` with mocked Turnstile/OTP/providers and a QA SQLite database where I seeded isolated `secaudit-*` users.

**Result.** One High-severity hidden-cost path (live Anthropic calls enabled by a hard-coded constant while docs claimed otherwise) was fixed by the Lead during the audit and is now covered by regression tests. One High/Medium authorization gap (signed sessions ignored suspension and server-side revocation) was found and fixed by this audit. Four Medium issues were fixed: missing Origin/CSRF enforcement on non-admin state-changing routes, unbounded JSON request bodies, missing rate limits on login/OTP/nonce minting, and a non-atomic OTP attempt counter that allowed concurrent brute force (fixed by the OTP owner). One Medium remains accepted-risk: production CSP still allows `script-src 'unsafe-inline'` because Next.js injects inline bootstrap scripts and a nonce middleware is out of scope. Low items: `/api/theme` Host-header open redirect + no CSRF (patch pending in Lead scope), APP_URL-derived Secure-cookie fallback, missing `no-store` on a few sensitive responses, Turnstile replay memory fallback, email-based admin fallback, and a quota-free comparison abuse path.

**Verified absent.** No SQL injection, no IDOR (live cross-user read returned 404, owner 200), no XSS sink, no SSRF, no secret value in the client bundle, and `npm audit --omit=dev` reported 0 vulnerabilities. Turnstile single-use was verified live (valid token 200 → replay 403 `reused`), OTP send/verify limits were verified live (3 sends → 429 `OTP_RESEND`; wrong attempts decrement to 5 → 429 `OTP_ATTEMPTS`), admin authz and CSRF were verified live (non-admin 403; missing/cross-site Origin 403; valid mutation 303 saved + audit row; self-suspend rejected), and forged/tampered/revoked sessions were verified live (active 200, suspended/revoked/tampered 307).

**Quality gates.** `tsc --noEmit` = 0 errors; `eslint .` = 0 errors; `npm test` = **186 passed / 186** in 17 files; `npm run check:bundle` with `.env.local` loaded = clean (14 files, no secret names or values). `npm audit --omit=dev` = 0 vulnerabilities (147 prod deps; registry reachable).

**Honest limits.** I never used a real Google ID token, a real Cloudflare token, or a live paid provider call. Session cookies used in live tests were forged with the QA/known local secrets (authorized by the Lead). `/api/theme` open-redirect exploitability depends on Host-header control (reverse proxy/vhost confusion), not on a link-only attack. One source change (intent-route Origin check, `src/app/api/auth/google/intent/route.ts:11`) was made after the current production build; it is unit-tested and must be included in the Lead's final rebuild. Details and reproduction commands are below.

---

## 1. المنهجية

1. **مهارات أمنية مُحمّلة:** `security-best-practices`، `security-threat-model`، `review-security` (تم تطبيق جوهرها يدويًا: لا يمكن استدعاء subagent من عمق التفويض الحالي).
2. **مراجعة ساكنة موجّهة:** قراءة كل ملفات `src/domain/security`، `src/domain/auth`، `src/server/{guard,turnstile,turnstile-replay,google-session,google-identity,account-access}.ts`، كل مسارات `src/app/api/**` و`src/server/admin/**` و`src/server/comparisons/**`، والهجرات `migrations/001..005`، و`next.config.ts`، `scripts/check-client-bundle.ts`، ودليلَي الوثائق.
3. **بحث أنماط:** `dangerouslySetInnerHTML|innerHTML|eval|new Function`، `process.env`، `origin|referer|csrf`، `prepare(` مع أي استيفاء نصوص، `BEGIN IMMEDIATE|IMMEDIATE`، `localStorage|window.`.
4. **اختبار حي مُصرّح:** `curl.exe` وNode fetch فقط، بلا شبكة مدفوعة، وبلا حذف بيانات. هجمات: جلسات مزوّرة/معدّلة/منتهية، Origin/Referer، Host header، طرق HTTP، `--path-as-is`، أجسام 2MB، سقف المعدل، Turnstile replay، IDOR عبر مستخدمين مبذورين في `data/qa.sqlite`، CSRF الإدارة، وOTP flow.
5. **لا قيم أسرار:** قُرئت `.env.local` في الذاكرة فقط لاشتقاق تواقيع اختبارية وفحص الحزمة؛ لم تُطبع أي قيمة سر في أي مخرج أو وثيقة.
6. **عدم التدخل في دورة حياة الخوادم:** لم يبدأ/يُقتل أي خادم، ولم تُمسّ `.next` أو `.env.local` أو `package.json`.

## 2. بيئة الاختبار والقيود

| البيئة | الغرض | ما تحقّق | قيود |
| --- | --- | --- | --- |
| dev :3211 | استكشاف أولي قبل الإصلاحات | 401/403/405/303، ترويسات، جلسة مزوّرة مقبولة (HMAC صحيح) قبل إصلاح الحالة | توقّف الخادم أثناء `next build` الذي نفّذه Lead |
| production :3213 | سلوك إنتاج فعلي | ترويسات HSTS/CSP/COOP، 403 origin، 503 fail-closed لـ Turnstile محلي، سقف 429، 401 للأجسام الضخمة، 305/405، open-redirect عبر Host | مفاتيح المزودين فارغة (لا استدعاء حي ممكن)، قاعدة فارغة (لا يمكن إنشاء جلسة شرعية) |
| harness :3212 | authz مصادَق + Turnstile/OTP بمحاكاة | جلسات شرعية لمستخدمين مبذورين (200/307)، الإدارة 403/200/303، IDOR 404/200، Turnstile replay 403 reused، OTP 429s، سقف معدل 429 | Turnstile/siteverify وOTP/SMS مزوّدان بمحاكاة خادمية؛ لا رمز Google حقيقي |

**قيود جوهرية:** لا يوجد تدفق Google حقيقي (لا يمكن الحصول على ID token بدون حساب) لذلك لم يُختبر إصدار الجلسة نفسه حيًا؛ بدلًا من ذلك تم تزوير كوكي بتوقيع HMAC صحيح بسر معروف (مُصرّح) لاختبار الطبقة التي تليه. لا استدعاء Cloudflare حقيقي: على :3211 أُرسل رمز وهمي فعاد 403 `remote` (اتصال حقيقي بالخدمة)، وعلى :3213 fail-closed قبل الخدمة، وعلى :3212 محاكاة. **لا استدعاء Anthropic/OpenRouter حي في أي اختبار.**

## 3. جدول النتائج

| ID | الشدة | العنوان | الحالة |
| --- | --- | --- | --- |
| H-01 | High | مسار تكلفة خفي: استدعاء Haiku حي مفعّل بكود ثابت بينما الوثائق تنفي ذلك | **Fixed** (Lead أثناء التدقيق) |
| H-02 | Medium-High | جلسة موقّعة تتجاهل الإيقاف وسحب الجلسات (`session_valid_after`) | **Fixed** (هذا التدقيق) |
| M-01 | Medium | غياب فحص Origin/CSRF على مسارات الحالة غير الإدارية (الاعتماد على SameSite=Lax فقط) | **Fixed جزئيًا** (guard.gateTurnstile + intent؛ `/api/theme` pending) |
| M-02 | Medium | قبول أجسام JSON بلا حد أعلى (DoS تخصيص ذاكرة) | **Fixed** |
| M-03 | Medium | غياب تحديد معدل على الدخول/OTP/توليد nonce | **Fixed** (قيود عملية موثّقة) |
| M-04 | Medium | سباق عدّاد محاولات OTP يسمح بتجربة متوازية تتجاوز 5 محاولات | **Fixed** (مالك OTP أثناء التدقيق) |
| M-05 | Medium | CSP الإنتاج يسمح `script-src 'unsafe-inline'` بلا nonce | **Accepted risk** (موصى به للـ Lead) |
| L-01 | Low | Open redirect عبر Host header في `POST /api/theme` + غياب CSRF للتبديل | **Proposed** (خارج نطاق كتابتي) |
| L-02 | Low | استنتاج Secure-cookie من `APP_URL` مع fallback ثابت `localhost:3000` | **Fixed جزئيًا** (sessionCookie يفرض Secure في الإنتاج) |
| L-03 | Low | غياب `Cache-Control: no-store` على استجابات حساسة | **Proposed** |
| L-04 | Low | Turnstile replay يتراجع إلى ذاكرة محدودة عند تعذّر SQLite | **Accepted risk** |
| L-05 | Low | الثقة بـ `x-forwarded-host`/رؤوس IP عند فحص Turnstile | **Accepted risk** (الفحص الحاسم من Cloudflare) |
| L-06 | Low | مسار إدارة بالبريد (`ADMIN_EMAILS`) مُفعّل بدل `ADMIN_GOOGLE_SUBS` | **Accepted risk/Config** |
| L-07 | Low | إنشاء مقارنات بنماذج محجوبة فقط بلا استهلاك حصة (إساءة موارد) | **Accepted risk** |
| L-08 | Low | سباق عدّاد إعادة إرسال OTP (count ثم insert بلا معاملة) | **Proposed** |
| I-01..I-12 | Info | XSS/SQLi/SSRF/IDOR/سجل/ترويسات/تبعيات/أسرار/أخطاء — لا خلل | **Verified** |

## 4. النتائج المفصلة

### H-01 — مسار تكلفة خفي: Haiku حي مفعّل بكود ثابت (High) — Fixed by Lead

- **الملفات (قبل الإصلاح):** `src/domain/models/haiku.ts:6` كان `HAIKU_LIVE_CALLS_ENABLED = true`؛ `src/server/comparisons/execute.ts:114` يمرّر المفتاح الحقيقي إلى `dispatchModel`؛ `src/domain/models/dispatch.ts:77` كان يمرّر `allowLive: true`.
- **التعارض:** `docs/architecture.md:32` («ولا يُرسل حيًا في هذا البناء») و`docs/launch-and-secret-rotation.md:3` («لا يُفعَّل استدعاء Haiku الحي») مقابل `tests/product.test.ts:272` الذي كان يؤكد `HAIKU_LIVE_CALLS_ENABLED === true`. أي مستخدم مكتمل الملف (جوال موثّق) يختار `claude-haiku-5-5` كان سيولّد فاتورة Anthropic حقيقية بصمت.
- **الدليل:** قراءة الملفات أعلاه + `.env.local` يحتوي `ANTHROPIC_API_KEY` غير فارغ (اسم فقط). لم يُجرَّب الاستدعاء الحقيقي (ممنوع)؛ التقييم ساكن + عقلي (path analysis).
- **الإصلاح (Lead):** `haikuLiveCallsEnabled(env)` في `src/domain/models/haiku.ts:12-14` يشترط `HAIKU_LIVE_CALLS === "1"`؛ `postHaiku` يفحصه (`haiku.ts:78`)؛ `dispatch.ts:79` يمرّر `haikuLiveCallsEnabled(deps.env)`؛ `.env.example` يوثّق `HAIKU_LIVE_CALLS=0`.
- **التحقق:** `tests/security-regressions.test.ts` (3 اختبارات): الافتراضي معطّل، `allowLive:true` وحده لا يكفي، ولا اتصال بـ fetch عند التعطيل. `npm test` أخضر.
- **المتبقي:** تدوير `ANTHROPIC_API_KEY` و`OPENROUTER_API_KEY` (SECRETS-INVENTORY)؛ التزامن بين الوثائق والكود عبر فحص بدء تشغيل يمنع `HAIKU_LIVE_CALLS=1` في إنتاج غير مرغوب.

### H-02 — جلسة موقّعة تتجاهل الإيقاف وسحب الجلسات (Medium-High) — Fixed

- **الملفات (قبل الإصلاح):** `src/server/google-session.ts:4-11` كان يتحقق من HMAC و`exp` فقط؛ `src/server/admin/actions.ts:48` يستدعي `endUserSessions` التي تكتب `users.session_valid_after` (`src/server/account-access.ts:4-8`)، لكن لا مسار قراءة يفحص ذلك. `src/app/api/comparisons/[id]/route.ts` و`src/app/workspace/page.tsx` يصادقان بالكوكي فقط.
- **الأثر:** مستخدم موقوف (أو حُذف حسابه) يظل يقرأ صفحاته ومقارناته حتى 14 يومًا؛ «سحب الجلسات» الإداري كان بلا أثر على واجهات API/الصفحات (POST المقارنة وحده كان يُحجب لاحقًا عبر `modelUseBlock`).
- **الدليل الحي (harness :3212):**
  - قبل الإصلاح (dev :3211، جلسة مزوّرة لمستخدم غير موجود): `GET /workspace → 200`.
  - بعد الإصلاح: مستخدم نشط مبذور → `200`؛ موقوف → `307 location=/`؛ `session_valid_after` في المستقبل → `307`؛ توقيع معدّل → `307`.
- **الإصلاح:** `storedSessionAllows` (`src/domain/auth/session.ts:79-97`) يفحص `suspensionActive` و`sessionStillValid` ويرفض الرموز بلا `iat` بعد السحب؛ `verifiedSession` (`src/server/google-session.ts:17-33`) يحمّل `readSessionStanding` (`src/server/account-access.ts:16-29`) ويفشل مغلقًا عند أي خطأ مخزن؛ `sessionCookie` يفرض `Secure` في الإنتاج (`session.ts:56-69`).
- **التحقق:** `tests/security-session.test.ts` (20 اختبارًا) + تعديل `tests/shortcut-plan.test.ts` لتمرير مخزن معزول + `tests/otp-route.test.ts` (حدّثه مالك OTP) — كلها خضراء.
- **ملاحظة تصميم:** جدول `sessions` (`migrations/001_init.sql:29-35`) غير مستخدم للمصادقة (لا يُدرَج فيه شيء عند الدخول). الإصلاح يعتمد على صف `users` + `session_valid_after`؛ إدخال جدول جلسات حقيقي (jti/hash) يبقى تحسينًا مستقبليًا.

### M-01 — غياب فحص Origin/CSRF على مسارات الحالة غير الإدارية (Medium) — Fixed جزئيًا

- **قبل:** فحص Origin+CSRF موجود فقط في `POST /api/admin/users` (`src/server/admin/http.ts:44-49`, `src/domain/admin/gate.ts:32-48`). المسارات `/api/auth/google`، `/api/auth/google/intent`، `/api/comparisons`، `/api/uploads`، `/api/otp/send`، و`/api/theme` لم تكن تفحص Origin. الضابط الوحيد SameSite=Lax على `chate_session` (`src/domain/auth/session.ts`, `sessionCookie`).
- **دليل قبل الإصلاح (dev :3211):** `POST /api/auth/google` مع `Origin: https://evil.example` ورمز وهمي → تجاوز فحص الأصل ووصل إلى siteverify وعاد `403 remote`؛ لو كان لدى المهاجم nonce+cookie لكان CSRF ممكّنًا في المتصفحات التي ترسل كوكي الطرف الثالث.
- **الإصلاح:** `sameOriginRequest` (`src/server/guard.ts:82-118`) يسمح بغياب Origin/Referer (عملاء غير متصفح)، ويرفض Origin غير مطابق لـ Host أو `x-forwarded-host` أو origin الطلب، ويرفض `Origin: null` والـ malformed. يُستدعى أولًا في `gateTurnstile` (`guard.ts:202-213`) فيغطي login/otp/comparison/upload، وأُضيف إلى intent (`src/app/api/auth/google/intent/route.ts:11-13`) مع سقف معدل.
- **الدليل بعد الإصلاح (prod :3213):** `login + Origin evil → 403 {"code":"origin"}`؛ `Origin: null → 403 origin`؛ (harness) `comparison + Origin evil → 403 origin`.
- **المتبقي:** `/api/theme` خارج نطاق كتابتي — لا Origin/CSRF (انظر L-01). يبقى SameSite=Lax ضابطًا أساسيًا؛ يوصى بوسيط CSRF موحّد أو توكن لكل النماذج مستقبلًا.
- **التحقق:** `tests/security-guard.test.ts` (origin + throttle + intent) خضراء.

### M-02 — قبول أجسام JSON بلا حد أعلى (Medium) — Fixed

- **قبل:** `readJson` كان `request.text()` غير محدود (`src/server/guard.ts` سابقًا)؛ كل مسارات JSON تمر به. جُرّب حيًا على dev: جسم 2MB إلى `POST /api/auth/google` قُبل وقُرئ في 34ms قبل رفضه منطقيًا.
- **الإصلاح:** `MAX_JSON_BYTES = 1 MiB` (`src/server/guard.ts:14`) مع فحص `content-length` مبكر وقراءة متدفقة تتوقف عند تجاوز السقف وتعيد `{}` (نفس مسار JSON غير الصالح) حتى تبقى الاستجابات 4xx عادية (`readJson` `guard.ts:17-56`).
- **الدليل بعد الإصلاح:** prod :3213 جسم 2MB → `401` خلال 7-8ms بلا تخصيص كامل؛ harness كذلك. اختبارات `security-guard.test.ts`: جسم معلن كبير، جسم chunked يتجاوز السقف، وجسم تحت السقف.

### M-03 — غياب تحديد معدل (Medium) — Fixed

- **قبل:** 12 طلبًا متتاليًا إلى `POST /api/auth/google/intent` على dev :3211 أعادت 12×200 بلا 429؛ لا سقف على login/OTP.
- **الإصلاح:** token-bucket في الذاكرة (`src/server/guard.ts:120-195`): سعة 20/دقيقة لكل IP (60/دقيقة لمفتاح `local` غير المعروف خلف وكيل)، مفتاح `kind:clientAddress`، `retry-after`، وتنظيف؛ مطبّق على login/otp داخل `gateTurnstile` (`guard.ts:210-213`) وعلى intent (`intent/route.ts:12-13`).
- **الدليل الحي:** prod :3213: 20 طلب login → `503 TURNSTILE_LOCALHOST` ثم الطلب 21 → `429 {"code":"rate_limit"}` مع `retry-after: 3`. harness :3212: نفس النتيجة (20×403 ثم 429). intent: 21 طلبًا في اختبار الوحدة → 429.
- **قيود معلنة:** الذاكرة لكل عملية؛ مع عدة عمليات/إعادة تشغيل تُصفَّر. لا يغني عن WAF/حدود المزود. المسارات المصادَقة (comparison/upload) لا تُحدّ هنا (تخضع لجلسة/حصاد/Turnstile) — يوصى بحد لكل مستخدم.

### M-04 — سباق عدّاد محاولات OTP (Medium) — Fixed بواسطة مالك OTP

- **قبل:** `src/server/otp/service.ts` كانت `incrementAttempts` تقرأ المحاولات ثم تُعيد كتابة قيمة محسوبة، والمسار كان يقرأ/يتحقق/يزيد دون معاملة؛ طلبات متوازية تُخفي المحاولات ويمكن أن تتجاوز `OTP_MAX_ATTEMPTS = 5` (رموز 6 أرقام) — خطر تخمين/إغراق.
- **الإصلاح (current):** `incrementAttempts` أصبح `UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL` ثم قراءة القيمة (`src/server/otp/service.ts:74-82`)، والمسار يستخدم القيمة المرجعة (`src/app/api/otp/verify/route.ts:42-52`). لا تزال محاولة الاستهلاك داخل `immediateTransaction` (`verify/route.ts:59-64`).
- **الدليل الحي (harness):** إرسال 1..3 → `200`، الإرسال 4 → `429 OTP_RESEND` (حد 15 دقيقة من قاعدة البيانات)؛ 5 محاولات خاطئة متتالية → `remainingAttempts` 4,3,2,1 ثم `429 OTP_ATTEMPTS`، والمحاولة السادسة تبقى 429.
- **المتبقي:** لا سقف معدل على `POST /api/otp/verify` نفسه (الحد عبر العدّاد الذري وقفل المحاولات، ويحتاج جلسة)؛ وسباق عدّاد الإرسال (L-08).

### M-05 — CSP الإنتاج يسمح script-src 'unsafe-inline' (Medium) — Accepted risk

- **الدليل:** `src/domain/security/headers.ts:1-19`؛ ترويسة الإنتاج الحية على :3213: `script-src 'self' 'unsafe-inline' https://accounts.google.com https://challenges.cloudflare.com` بلا nonce، مع `object-src 'none'` و`base-uri 'self'` و`frame-ancestors 'none'` و`form-action 'self'`.
- **التقييم:** لا يوجد حاليًا أي مصرف HTML غير آمن (انظر I-01)، لذا الخطر عملي منخفض؛ لكن `unsafe-inline` يبطل الحماية عند أول خلل مستقبلي. Next.js يحقن سكربتات bootstrap سطرية؛ الحل الصحيح nonce عبر middleware + `strict-dynamic`، وهو تغيير معمارية خارج نطاقي.
- **الحالة:** Accepted risk بموافقة Lead (لا تغيير). أُضيف `Cross-Origin-Opener-Policy: same-origin-allow-popups` و`X-Permitted-Cross-Domain-Policies: none` (`headers.ts:27-28`) وظهرا حيًا على :3213.

### L-01 — Open redirect عبر Host header في /api/theme + غياب CSRF (Low) — Proposed

- **الدليل الحي (prod :3213):** `curl -X POST -H 'Host: evil.example' -H 'Referer: http://evil.example/phish' http://127.0.0.1:3213/api/theme` → `303 location: http://evil.example/phish`. الكود: `src/domain/theme-return.ts:4-17` يضيف `Host` إلى أصول مسموحة؛ `33-47` يعيد التوجيه إلى origin الـ Referer المطابق؛ `src/app/api/theme/route.ts:6-8` بلا فحص Origin/CSRF.
- **قابلية الاستغلال:** تتطلب التحكم برأس Host الذي يراه التطبيق (reverse proxy يمرر Host عشوائيًا، vhost confusion، أو cache poisoning). المتصفح العادي: Referer من أصل خارجي → إعادة توجيه إلى `/` (تم التحقق: cross-site referer → location `/`). لذلك Impact limited/Phishing/redirect chain فقط.
- **الإصلاح المقترح (Lead scope):** اشتقاق الأصل المسموح من `APP_URL` فقط بدل `Host/request.url`؛ رفض أي Host لا يطابق قائمة الإنتاج؛ إضافة فحص Origin/CSRF لتوجيه المظهر. الحالة: **Proposed** — خارج `src/domain/auth`/`security`/`server/guard*` التي أملكها (نُقل للـ Lead).

### L-02 — APP_URL fallback و Secure-cookie (Low) — Fixed جزئيًا

- **الدليل:** `src/app/api/auth/google/route.ts:79` يشتق `https` من `process.env.APP_URL ?? "http://localhost:3000"`؛ إن غاب/أخطأ APP_URL يصبح كوكي الجلسة غير Secure حتى في الإنتاج (ثم HSTS يعوّض بعد أول زيارة HTTPS). لوحظ أثناء التدقيق أن `.env.local` كان `APP_URL=http://localhost:3000` بينما التطوير على 3211 (16:24)، وصُحّح إلى 3211 (16:27) — دليل عملي على أن الخطأ وارد.
- **الإصلاح:** `sessionCookie` يفرض `secure: https || NODE_ENV === "production"` (`src/domain/auth/session.ts:56-69`)، فلا يخرج كوكي جلسة غير Secure في الإنتاج مهما كان APP_URL. 
- **المتبقي:** إزالة fallback من مسار الدخول (Lead scope) وإضافة تحقق بدء تشغيل: APP_URL origin مطابق، https في الإنتاج.

### L-03 — غياب Cache-Control: no-store على استجابات حساسة (Low) — Proposed

- **الدليل الحي:** `GET /api/comparisons/:id` (401 على :3213) و`GET /api/admin/overview` (401) بلا `cache-control`؛ استجابة 200 للمقارنة (harness, بيانات مستخدم) بلا no-store. مسار جلب المقارنة لا يضبط `no-store` (بينما مسار الإدارة الناجح يضبطه عبر `no-store` في `src/server/admin/http.ts:73-75`).
- **الأثر:** كاش المتصفح/الوسيط قد يخزّن بيانات مستخدم؛ لا CDN مشترك هنا لكنه هشّ. الإصلاح المقترح: `Cache-Control: no-store` على كل استجابات المقارنات والجلسة.

### L-04 — Turnstile replay fallback إلى الذاكرة (Low) — Accepted risk

- **الدليل:** `src/server/turnstile-replay.ts:7-15,23-38,41-73,87-93`: المرجع الحاسم صف SQLite `turnstile_tokens`؛ عند فشل القاعدة/الجدول يُستخدم Map بسعة 2048 مع طرد الأقدم. تحقق: `tests/security-hardening.test.ts` + `tests/security-regressions.test.ts` (fallback، concurrency، digest فقط). عند >2048 توكن في 10 دقائق مع قاعدة معطلة، يمكن نظريًا إعادة استخدام رمز مُبعد — يتطلب تعطّل SQLite (الاعتماد الأساسي) وحملًا كبيرًا. الحالة: Accepted risk مع توصية بالرفض المغلق في الإنتاج إذا تعذّرت القاعدة.

### L-05 — الثقة بـ x-forwarded-host/IP في فحص Turnstile (Low) — Accepted risk

- **الدليل:** `src/server/turnstile.ts:12-21`: `requestHostname` يفضّل `x-forwarded-host`، و`requestClientIp` يثق بـ `cf-connecting-ip`/`x-forwarded-for`. الفحص الحاسم يبقى `remote.hostname`+`remote.action`+`challenge_ts` من Cloudflare (`src/domain/auth/turnstile.ts:26-49`) والتوثيق يصعب تزويره. لا يوجد تجاوز مُثبت محليًا. التوصية: وثّق أن التطبيق خلف وكيل يفرض/ينظف هذه الرؤوس، أو قدم وضع `TRUST_PROXY`.

### L-06 — مسار إدارة بالبريد مُفعّل (Low/Config) — Accepted risk

- **الدليل:** `.env.local` فيه `ADMIN_EMAILS` (عنصر واحد) بينما `ADMIN_GOOGLE_SUBS` فارغ (أسماء/أعداد فقط). المنطق يتطلب مطابقة الحساب المخزّن مع الجلسة (`src/domain/admin/gate.ts:10-25`) وبريد Google موثّقًا (`src/domain/auth/google.ts:27-29`)؛ تحقق حي: مستخدم غير إداري → 403، حساب `qa-admin@example.com` → 200، إيقاف الذات → مرفوض. المخاطرة: الاعتماد على بريد قابل للتغيير بدل `sub` الثابت. التوصية: `ADMIN_GOOGLE_SUBS` أساسًا، والاحتفاظ بالبريد كاحتياط موثّق.

### L-07 — إساءة موارد بلا حصة: مقارنات بنماذج محجوبة فقط (Low) — Accepted risk

- **الدليل:** `parseComparisonBody` يقبل أي معرّف (`src/domain/comparison/input.ts:20-25`)؛ `planRuns` يحوّل النماذج المحجوبة إلى `policy_blocked` بلا طلب (`src/domain/comparison/plan.ts:131-141`)؛ `countUnits` يتخطى غير الـ queued فلا حجز (`src/server/comparisons/store.ts:264-272`)، لكن يُدرج صف مقارنة+job. تحقق حي (harness): `POST /api/comparisons` بنموذج `thinkingmachines/inkling:free` + توكن Turnstile صالح → 200 وصُنع صف بلا استدعاء مزود. الأثر: نمو قاعدة/عدّادات بمعدل Turnstile المسموح. التوصية: رفض الطلب إذا لم يكن أي run قابلًا للتنفيذ + سقف لكل مستخدم.

### L-08 — سباق عدّاد إعادة إرسال OTP (Low) — Proposed

- **الدليل:** `src/app/api/otp/send/route.ts:47-51` يقرأ `countRecentSends` ثم تُدرج المحاولة لاحقًا (`insertChallenge`، السطور 75-79) بلا معاملة واحدة؛ طلبات متزامنة (كل منها برمز Turnstile صالح مختلف) قد تتجاوز 3 إرسالات/15د. التحقق الحي التسلسلي: 3×200 ثم 429 `OTP_RESEND`. التوصية: لفّ العدّ+الإدراج في `immediateTransaction` مع قيد فريد مناسب، أو عدّاد ذري.

## 5. ما تم التحقق منه ولم يوجد فيه خلل

| المجال | التحقق | الدليل |
| --- | --- | --- |
| SQLi | كل الاستعلامات `prepare(...)` مع معاملات؛ ORDER BY من قائمة سماح؛ LIKE مهروب | `src/server/db/**`, `src/server/admin/users.ts:118-176`; حي: `?q=' OR 1=1--` أعاد 200 بلا تسريب؛ `GET /api/comparisons/' OR 1=1--` → 404 |
| IDOR | `readComparison` يقيّد `id AND user_id` | `src/server/comparisons/store.ts:93-99`; حي: مستخدم A يقرأ مقارنة B → 404، B → 200 (harness) |
| XSS | لا `dangerouslySetInnerHTML` ولا `innerHTML` ولا eval؛ React يهرّب النصوص؛ `escapeHtml` غير مستخدم | grep على `src`; `src/domain/security/markdown.ts` |
| SSRF | لا URL خارجي من المستخدم: Dispatch له عناوين ثابتة | `src/domain/models/dispatch.ts:8-9`, `src/domain/models/haiku.ts:4`؛ OTP URL من env فقط |
| Session HMAC | HMAC-SHA256، `timingSafeEqual`، حدود طول، `exp`/`iat`، رفض الأنواع | `src/domain/auth/session.ts:30-80`; حي: توقيع صحيح → 200، معدّل/منتهي/غير موقّع/قديم → 307 |
| رؤوس الأمان | HSTS، CSP بلا unsafe-eval، XFO DENY، COOP، nosniff، Referrer، Permissions، لا x-powered-by | حي على :3213/:3212 (قسم 8) |
| Turnstile | action مطابق، hostname محلي+بعيد، TTL 300s، single-use ذري | `src/domain/auth/turnstile.ts:26-49,92-149`; `src/server/turnstile*.ts`; حي: 200 ثم replay → 403 `reused`، wrong action → 403 `action`، missing → 403 |
| OTP | تجزئة pepper+sha256، `timingSafeEqual`، TTL 5د، 3 إرسالات/15د، 5 محاولات، استهلاك ذري | `src/domain/auth/otp.ts:23-57`; `src/app/api/otp/{send,verify}/route.ts`; `src/server/otp/service.ts:74-91`; حي: 3×200 ثم 429؛ 5 محاولات ثم 429 |
| Admin authz | هوية من الحساب المخزّن فقط + قائمة سماح + CSRF+Origin | `src/server/admin/http.ts:31-58`; `src/domain/admin/gate.ts:10-55`; حي: non-admin 403، admin 200، CSRF/Origin خاطئ 403، mutation صحيحة 303+audit، self-suspend مرفوض |
| بوابة الملف | تتحقق من الاسم/الجوال؛ لا يمكن تخطيها عبر API؛ الهاتف يُوثّق فقط بعد استهلاك تحدي OTP لتلك الجلسة | `src/domain/auth/profile.ts:33-38`, `src/domain/auth/model-gate.ts:12-24`, `verify/route.ts:59-68`; حي: مقارنة مجهولة 401؛ OTP مجهول 401 قبل Turnstile |
| رفع الملفات | Turnstile ثم 401، لا تخزين بايتات | `src/app/api/uploads/route.ts`; حي: 403 (dev) / 503 fail-closed (prod) / 401 مع جلسة+توكن (كود) |
| الأخطاء | رسائل عامة بلا traces؛ `publicError` يخفي غير AppError | `src/domain/errors.ts:14-19`; 401/403/404/405/429 حية بلا تسريب |
| الأسرار في الحزمة | `check:bundle` مع env محمّل: 14 ملفًا نظيفًا؛ لا أسماء/قيم في `.next/static` | `scripts/check-client-bundle.ts`; SECRETS-INVENTORY |
| التبعيات | `npm audit --omit=dev` = 0 ثغرات (147 حزمة إنتاج؛ 705 إجمالًا) | الأمر في قسم 8 |

## 6. مسارات fail-open / fail-closed

| المسار | السلوك عند الفشل | الحالة |
| --- | --- | --- |
| Turnstile غير مهيأ (secret/hostnames) | 503 فشل مغلق | صحيح (`src/domain/auth/turnstile.ts:104-121`) |
| Turnstile إنتاج + hostnames محلية | 503 `TURNSTILE_LOCALHOST` | صحيح؛ حي على :3213 |
| Turnstile remote timeout/خطأ | 403 `TURNSTILE_REMOTE` | فشل مغلق |
| Turnstile replay DB غير متاحة | fallback ذاكرة 2048 (L-04) | فشل متدرّج موثّق |
| فشل قراءة الحساب/القاعدة للجلسة | لا جلسة (401/307) | فشل مغلق (إصلاح H-02) |
| OTP provider غير مهيأ | 503 `OTP_FAIL_CLOSED` | فشل مغلق |
| OTP pepper غائب | 503 | فشل مغلق (`src/server/otp/config.ts`) |
| مفتاح Anthropic/OpenRouter غائب أو الـ flag معطّل | `failed` محلي بلا شبكة | فشل مغلق (H-01) |
| SQLite/معاملات | أخطاء 500 عامة، تراجع المعاملة | فشل مغلق |
| KILL/إلغاء | `cancelLocally` لا يدّعي إيقاف المزود | صحيح |
| Origin غائب (عملاء غير متصفح) | يُسمح (موثّق) | قرار تصميمي M-01 |

## 7. الإصلاحات المطبقة (هذا التدقيق) والتحقق

| الملف | التغيير | الاختبارات |
| --- | --- | --- |
| `src/domain/auth/session.ts` | `storedSessionAllows`، فرض Secure في الإنتاج، priority high | `tests/security-session.test.ts` |
| `src/server/account-access.ts` | `readSessionStanding` (قراءة فقط) | `security-session` |
| `src/server/google-session.ts` | فحص الحالة عند كل قراءة جلسة، fail-closed، حقن مخزن للاختبار | `security-session` + `shortcut-plan` |
| `src/server/guard.ts` | سقف 1MiB، same-origin، token-bucket، تطبيقها في gateTurnstile | `security-guard` |
| `src/app/api/auth/google/intent/route.ts` | Origin + سقف معدل (يحتاج إعادة بناء نهائية) | `security-guard` |
| `src/domain/security/headers.ts` | COOP + X-Permitted-Cross-Domain-Policies | `security-regressions` |
| `src/domain/security/redact.ts` | تنقية الرموز/المفاتيح داخل النصوص الحرة | `security-regressions` + `product` |
| `tests/shortcut-plan.test.ts`, `tests/otp-route.test.ts` | مواءمة الاختبارات القائمة مع فحص الحالة | `npm test` |

**نتائج أوامر التحقق (2026-10-28):**

```text
C:\Pak\npm.cmd run typecheck  -> exit 0 (tsc --noEmit, no output)
C:\Pak\npm.cmd run lint      -> exit 0 (eslint ., no output)
C:\Pak\npm.cmd test          -> Test Files 17 passed (17), Tests 186 passed (186)
C:\Pak\npm.cmd run check:bundle
   (with .env.local loaded via node --env-file):
   client bundle clean: 14 files, no server secret names or values
C:\Pak\npm.cmd audit --omit=dev -> 0 vulnerabilities (prod 147 / total 705)
```

## 8. سجل الهجمات (Attack log — مقتطفات قابلة للتكرار)

| # | الأمر/الطلب | النتيجة |
| --- | --- | --- |
| 1 | `curl -D - http://127.0.0.1:3213/` | 200؛ XFO DENY، CSP بلا unsafe-eval، COOP، HSTS، nosniff، لا X-Powered-By |
| 2 | `POST /api/auth/google` + `Origin: https://evil.example` (3213) | **403 origin**؛ `Origin: null` → 403 |
| 3 | `POST /api/auth/google` same-origin (3213) | 503 `TURNSTILE_LOCALHOST` (فشل مغلق لإعداد نطاقات محلية في الإنتاج) |
| 4 | 21× login بـ XFF ثابت (3213) | 20×503 ثم **429 rate_limit**, retry-after=3 |
| 5 | جسم 2,097,152 بايت إلى login (3213) | **401** خلال 8ms (سقف 1MiB) |
| 6 | `POST /api/theme` + `Host: evil.example` + Referer مطابق (3213) | **303 location: http://evil.example/phish** (L-01) |
| 7 | `POST /api/theme` بـ Origin/Referer خارجي | 303 location `/` (قائمة Referer تعمل) |
| 8 | جلسة مزوّرة صحيحة لمستخدم غير مخزّن (dev قبل الإصلاح) | 200؛ بعد الإصلاح (harness): 307 |
| 9 | جلسة صحيحة لمستخدم نشط/موقوف/مسحوبة (harness) | 200 / **307** / **307**؛ توقيع معدّل → 307 |
| 10 | `GET /api/comparisons/<مقارنة B>` بجلسة A ثم B (harness) | **404** ثم **200**؛ UUID عشوائي/حقن → 404 |
| 11 | `POST /api/comparisons` بتوكن Turnstile صالح ثم إعادة نفس التوكن (harness) | 200 (إنشاء) ثم **403 reused**؛ `turnstile_tokens` +1 فقط |
| 12 | Turnstile wrong action / missing (harness) | 403 `action` / 403 `missing` |
| 13 | `POST /api/otp/send` ×4 ثم verify خاطئ ×6 (harness) | 200×3 ثم **429 OTP_RESEND**؛ remainingAttempts 4→1 ثم **429 OTP_ATTEMPTS** |
| 14 | OTP send مجهول + توكن صالح؛ verify خاطئ | 401 anonymous (قبل Turnstile)؛ 403 OTP_MISSING |
| 15 | admin غير إداري / إداري (harness) | **403 not_admin** / **200** |
| 16 | admin mutation: origin غائب/خارجي/CSRF خاطئ/صحيح (harness) | 403 / 403 / 403 / **303 saved** + audit row؛ self-suspend → 303 rejected والحالة active |
| 17 | `GET /api/admin/overview?q=' OR 1=1--` (harness) | 200 بلا تسريب؛ صفحة admin وJSON لا تحتويان نص سؤال/جواب ولا أسماء/قيم أسرار |
| 18 | `GET /admin` مجهول (3213) | 200 صفحة "غير مصرّح" بلا بيانات |
| 19 | `/api/comparisons/..%2f..%2fpackage.json` (3213) | 401 (الجلسة أولًا)؛ 405 للطرق غير المدعومة |
| 20 | `TRACE /api/models` | 500 (لا كشف معلومات) — Info |

## 9. المخاطر المتبقية والمهام المقترحة

1. **إعادة بناء نهائية:** تضمين تغيير intent-route (`src/app/api/auth/google/intent/route.ts:11-13`) في بناء Lead النهائي ثم إعادة فحص `check:bundle` وترويسات الإنتاج.
2. **تدوير الأسرار:** `ANTHROPIC_API_KEY`، `OPENROUTER_API_KEY`، `SESSION_SECRET`، `TURNSTILE_SECRET_KEY` (تفاصيل في SECRETS-INVENTORY)؛ إضافة `OTP_PEPPER` مخصص بدل fallback إلى SESSION_SECRET.
3. **L-01/L-03/L-08:** رقعة `/api/theme` (منع Host header + Origin/CSRF)، `Cache-Control: no-store` على المقارنات، معاملة عدّاد إرسال OTP.
4. **CSP nonce (M-05):** غير مطلوب للإطلاق المحلي؛ يُنصح به قبل أي نشر عام.
5. **تحديد معدل موزّع:** الطبقة الحالية داخل العملية؛ عند التوسع أضف حدًا في الوكيل/WAF وحصة لكل مستخدم للمقارنات.
6. **جدول sessions:** توحيد جلسات قابلة للإلغاء (jti/hash في `sessions`) بدل الاعتماد على `users.session_valid_after` فقط.
7. **توثيق/كود Haiku:** فحص بدء تشغيل يمنع `HAIKU_LIVE_CALLS=1` خارج بيئة معتمدة، وتحديث الوثائق لتطابق الـ opt-in.

## 10. إعادة إنتاج سريع

```powershell
# 1) checks
C:\Pak\npm.cmd run typecheck; C:\Pak\npm.cmd run lint; C:\Pak\npm.cmd test
C:\Pak\node.exe --env-file=.env.local --import tsx scripts/check-client-bundle.ts

# 2) unauthenticated prod probes (no secrets required)
curl.exe -s -o NUL -D - http://127.0.0.1:3213/
curl.exe -s -o NUL -w '%{http_code}' http://127.0.0.1:3213/api/admin/overview      # 401
curl.exe -s -o NUL -w '%{http_code}' -X POST http://127.0.0.1:3213/api/uploads -H "Content-Type: application/json" --data "{}"   # 503 fail-closed

# 3) hosted regression tests
C:\Pak\npm.cmd test -- tests/security-session.test.ts tests/security-guard.test.ts tests/security-authz.test.ts tests/security-regressions.test.ts tests/security-otp.test.ts
```
