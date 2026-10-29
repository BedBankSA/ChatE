# نتائج الاختبار والتحقق النهائي

**التاريخ:** 2026-10-28 · **آخر تحديث:** 18:55 محلي (بعد إصلاح مساحة العمل والإرسال وترقية مزودي 429) · **البناء:** Next.js 16.4.3 إنتاجي محلي (23 مسارًا ديناميكيًا + 1 ثابت) على شجرة العمل الحالية.

تسجّل هذه الوثيقة ما نُفِّذ فعليًا على شجرة العمل الحالية. لم يُنشر الموقع على استضافة دائمة. أُرسلت **رسالة SMS حقيقية واحدة على الأقل** عبر مزود 4jawaly إلى رقم المالك المعتمد وأُكملت دورة OTP كاملة (الدليل: `docs/evidence/sms-live.md`). أُجريت استدعاءات مزودي النماذج **الحية** في تحقق الإصدار وسُجّلت تكلفتها وأدلتها.

## الأوامر والنتائج

| الأمر | النتيجة |
| --- | --- |
| `npm run typecheck` | نجاح، 0 أخطاء |
| `npm run lint` | نجاح، 0 أخطاء |
| `npm test` | **نجاح: 388 اختبارًا في 28 ملفًا (387 ناجح، 0 فشل، 1 مُتخطى)** — منها ملفان جديدان: `comparison-limits.test.ts` (8) و`comparison-reliability.test.ts` (5)؛ واختبار SMS الحي مُتخطى افتراضيًا |
| `SMS_LIVE_TEST=1 vitest run tests/sms-live.test.ts` | **1/1 PASS** — إرسال SMS حقيقي عبر 4jawaly، ثم verify و`phone_verified_at` (2.4 ثانية) |
| `npm run build` | نجاح (Next.js 16.4.3، Turbopack) — 23 مسارًا ديناميكيًا + 1 ثابت |
| `npm run check:bundle` | نجاح: 14 ملفًا في `.next/static` بلا أسماء أو قيم أسرار |
| `npm run db:migrate` | **6 هجرات** (`001`→`006`) على قاعدة نظيفة، ثم "no pending migrations" |
| `node scripts/dev/verify-full-flow.mjs` | **14/14 PASS** — OTP كامل، مقارنة بـ4 نتائج، فشل Haiku مستقلًا، IDOR، إدارة |
| `node scripts/qa/run-e2e.mjs --static-only` (mock) | **19/19 PASS** — رؤوس، 404 عربي، Turnstile، OTP، إدارة، أسرار |
| `node scripts/qa/verify-release.mjs --mode=mock` | **13 PASS / 0 FAIL / 1 SKIP** |
| `node scripts/qa/verify-release.mjs --mode=live` | **13 PASS / 0 FAIL / 1 SKIP** — `providerCallsReal: true` |
| عرض عام مؤقت (Cloudflare quick tunnel) | **13/13 PASS** — `https://diana-middle-kings-doug.trycloudflare.com` (BUILD_ID `jR_rtk3Nwwq9EaAV5J_XZ`)؛ ليس نشرًا دائمًا؛ الدليل `docs/evidence/public-deployment.md` |
| GitHub CI | **success ×4** — runs [40705049517](https://github.com/BedBankSA/ChatE/actions/runs/40705049517) و[40712423908](https://github.com/BedBankSA/ChatE/actions/runs/40712423908) و[40719732323](https://github.com/BedBankSA/ChatE/actions/runs/40719732323) و[40723885317](https://github.com/BedBankSA/ChatE/actions/runs/40723885317)؛ كل خطوات CI ناجحة (typegen/typecheck/lint/test/build/check:bundle) |
| QA متصفح (بعد تفعيل Haiku الحي، 18:58) | **43 PASS / 0 FAIL / 2 BLOCKED / 2 SKIP من 47** — الدليل `docs/audit/evidence/qa-results-prod-mock.json`. المحجوب/المتخطى محدود بالبيئة فقط: مزود OTP المحلي مرفوض في `next start` الإنتاجي (S18/M03)، وExternal Google Identity Services لم يُركَّب في جلسة المتصفح (B02)، وM02 يعتمد على M03. رحلة M01: 4 بطاقات، 3 إجابات OpenRouter، وHaiku الحي عبر المزود الوهمي «اكتمل» |

## الاختبارات حسب الملف (388 اختبارًا في 28 ملفًا؛ 1 مُتخطى)

| الملف | عدد | الملف | عدد |
| --- | ---: | --- | ---: |
| sms-adapter.test.ts | 67 | saudi-phone-normalizer.test.ts | 33 |
| uploads.test.ts | 22 | security-guard.test.ts | 21 |
| comparison-limits.test.ts | 8 | comparison-reliability.test.ts | 5 |
| security-session.test.ts | 20 | history.test.ts | 19 |
| security-authz.test.ts | 19 | otp-http-provider.test.ts | 14 |
| product.test.ts | 14 | security-otp.test.ts | 14 |
| model-gate-sms.test.ts | 14 | otp-route.test.ts | 12 |
| uploads-route.test.ts | 15 | otp-flow.test.ts | 12 |
| security-regressions.test.ts | 11 | security-hardening.test.ts | 10 |
| admin-dashboard.test.ts | 8 | admin-operations.test.ts | 8 |
| admin-user-query.test.ts | 8 | google-signin.test.ts | 8 |
| sqlite-store.test.ts | 8 | ui-fixes.test.ts | 7 |
| shortcut-plan.test.ts | 4 | theme-route.test.ts | 3 |
| visual-theme.test.ts | 3 | sms-live.test.ts (LIVE) | 1 (skip إلا بـ SMS_LIVE_TEST=1) |

## الأدلة الحية (مزودون حقيقيون)

- **SMS/OTP (4jawaly):** رسالتان عبر الاختبار الحي + فحص خام واحد. فحص خام HTTP 200 `code=200` `success_count=1` `error_count=0` (job `0460f882-d2dc-11f1-a7fe-f587caf486fb`). الاختبار الحي: مدخل `0564106506` ← تطبيع إلى `+966564106506` ← SMS حقيقي ← استخراج الرمز من الهاش ← `verify` ← `phone_verified_at` (1/1 PASS). الأدلة: `docs/evidence/sms-live.md`.
- `claude-haiku-5-5` (Anthropic مباشرة): مكتمل، 433 توكن دخل / 6 خرج، 1935 ms، تكلفة 0.000046 دولار.
- `cohere/north-mini-code:free` (OpenRouter): مكتمل، 178/152 توكنًا، 2678 ms.
- نموذجان مجانيان آخران رجعا 429 من المزود وفشلا باستقلال عن البقية.
- المقارنة حملت 3 مرفقات حقيقية (txt + pdf + png) بعد الرفع والتخزين واستخراج النص.
- القيود المعلنة: Turnstile عبر رمز QA لا ودجت متصفح، والجلسة مزروعة لا دخول Google. OTP أُرسل حيًا لكن دون إثبات delivery-receipt آلي على الجهاز (يُثبت قبول المزود `success_count=1` ويستلمه المالك).
- الأدلة الخام: `docs/evidence/live-provider-calls.md` و`docs/evidence/sms-live.md` و`docs/evidence/release-verification-2026-10-28T14-06-54-260Z.json`.

## أدلة إضافية نُفِّذت

- رؤوس الإنتاج: HSTS، CSP بلا `unsafe-eval`، X-Frame-Options: DENY، nosniff، COOP، لا `x-powered-by`، `no-store`.
- `GET /api/health` = 200 مع فحص قاعدة البيانات.
- 404 عربي مخصّص، رابط «الشروط» في التنقل، وأيقونة `/icon.svg`.
- رفض: جلسة موقوفة/مبطلة، IDOR، إدارة بلا صلاحية، CSRF/Origin، Turnstile replay، حدود OTP، حد معدل الدخول، جسم JSON 2MB.
- تطبيع أرقام الجوال السعودية: 10 صيغ مختلفة (محلية/دولية/عربية-هندية/شرطات) → `+966564106506` دائمًا؛ رفض غير السعودي والناقص والزائد (33 اختبارًا).
- محول SMS: 5 مزودين (4jawaly/Taqnyat/Unifonic/Generic/Mock)، 502 مبهم بلا نص مزود أو رمز، 503 عند نقص الإعداد، 67 اختبارًا.

## ما لم يُشغَّل / لم يُثبت

- لا نشر دائم على VPS، ولا نطاق مملوك، ولا TLS إنتاجي، ولا Cloudflare إنتاجي.
- لا إثبات delivery-receipt/status-callback لرسالة SMS على الجهاز آليًا، ولا اختبار Taqnyat/Unifonic حيًا (لا بيانات اعتماد؛ اختبار وحدات فقط).
- لا دخول Google حقيقي في المتصفح (نافذة Google لا تُؤتمت هنا).
- لا نظام دفع/فوترة.
- لا تنبيهات خارجية/مراقبة مستمرة، ولا تنفيذ لعامل الاحتفاظ، ولا حذف حساب من واجهة.
- GitHub CI شُغِّل مرتين بنجاح بعد الدفع: run `40705049517` على `5fea9a3` وrun `40712423908` على `defdc4a` (كلاهما success، 47-48 ثانية). التشغيل الثالث يخص دفعة تحديثات التوثيق النهائية.
