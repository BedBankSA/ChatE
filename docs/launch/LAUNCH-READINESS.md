# جاهزية الإطلاق التجاري — ChatE
# Commercial launch readiness — RAG scorecard & verdict

**التاريخ / Date:** 2026-10-28 · **المسؤول / Owner:** launch-commander (task-3) · **المراجع النهائي:** المالك.
**الطريقة:** فحص محلي فقط (كود + قاعدة بيانات + خادم تطوير على 3211 + أوامر). لا نشر عام، ولا استدعاء حقيقي لـ OpenRouter/Anthropic، ولا رسائل SMS حقيقية.
**حدود الأدلة (Evidence cutoff):** الأوامر والقياسات نُفِّذت 2026-10-28T16:24-16:35. بعدها كانت هناك تغييرات متزامنة غير مُودَعة في شجرة العمل (OTP الحقيقي، بوابة Haiku، تقوية guard/session) — تظهر في §4.1 ولم تُحتسب في الدرجات ولا في بوابات الإطلاق حتى تُختبر وتُدمج.
**هذا التقرير هندسي/تشغيلي، وليس رأيًا قانونيًا ولا تدقيقًا أمنيًا مستقلًا.**

---

## English executive summary

**Production audit: 44/100 — Blocked for a paid public launch. Private beta: CONDITIONAL GO after 6 gates.**

ChatE's comparison engine, SQLite quota accounting, Google ID-token sign-in, Turnstile replay protection, admin dashboard, production build and a real OTP send/verify flow exist today; the working tree passes typecheck, lint, a clean client-bundle scan and **185/185 tests in 17 files**, and a production-mode server was independently checked at 127.0.0.1:3213 (200 root, HSTS/CSP/COOP headers, admin 401, OTP 401). Migrations and online backup/restore were executed and verified. But the product still cannot be used end-to-end: at the evidence cutoff, phone verification was impossible because `POST /api/otp/send` always returned 503 (no UI, provider factory unused), and the phone gate blocks every model call before quota/Turnstile (`src/server/comparisons/handle.ts:29-30`, `src/domain/auth/model-gate.ts:12-24`). The OTP send/verify flow and UI now exist (uncommitted working tree) — real progress, but still unproven end-to-end and still missing a configured SMS provider/contract, so the phone gate still blocks model use until that is closed. Uploads are a 401 stub, history is static text, account deletion is text-only, retention is stored but never enforced, there is no health endpoint, no external alerting, no license file, and no public deployment has been executed (a local production-mode build/server at :3213 now exists). Haiku live calls were hard-coded on at the cutoff (`HAIKU_LIVE_CALLS_ENABLED=true`) and are now env-gated (`HAIKU_LIVE_CALLS=1` opt-in) — the owner spend decision still stands. **No paid public launch until: OTP end-to-end, uploads/deletion/retention, license, observability, payments (or an explicitly free product), and a staging deploy with TLS exist.** "Paid launch" additionally needs a billing product that does not exist at all.

---

## 1. تعريف البوابات / Gate definitions

| Gate | Meaning | Evidence standard |
| --- | --- | --- |
| **Private beta** | ≤20 invited users, owner-operated, no money, Arabic support by owner, staging-grade infra | Every blocker B1–B8 in §4 closed or explicitly waived in writing by the owner |
| **Public free launch** | Open signup, free quotas, public domain/TLS, support channel | Private-beta gates + B9–B13 + load test + support/legal pages corrected |
| **Paid public launch** | Charges money for comparisons/subscriptions | Public launch gates + billing/payment system (does not exist) + invoicing/refunds/tax + legal/DPIA review |

## 2. لوحة التقييم RAG / Scorecard

الرموز: 🟢 ≥70 جاهز · 🟡 50-69 جاهز بتحفظات · 🔴 <50 مانع. الدرجات إرشادية لفرز المخاطر، لا قياسًا رياضيًا.

| # | المجال | الدرجة | الحالة | الأدلة الأساسية |
| --- | --- | --- | --- | --- |
| 1 | اكتمال المنتج Product completeness | **35** | 🔴 | (delta: مسار OTP الحقيقي + واجهته في شجرة العمل غير المُودَعة §4.1 — لا يُحتسب حتى يُختبر E2E) محرك المقارنة موجود (`src/server/comparisons/handle.ts:17-88`) لكن بوابة الجوال تمنع كل استدعاء قبل الحصة (`handle.ts:29-30`، `src/domain/auth/model-gate.ts:12-24`); رفع الملفات يرجع 401 دائمًا (`src/app/api/uploads/route.ts:8`); السجل نص ثابت (`src/app/history/page.tsx:9-10`); المقارنة الافتراضية = 3 نماذج مجانية + Haiku (`src/domain/workspace-start.ts:5-10`) |
| 2 | الهوية والدخول Auth/identity | **55** | 🟡 | Google GIS + تحقق `aud`/nonce (`src/app/api/auth/google/route.ts:25-51`)، جلسة HMAC HttpOnly/Secure(when https)/Lax (`src/domain/auth/session.ts:48-55`)، 8 اختبارات دخول ناجحة؛ **لا يوجد OTP فعلي**، لا إلغاء جلسات فردي، لا MFA للإدارة |
| 3 | المدفوعات والحصص Payments/quotas | **25** | 🔴 | لا نظام دفع/اشتراك/فاتورة إطلاقًا (لا مسارات دفع في `src/app/api`); الحصص تعمل بمحاسبة منفصلة لكل مزود (`src/server/comparisons/store.ts:264-302,336-339`); لا سقف إنفاق مالي لـHaiku |
| 4 | البيانات والنسخ الاحتياطي Data/backup | **60** | 🟡 | WAL + busy_timeout + FK (`src/server/db/connection.ts:12-20`)؛ ترحيلات idempotent (**تم التحقق:** 5 هجرات، تشغيل ثانٍ `no pending migrations`)؛ نسخ/استعادة تحققت اليوم (**13 ms، 417,792 B، integrity=ok**)؛ **لكن** لا نسخ احتياطي دوري على خادم حقيقي بعد، ولا تنفيذ لسياسة الاحتفاظ (لا مرجع `RETENTION_*` في `src`) |
| 5 | الأمان Security | **65** | 🟡 | (delta: guard.ts الجديد يضيف سقف جسم 1MB + rate limit لكل عنوان + فحص Origin/Referer لمسارات Turnstile؛ لم يُختبر تزامنيًا) CSP/HSTS/Frame-DENY (`src/domain/security/headers.ts:1-36`, `next.config.ts:6-20`)؛ Turnstile مرة واحدة + siteverify + hostname/action (`src/domain/auth/turnstile.ts:26-49,92-149`)؛ إدارة: هوية مخزنة + CSRF + origin (`src/server/admin/http.ts:44-49,60-65`)؛ **لكن** لا rate limit على الدخول/OTP على مستوى التطبيق، CSP تسمح `unsafe-inline` للسكربت، لا فحص اعتماديات/CVE، لا مراجعة أمنية مستقلة |
| 6 | الأداء Performance | **55** | 🟡 | عملية Node واحدة تنفّذ المقارنات داخل الطلب (`src/server/comparisons/execute.ts:26-56`)؛ SQLite كاتب واحد؛ لا load test ولا قياس p95؛ حد المزود المجاني 20 rpm/1000 rpd (`docs/openrouter-model-registry.md:45-51`) |
| 7 | المراقبة Observability | **30** | 🔴 | لا `/api/health` (تحقق حي: 404)؛ التنبيه الخارجي غير موصول حرفيًا (`src/domain/admin/alerts.ts:42-44`)؛ لا Sentry/APM/OTel؛ السجلات = stderr منقّى فقط للأحداث القليلة (`src/domain/security/redact.ts:22-25`) |
| 8 | القانون والامتثال Legal/compliance | **15** | 🔴 | **لا ملف LICENSE** (لا يوجد في الجذر؛ `README.md:101-103`)؛ صفحات الخصوصية/الحساب تعِد بحذف غير منفّذ (`src/app/privacy/page.tsx:7`، `src/app/account/page.tsx:11`)؛ لا هوية متحكّم/جهة اتصال، لا DPIA، لا تنفيذ احتفاظ/حذف، لا موافقة شروط/سن |
| 9 | الدعم Support | **20** | 🔴 | لا بريد دعم/نموذج تواصل/حالة خدمة داخل المنتج أو الصفحات؛ لا FAQ للمستخدم؛ الدعم الحالي = المالك شخصيًا |
| 10 | العمليات Ops | **50** | 🟡 | حزمة نشر كاملة أُضيفت اليوم (`deploy/**`, `docs/launch/DEPLOYMENT-RUNBOOK.md`); **لكن** لا CI (لا `.github/**`)؛ لا staging؛ لا خادم/VPS/TLS/Cloudflare مُنفَّذ؛ لا ترقية/رجوع مجرَّبان |
| 11 | التوثيق Docs | **70** | 🟢 | README عربي/إنجليزي + `docs/architecture.md` + مواصفات ملزمة + `docs/test-results.md`؛ **انحراف:** `MODEL_TIMEOUT_MS`/`MAX_PROVIDER_RETRIES`/`RETENTION_*`/`STORAGE_DIR` موثقة وغير مقروءة في `src`؛ Haiku موثّق «غير حي» والكود `HAIKU_LIVE_CALLS_ENABLED=true` (`src/domain/models/haiku.ts:6`) |

**النتيجة المركبة / Weighted verdict:** متوسط 11 مجالًا = **44/100** → **Blocked** (وفق عتبات production-audit: 0-49 ممنوع، 50-69 خطر، 70-84 جاهز بتحفظات، 85+ قوي). سقف 84 ينطبق أيضًا: لا CI أخضر (لا CI)، والمسار الحرج (مقارنة ناجحة) لم يُختبر طرفًا لطرف.

## 3. الأحكام / Verdicts

| السيناريو | الحكم | الشرط |
| --- | --- | --- |
| **private beta** (دعوة، ≤20 مستخدمًا، بلا مال، مشغّل واحد) | **CONDITIONAL GO** | إغلاق البوابات G1-G6 في §5. لا يُفتح لأي مستخدم قبل G1 (OTP) فعليًا. |
| **public free launch** | **NO-GO** اليوم | يحتاج G1-G6 + G7-G10. |
| **paid public launch** | **NO-GO** | كل ما سبق + منتج دفع/فوترة غير موجود أصلًا (B7) + مراجعة قانونية/DPIA (B10) + مراقبة/دعم قبل أي مال. |

**ملاحظة إعادة تقييم (16:42):** بعد التحقق من البناء الإنتاجي و185 اختبارًا وبوابة Haiku وتقوية الحماية في شجرة العمل، التقدير المؤقت **≈47/100** (product 45، auth 62، security 72، ops 55، docs 72) — **يبقى Blocked** لأن الموانع الصلبة B2/B3/B4/B5/B7/B8/B10-B12 وقرارات المالك لم تتغير. لا تُرفع الدرجة الرسمية حتى الدمج + E2E staging + مزود SMS.

## 4. الموانع الصلبة / Hard blockers (بالترتيب)

| ID | المانع | الدليل | مطلوب لإغلاقه |
| --- | --- | --- | --- |
| **B1** | **بوابة الجوال تمنع استخدام النماذج. مسار OTP صار منفَّذًا فعليًا (send + verify + واجهة، 23 اختبارًا وفق task-6) لكنه بلا مزود SMS مُهيأ وبلا إثبات حي/E2E — لا يُغلق المانع حتى يُختبر على staging.** | عند القطع: `src/app/api/otp/send/route.ts:8-11` (503 دائمًا) و`createOtpProvider` بلا مستدعٍ؛ **الآن (غير مُودَع):** `src/app/api/otp/send/route.ts` يعيد كتابة كاملة، `src/app/api/otp/verify/route.ts` جديد، `src/components/otp-request.tsx` + `src/app/profile/complete/page.tsx` واجهة، `src/server/otp/*`؛ تبقى بوابة الجوال `src/server/comparisons/handle.ts:29-30` + `src/domain/auth/model-gate.ts:12-24` | [Lead] دمج + اختبار E2E على staging مع مزود SMS حقيقي؛ دليل: `phone_verified_at` غير فارغ ثم مقارنة تصل `dispatchModel` |
| **B2** | لا نشر عام/نطاق/TLS/اعتمادات بنية تحتية. | `README.md:42,119`؛ لا `deploy/` قبل اليوم؛ الخادم الحالي `next dev` على 127.0.0.1:3211 | تنفيذ `DEPLOYMENT-RUNBOOK.md` على staging ثم prod |
| **B3** | رفع/تخزين/ربط الملفات غير مكتمل: المسار يعيد 401 دائمًا ويمرّر مرفقات فارغة. | `src/app/api/uploads/route.ts:8`؛ `src/server/comparisons/handle.ts:41`؛ لا مجلد `storage` | قرار منتج: إما تنفيذ الرفع أو إزالة الادعاء من الواجهة/الخصوصية قبل الإطلاق |
| **B4** | السجل نص ثابت، وحذف الحساب غير منفّذ رغم الوعود. | `src/app/history/page.tsx:9-10`؛ `src/app/account/page.tsx:11`؛ لا مسار DELETE في `src/app/api`؛ لا استدعاء حذف في `src` | تنفيذ حذف/سجل أو تصحيح النصوص (قرار مالك) |
| **B5** | لا ترخيص للمشروع. | لا `LICENSE` في الجذر؛ `README.md:101-103` | قرار مالك: ترخيص مفتوح أو «كل الحقوق محفوظة» + شروط استخدام |
| **B6** | لا إثبات استدعاء مزود حي واحد (OpenRouter أو Anthropic). | `README.md:95,120`؛ `docs/test-results.md:3,51` | اختبار مضبوط واحد لكل مزود في staging بميزانية موافَق عليها |
| **B7** | **لا نظام دفع إطلاقًا** (لا checkout/webhooks/اشتراكات/فواتير) — «الإطلاق المدفوع» غير قابل للتنفيذ منتجيًا. | لا مسارات دفع في `src/app/api`؛ لا تبعيات دفع في `package.json:17-33` | قرار مالك: إطلاق مجاني باسمه، أو بناء دفع كامل + محاسبة |
| **B8** | لا مزود SMS مُهيأ (قيمة المزود غائبة في `.env.local`، والمثال `fake`، والإنتاج يقبل `http` فقط). | `.env.example:52-57`؛ `src/domain/auth/otp.ts:94-99`؛ فحص مفاتيح `.env.local`: `OTP_PROVIDER` غائب | عقد مزود SMS + مفتاح API + `OTP_PEPPER` + اختبار إرسال/استلام |
| **B9** | (خُفِّف في شجرة العمل) استدعاء Haiku الحي كان مفتوحًا بلا قاطع إنفاق، ويخالف الوثائق. الآن يُشترط `HAIKU_LIVE_CALLS=1` صراحةً؛ القرار المالي للمالك ما زال مطلوبًا. | عند القطع: `src/domain/models/haiku.ts:6` (`true`)؛ **الآن:** `haikuLiveCallsEnabled()` + `.env.example` يحوي `HAIKU_LIVE_CALLS=0` + `deploy/.env.production.example:HAIKU_LIVE_CALLS=0`؛ `src/domain/models/dispatch.ts:76-83` | إبقاء `HAIKU_LIVE_CALLS=0` في الإنتاج حتى قرار مكتوب بسقف إنفاق + تنبيه فاتورة؛ تحديث `README.md:95`/`docs/launch-and-secret-rotation.md` ليطابقا البوابة |
| **B10** | لا تنفيذ لسياسة الاحتفاظ ولا حق الحذف → التزام PDPL/GDPR غير قابل للتنفيذ. | `migrations/001_init.sql:204-209` (جدول فقط)؛ لا مرجع `RETENTION_*` في `src`؛ لا مسار حذف | مهمة تنفيذ retention + delete + سجل معالجة |
| **B11** | لا صحة خدمة/مراقبة/تنبيه خارجي. | `/api/health` → 404 (تحقق حي)؛ `src/domain/admin/alerts.ts:42-44` | تنفيذ `/api/health` + APM/Sentry + تنبيه خارجي |
| **B12** | لا قناة دعم داخل المنتج، وصفحات قانونية بلا هوية متحكّم/اتصال. | `src/app/privacy/page.tsx:1-19`؛ `src/app/terms/page.tsx:1-11` | بريد دعم، هوية الكيان، صفحة حالة، سياسة استجابة |
| **B13** | لا CI ولا staging ولا اختبار E2E متصفح. | لا `.github/**`؛ `docs/test-results.md:52` | CI (typecheck/lint/test/bundle) + staging + Playwright للمسار الحرج |
| **B14** | انحرافات إعداد/وثائق يجب إغلاقها قبل الإطلاق: `APP_URL` على 3000 بينما الخادم 3211؛ متغيرات موثقة غير مقروءة. | فحص `.env.local`: `APP_URL=http://localhost:3000`؛ `README.md:40`؛ `.env.example:43-44,63-65`؛ لا `STORAGE_DIR`/`RETENTION_*` في `src` | تصحيح `APP_URL` ونقل المتغيرات غير المنفذة إلى «مخطط» أو تنفيذها |

## 4.1 تغييرات متزامنة أثناء التدقيق (working tree، 16:35-16:45) — لا تُحتسب كإغلاق للموانع

| التغيير | الملفات | الأثر على التقييم | المطلوب قبل الاحتساب |
| --- | --- | --- | --- |
| OTP حقيقي: إرسال + تحقق + قيود إعادة إرسال + ربط بالجلسة | `src/app/api/otp/send/route.ts` (إعادة كتابة)، `src/app/api/otp/verify/route.ts` (جديد)، `src/server/otp/{config,phone,service}.ts` (جديد)، `src/components/otp-request.tsx`، `src/app/profile/complete/page.tsx` | يفتح الطريق لـB1/G1 | دمج + اختبارات جديدة تمر + مزود SMS + E2E staging |
| بوابة Haiku | `src/domain/models/haiku.ts` (`haikuLiveCallsEnabled`)، `src/domain/models/dispatch.ts`، `.env.example` (`HAIKU_LIVE_CALLS=0`) | يخفف B9 إلى قرار مالي فقط | قيمة `HAIKU_LIVE_CALLS=0` في الإنتاج + توثيق مطابق |
| تقوية الجلسات | `src/domain/auth/session.ts`، `src/server/google-session.ts`، `src/server/account-access.ts` | إلغاء أثر التوقيف/`session_valid_after` فورًا؛ فشل مغلق | اختبارات الجلسة تمر + لا كسر لدخول المالك |
| تقوية الحماية | `src/server/guard.ts` (سقف جسم 1MB، Origin/Referer، rate limit لكل عنوان)، `src/domain/security/headers.ts` (COOP + X-Permitted-Cross-Domain-Policies)، `src/domain/security/redact.ts` (تنقية قيم الأسرار) | يرفع الأمان ويقلل مخاطر الإساءة | إعادة `npm test` + تحقق حي بعد إعادة البناء |
| اختبارات OTP/أمان جديدة | `tests/otp-flow.test.ts`، `tests/otp-route.test.ts`، `tests/security-{session,guard,authz,otp,regressions}.test.ts` | **أُعيد تشغيلها 16:40: 185 اختبارًا في 17 ملفًا كلها ناجحة (8.36s)** — يرفع الثقة بالمسار لكنه لا يغني عن E2E staging ولا عن مزود SMS | دمج + إعادة فحص حي بعد البناء |

**قاعدة الاحتساب:** لا تُرفع أي درجة ولا يُغلق أي مانع بناءً على تغييرات غير مُودَعة وغير مُختبرة. أعد تشغيل `npm test` و`npm run typecheck` و`npm run lint` و`npm run check:bundle` بعد الدمج، ثم أعد تقييم B1/B9.

## 5. بوابات الإطلاق / Launch gates

### G1-G6: private beta (كلها إلزامية)
| Gate | Owner | Verification |
| --- | --- | --- |
| G1 OTP كامل: إرسال + تحقق + واجهة + جوال موثّق + وصول للمقارنة | Lead + owner | اختبار E2E على staging: دخول → OTP حقيقي → `profile.phone_verified_at` غير فارغ → مقارنة تصل للمزود |
| G2 staging منشور: VPS/Compose + Caddy TLS + Cloudflare + نطاقات Turnstile/Google إنتاجية | owner | `curl -sI https://staging...` يحوي HSTS؛ `/api/models` 200؛ Widget يتحقق |
| G3 نسخ احتياطي مجدول + تدريب استعادة منفّذ | owner/ops | `systemctl list-timers chate-backup.timer`؛ تقرير تدريب استعادة (integrity=ok، عدد الهجرات) |
| G4 قرار Haiku: تعطيل أو سقف إنفاق موثّق + تحديث الوثائق | owner | سطر قرار + قيمة الكود/البيئة + تحديث README/launch-and-secret-rotation |
| G5 حدود بيتا: ≤20 مستخدمًا مدرجين، مراقبة يدوية، بريد دعم منشور، تصحيح ادعاء الحذف في الصفحات | owner | قائمة مدعوين؛ بريد دعم في الصفحة؛ نص الخصوصية مطابق للواقع |
| G6 ترخيص/شروط: قرار ترخيص ونسخة شروط استخدام + موافقة صريحة | owner | ملف LICENSE أو بيان حقوق + Terms يقبلها المستخدم |

### G7-G10: public free / paid launch
| Gate | الشرط |
| --- | --- |
| G7 حذف/احتفاظ/تصدير بيانات منفّذ ومُختبر | delete route + retention job + audit + سياسة منشورة |
| G8 مراقبة: `/api/health` + error tracking + تنبيه خارجي + صفحة حالة | تنبيه تجريبي يصل فعلًا |
| G9 أداء: load test على staging (هدف مبدئي: p95 < 8s للرد الكامل، أخطاء < 1% عند 20 مستخدمًا متزامنًا) | تقرير حمل |
| G10 legal/DPIA + دعم + ترخيص + مراجعة شروط المزودين | مراجعة مالك/مستشار; DPIA مبدئي؛ DPA/MoU للمزودين |
| **G11 (مدفوع فقط)** نظام دفع/فاتورة/استرداد/ضريبة + اختبار webhook idempotency | لا يوجد اليوم |

## 6. نقاط القوة (موجزة، لا تُغني عن الموانع)

- محرك مقارنة بسياسة نماذج صارمة: لا مسار مدفوع، `openrouter/free` خارج المقارنة، Haiku لا يُستبدل صامتًا (`src/domain/models/dispatch.ts:47-74`، `src/domain/comparison/plan.ts:83-97`).
- محاسبة حصة ذرية داخل معاملة SQLite نفسها التي تُدرج المهمة (`src/server/comparisons/store.ts:28-91`) وحجز قبل الإرسال.
- فشل نموذج لا يوقف غيره (`Promise.allSettled` في `src/server/comparisons/execute.ts:50`).
- تحقق Turnstile خادمي صارم مع منع إعادة الاستخدام عبر SQLite، وفشل مغلق (`src/server/turnstile.ts:40-78`).
- رؤوس أمان جيدة + HSTS مشروط بالإنتاج (`next.config.ts:4-21`).
- بوابة إدارة بهوية مخزنة وCSRF/origin، ولا تعرض نص السؤال/الإجابة (`src/server/admin/http.ts:31-65`، `src/domain/admin/privacy.ts:1`).
- ترحيلات آمنة/متسلسلة + تحقق عملي اليوم، ونسخ احتياطي/استعادة بقاعدة WAL تحقّق نجاحه.
- 78 اختبارًا/10 ملفات، typecheck/lint/bundle clean (السجل أدناه).

## 7. الأدلة المنفَّذة في هذه الجلسة / Commands run (measured)

| Command | Result |
| --- | --- |
| `node --version` / `npm --version` (`C:\Pak\node.exe`) | v24.22.1 / 11.19.1 |
| `npm run typecheck` | exit 0، بلا أخطاء |
| `npm run lint` | exit 0 |
| `npm test` (vitest 3.2.7) | **78 passed / 10 files / 0 failed**، 2.27s |
| `npm run check:bundle` | `client bundle clean: 14 files` |
| `npm run db:migrate` على `SQLITE_PATH` مؤقت | طُبّقت 001→005؛ تشغيل ثانٍ: `no pending migrations` |
| `VACUUM INTO` من DB حيّة (WAL) | 13 ms؛ 417,792 B؛ `integrity_check=ok` |
| استعادة النسخة لملف جديد | `integrity_check=ok`، 5 ترحيلات، 36 جدولًا، retention 90/30 |
| `GET /`، `/api/models`، `/privacy`، `/admin` على 3211 | 200 / 200 / 200 / 200 |
| `GET /api/health` | **404** (لا مسار) |
| `git status` / HEAD | `main`، 05fc1e8، شجرة نظيفة عدا `scripts/qa/` |
| `LICENSE` | **غير موجود** |
| فحص مفاتيح `.env.local` (بلا طباعة قيم) | الستة أسرار الخادم مضبوطة؛ `OTP_PROVIDER`/`OTP_HTTP_URL` **غائبان**؛ `APP_URL=http://localhost:3000` |
| عمليات node الجارية | `next dev --port 3211` فقط؛ **لا worker** |
| `git status` بعد القطع | ظهرت تغييرات متزامنة (OTP/Haiku/guard/session) + اختبارات جديدة |
| `npm test` **بعد** التغييرات المتزامنة (16:40، شجرة عمل غير مُودَعة) | **185 passed / 17 files / 0 failed**، 8.36s (يشمل 12 اختبار OTP + 55 أمان) |
| `typecheck+lint+check:bundle` بعد التغييرات (16:41) | exit 0 / exit 0 / `clean: 14 files` |
| **بناء إنتاجي** (`next build`، 16:4x، وفق تقرير الـLead) | ✅ PASSED: Next 16.4.3، 17/17 صفحة ثابتة، 20 مسارًا ديناميكيًا، typecheck 2.7s |
| **خادم إنتاجي محلي :3213** (تحقق مستقل من launch-commander 16:42) | `/`=200، `/api/models`=200، `/api/admin/overview`=401، `/api/otp/send`=401، `/api/otp/verify`=401، `/api/health`=404؛ رؤوس: HSTS، CSP بلا unsafe-eval، X-Frame DENY، nosniff، COOP، بلا X-Powered-By، no-store |
| إعادة تقييم مؤقتة بعد الدمج | product 45، auth 60، security 70 → الإجمالي ≈ **45/100** — ما زال Blocked؛ البوابات G1-G6 لم تُفتح |

## 8. مخاطر مختارة / Risk register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| استدعاء Haiku حي بالخطأ مع مفتاح موجود → فاتورة غير محدودة | متوسطة | مرتفع | B9: قرار `HAIKU_LIVE_CALLS_ENABLED=false` أو سقف إنفاق + سقف كلفة لكل طلب |
| فقدان بيانات SQLite بلا نسخة خارجية | متوسطة | مرتفع | G3: نسخ كل 6 ساعات + خارج الخادم + تدريب استعادة |
| حد OpenRouter 20 rpm/50 rpd يخنق البيتا | مرتفعة | متوسط | شراء ≥$10 رصيد → 1000 طلب/يوم؛ مراقبة 429 |
| نشر فوق .next من وضع dev | متوسطة | متوسط | بناء إنتاجي نظيف (`rm -rf .next` ثم `npm run build`) في مجلد release مستقل |
| فشل build بسبب جلب خطوط next/font بلا شبكة | منخفضة | متوسط | بناء على جهاز/خادم متصل؛ أو استضافة الخط محليًا (تغيير كود — خارج نطاقي) |
| PII في نسخ احتياطية غير مشفرة | مرتفعة | مرتفع | تشفير/تقييد `/var/backups` + نقل آمن + سياسة وصول |
| تسريب أسرار تطوير (موجودة في `.env.local`) | منخفضة | مرتفع | عدم نقلها للإنتاج؛ تدوير لكل مفاتيح الإنتاج جديدة |

## 9. الإجراء التالي / Next action

1. [Lead] دمج تغييرات OTP/Haiku/guard/session الجارية، ثم إعادة `typecheck+lint+test+check:bundle` ونشر نتيجتها؛ لا يُغلق B1 إلا باختبار OTP طرفًا لطرف على staging.
2. [Owner] مزود SMS (B8) + قرار Haiku المالي (B9) + ترخيص (B5) + تصحيح ادعاءات الحذف/الاحتفاظ (B4/B10).
3. [Ops] staging وفق `DEPLOYMENT-RUNBOOK.md` + تدريب استعادة + مراقبة uptime خارجية = G2/G3.
4. ثم أعد تقييم هذه اللوحة؛ لا تفتح لمستخدم خارجي قبل G1-G6.

---

## 10. تحديث بعد إصلاحات ECC المتوازية / Post-fix update (2026-10-28 ~17:20)

هذا القسم **يُحدِّث** التقييم أعلاه ولا يلغيه: كل ما فوقه التُقط قبل الدمج. التحقق المذكور هنا أُجري على شجرة العمل نفسها التي بُني منها `vMZH_347l9JjLHbF8SvV8` ثم أُعيد بناؤها بعد تعديلات الصفحات.

**البوابات المغلقة أو المُخفَّفة:**

| البند | الحالة الآن | الدليل |
| --- | --- | --- |
| B1 OTP | **مُخفَّف بقوة**: المسار + الواجهة + تخزين مجزّأ + حدود إرسال/محاولات، مع إثبات دورة HTTP حقيقية (loopback TLS) حتى `phone_verified_at`. يبقى مفتوحًا جزئيًا فقط لأن مزود SMS تجاري غير مهيأ. | `tests/otp-*`، `scripts/qa/verify-release.mjs` P07، `docs/evidence/release-verification-*.json` |
| B3 الملفات | **مغلق في الكود**: تخزين بايتات خاص، كشف نوع من المحتوى، استخراج PDF/DOCX/نص، ربط `attachmentIds`، صور أصلية للنماذج الداعمة؛ E2E رفع txt/pdf/png ومقارنة بـ3 مرفقات. غير منفّذ: رابط تنزيل، حذف ملفات، `RETENTION_FILE_DAYS`. | `tests/uploads*`، P08/P10، `src/server/files/**` |
| B4 السجل | **نصف مغلق**: السجل الحقيقي `/history` و`/history/[id]` و`GET /api/history` مع عزل حسابات؛ حذف الحساب ما زال بلا مسار. | `tests/history.test.ts`، P11/P12 |
| B5 الترخيص | **مغلق**: `LICENSE` MIT، حقوق 2026 BedBankSA، ومذكور في README. | `LICENSE` |
| B6 الاستدعاء الحي | **مغلق بدليل**: مقارنة حقيقية سجّلت Anthropic `claude-haiku-5-5` (433/6 توكن، $0.000046، 1935 ms) وOpenRouter `cohere/north-mini-code:free` (178/152، 2678 ms)، وفشل 429 لنموذجين لم يكسر البقية. | `docs/evidence/live-provider-calls.md`، P09 |
| B9 قرار Haiku | القاطع البيئي باقٍ (`HAIKU_LIVE_CALLS` غير مضبوط = متوقف). أُجري استدعاء حي واحد مخوَّل بتكلفة 0.000046 دولار داخل تحقق الإصدار فقط. | `.env.example`، `src/domain/models/haiku.ts` |
| B11 الصحة | **جزئي**: `GET /api/health` منفذ (DB readiness، بلا بيانات حساسة). التنبيه الخارجي/APM ما زال غائبًا. | `src/app/api/health/route.ts`، P01 |
| B13 CI | **جزئي**: `.github/workflows/ci.yml` موجود (بلا أسرار)؛ لم يُشغَّل على GitHub بعد، ولا staging، ولا Playwright. | `.github/workflows/ci.yml` |
| B14 APP_URL/متغيرات | `APP_URL=http://localhost:3211` صحيح محليًا؛ متغيرات `MAX_ZIP_*` و`DOWNLOAD_URL_TTL_SECONDS` ما زالت موثقة كـ«مخططة» في README. | `.env.example`، README |

**الأوامر المنفَّذة بعد الإصلاح:** `npm run typecheck` (0)، `npm run lint` (0)، `npm test` (**258/258 في 22 ملفًا**)، `npm run build` (نجاح، 17 صفحة ثابتة، 20+ مسارًا)، `npm run check:bundle` (14 ملفًا نظيفًا)، `verify-release --mode=mock` و`--mode=live` (**13 PASS / 0 FAIL / 1 SKIP** لكل وضع)، وترحيلات `001`→`006` على قاعدة نظيفة.

**ما بقي مانعًا (لم يتغير):** B2 النشر العام الدائم (VPS/TLS/نطاق/Cloudflare)، B7 المدفوعات، B8 مزود SMS تجاري، B10 تنفيذ الاحتفاظ/حذف الحساب، B11 المراقبة/التنبيه الخارجي، B12 الدعم/الامتثال القانوني، B13 staging + اختبار متصفح آلي، B4 حذف الحساب. **التقدير المؤقت: ≈62/100 (من 44) — ما زال Blocked لإطلاق عام/مدفوع، وPrivate beta مشروطة بإغلاق B8 وقرار الإطلاق.**
