# ChatE — One-Pager (AR / EN)

**الإصدار:** 2026-10-28 · **الحالة:** بيتا مغلقة (غير منشورة) · **مصدر الحقائق:** الكود على `05fc1e8` + فحص وقت التشغيل + `npm test`
**ملاحظة إلزامية:** هذا المستند ليس عرضًا ترويجيًا. كل بند يحمل وسم `[مُتحقق]` / `[افتراض]` / `[خارطة طريق]`. الأرقام غير المُتحققة لا تُستخدم في محادثة استثمار دون تحقق مستقل.

---

# النسخة العربية

## ما هو ChatE؟

**ChatE تطبيق ويب عربي (RTL) يرسل سؤالًا واحدًا إلى عدة نماذج ذكاء اصطناعي ويعرض الإجابات جنبًا إلى جنب، مع اسم النموذج والمزوّد والجهد والزمن والتكلفة التقديرية.** `[مُتحقق]`

- سؤال واحد، حتى **8 نماذج** في المقارنة الواحدة `[مُتحقق — src/domain/comparison/input.ts:23]`.
- **23 نموذجًا** في السجل المركزي، **10 متاحة فقط** و**13 تظهر مقيدة بشروط المزود** بلا إرسال `[مُتحقق — GET /api/models: 10/13]`.
- **سياسة OpenRouter مجانية فقط:** أي معرف لا ينتهي بـ `:free` مرفوض؛ لا استبدال صامت ولا تحويل تلقائي إلى مسار مدفوع `[مُتحقق — src/domain/models/dispatch.ts:53-55]`.
- **Claude Haiku 5.5** هو النموذج المدفوع الوحيد، بتفكير `adaptive` وجهد `medium`، وتكلفته منفصلة عن الحصة المجانية `[مُتحقق — src/domain/models/haiku.ts:5-6,28-46]`.

## المشكلة

المستخدم العربي للذكاء الاصطناعي يختار نموذجًا واحدًا ويألفه، أو يلصق سؤاله في عدة نوافذ ويقارن يدويًا. لا توجد أداة عربية أولًا تجيب سؤالًا واحدًا: **أي نموذج أجاب أفضل لسؤالي؟** حضور العربية في محتوى الويب 0.6% مقابل 49.5% للإنجليزية (W3Techs، 28 أكتوبر 2026) `[مُتحقق — مصدر خارجي]`، ما يجعل تجربة القرار العربي أقل خدمة من غيرها.

## الحل

مقارنة مستقلة: السؤال نفسه لكل نموذج، لا يرى نموذج إجابة منافس، وفشل نموذج واحد لا يوقف البقية `[مُتحقق في الكود — plan.ts:7-8,292-297؛ execute.ts:50]`. النتائج تظهر جنبًا إلى جنب أثناء وصولها (استقصاء كل 1.2 ثانية)، مع حالات عربية واضحة (`view.ts:21-32`).

## لماذا الآن؟

- نماذج مجانية قوية ومتعددة (Gemma 4، Flint، Xing4.0، Mammoth/Elephant وغيرها) بلا تكلفة للمستخدم `[مُتحقق — سجل النماذج]`.
- تعدد النماذج صار عبئًا: المستخدم يحتاج طبقة اختيار لا مساعدًا إضافيًا `[افتراض موضعي]`.
- البنية التحتية المجانية/المحلية صارت كافية لتشغيل منتج كهذا بملف SQLite واحد بلا Docker `[مُتحقق — README.md:20]`.

## حالة المنتج (صريحة)

| العنصر | الحالة |
| --- | --- |
| واجهة عربية RTL + مقارنة متعددة | `[مُتحقق]` |
| سجل نماذج + سياسة مجانية + حصص ذرية + idempotency + إعادة 429 | `[مُتحقق]` |
| دخول Google + Turnstile + جلسة HttpOnly + CSP/HSTS | `[مُتحقق في الكود]` |
| لوحة إدارة + عدادات + إيقاف/حصة + تدقيق | `[مُتحقق]` |
| 141 اختبارًا في 14 ملفًا، 0 فشل | `[مُتحقق — npm test، 2026-10-28 16:37]` |
| التحقق بالجوال (OTP) | التدفق مبني ومختبَر؛ يحتاج مزود SMS؛ لا إثبات حي `[جزئي]` |
| رفع الملفات | **stub**: 401 ولا تخزين، `attachments: []` `[خارطة طريق]` |
| سجل المقارنات | صفحة ثابتة بلا صفوف `[خارطة طريق]` |
| نشر عام / ترخيص / دفع / تحليلات | **لا يوجد** `[مُتحقق]` |
| استدعاء حي مُثبت لمزود | **لا سجل**؛ الكود يسمح به عند وجود مفتاح `[غير مُتحقق]` |

## السوق (تقديرات، لا وعود)

- **TAM تقديري:** مستخدمو LLM العرب شهريًا — نطاق غير مُقاس بدقة، نستخدم تقديرًا واسعًا `[افتراض]`.
- **SAM تقديري:** من يستخدم أكثر من نموذج/يهتم باختياره — شريحة أصغر لكنها الأعلى ملاءمة `[افتراض]`.
- **SOM (30 يومًا):** 1,500 تسجيل قائمة انتظار و300-600 مستخدم مفعّل في بيتا مغلقة `[افتراض، هدف لا توقع]`.
- سياق اقتصادي: تقدير PwC المنقول إعلاميًا ~$320B مساهمة AI في الشرق الأوسط بحلول 2030 (~$260B للخليج) `[مصدر خارجي ثانوي — سياق فقط، تقدير قديم الأصل]`.

## نموذج العمل

- **اليوم:** مجاني ضمن حصص (افتراضي 200 وحدة/مستخدم، 2000 مشتركة، تزامن 2/8) `[مُتحقق]`، وHaiku مدفوع على حساب المالك `[مُتحقق]`.
- **لاحقًا:** طبقة مجانية بحصة أعلى، Pro (Haiku ضمن سقف + سجل/تصدير)، فرق/مؤسسات `[خارطة طريق، غير مبني]`.
- **لا كود دفع أو فواتير اليوم** `[مُتحقق — فحص src وpackage.json]`.

## الجذب والاستخدام

**لا توجد بيانات استخدام أو نمو بعد.** المستودع عام وله 0 نجوم (GitHub API، 2026-10-28) `[مُتحقق]`، ولا نشر عام `[مُتحقق]`. أي رقم مستخدمين/إيراد في أي محادثة هو ادعاء غير مسموح.

## الطلب (Ask)

- **شراكة/استثمار مبكر:** تمويل أو دعم لتغطية (1) إكمال OTP والنشر، (2) تكلفة Haiku التشغيلية المحدودة، (3) تصميم/تسويق البيتا. المبلغ يحدده المالك؛ هذا المستند لا يفترض رقمًا.
- **شركاء توزيع:** مجتمعات تقنية عربية، جامعات، مسرعات — مقابل وصول مبكر وتجربة بيتا.
- **ما نطلبه من الشريك:** مراجعة ادعاءاتنا (CLAIMS-AND-EVIDENCE.md) قبل أي إعلان مشترك.

## المخاطر الرئيسية

1. الحلقة مقطوعة اليوم عند التحقق بالجوال — شرط إطلاق لا يمكن تجاوزه.
2. الرفع والسجل غير مكتملين — لا يُسوَّقان.
3. لا ترخيص على مستودع عام — يجب حله قبل أي شراكة/إعلان.
4. اعتماد على نماذج مجانية بحدود مزود متغيرة (20 طلب/دقيقة، 50-1000/يوم) `[مُتحقق — وثائق OpenRouter]`.
5. لا إثبات استدعاء حي بعد — مطلوب اختبار واحد بموافقة المالك.

## التواصل

[اسم المالك/البريد — يُملأ قبل الإرسال. لا يُرسل هذا المستند دون مراجعة `CLAIMS-AND-EVIDENCE.md`.]

---

# English Version

## What ChatE is

ChatE is an Arabic-first, RTL web app that sends **one question to multiple AI models** and shows the answers **side by side**, with the model ID, provider, effort, latency, and estimated cost shown per column `[verified]`.

- Up to **8 models** per comparison `[verified — input.ts:23]`.
- **23 models** in the server catalog; only **10 are marked available**, 13 remain visible as provider-restricted without dispatch `[verified — GET /api/models returned 10/13]`.
- **Free-only OpenRouter policy:** any model ID without the `:free` suffix is rejected; no silent fallback to a paid route `[verified — dispatch.ts:53-55]`.
- **Claude Haiku 5.5** is the only paid model, with adaptive thinking and `effort: medium`; its cost is accounted separately from free units `[verified — haiku.ts:5-6,28-46]`.

## Problem

Arabic LLM users either stick to one model or paste the same prompt into several tabs and compare manually. There is no Arabic-first tool answering "which model answered *my* question better?" Arabic accounts for 0.6% of website content vs 49.5% English (W3Techs, 28 Oct 2026) `[verified — external source]`.

## Solution

Independent comparison: identical question and base instructions per model; a model never sees a competitor's answer; one failure does not cancel the others `[verified in code]`. Answers appear as they arrive via a 1.2-second poll, each with a clear Arabic status.

## Why now

- Strong free models are available at zero provider price `[verified — model catalog docs]`.
- Model sprawl makes a selection layer more valuable than another assistant `[assumption]`.
- The stack runs on a single SQLite file with no Docker/Postgres `[verified — README:20]`.

## Product status (honest)

| Item | Status |
| --- | --- |
| Arabic RTL multi-model comparison | `[verified]` |
| Model catalog, free-only policy, atomic quota, idempotency, 429 retries | `[verified]` |
| Google sign-in, Turnstile, HttpOnly session, CSP/HSTS | `[verified in code]` |
| Admin dashboard, counters, suspend/quota, audit | `[verified]` |
| 141 tests in 14 files, all passing | `[verified — npm test, 2026-10-28 16:37]` |
| Phone verification (OTP) | implemented and route-tested; needs SMS provider env; no live send proven `[partial]` |
| File uploads | **stub**: returns 401, stores nothing, `attachments: []` `[roadmap]` |
| Comparison history | static page, no rows `[roadmap]` |
| Public deployment / license / billing / analytics | **none** `[verified]` |
| Live provider success | **no recorded run**; code path exists when a key is set `[unverified]` |

## Market (estimates, not promises)

- **TAM:** Arabic-speaking monthly LLM users — not precisely measured; we use a wide estimate `[assumption]`.
- **SAM:** users who compare or care about model choice `[assumption]`.
- **SOM (30 days):** 1,500 waitlist signups and 300–600 activated closed-beta users `[assumption — target, not forecast]`.
- Context: a widely cited PwC estimate puts AI contribution to the Middle East economy at ~$320B by 2030 (~$260B GCC) `[secondary external source — context only; original estimate is dated]`.

## Business model

- Today: free within quotas (defaults 200 user units, 2,000 shared, concurrency 2/8) `[verified]`; Haiku paid by the owner `[verified]`.
- Later: free tier, Pro (Haiku cap + history/export), teams `[roadmap, not built]`.
- No payment or billing code today `[verified]`.

## Traction

**None.** Public GitHub repo with 0 stars (GitHub API, 2026-10-28) `[verified]`; no public deployment `[verified]`. Any user/revenue figure in outreach is an unpermitted claim.

## Ask

- **Early partner/investor:** funding or support for (1) OTP + deployment completion, (2) limited Haiku operating cost, (3) beta design and go-to-market. Amount to be set by the owner; this document assumes none.
- **Distribution partners:** Arabic tech communities, universities, accelerators — early access in exchange for beta feedback.
- **What we ask of partners:** review `CLAIMS-AND-EVIDENCE.md` before any joint announcement.

## Key risks

1. Onboarding is blocked at phone verification today.
2. Uploads and history are incomplete and must not be marketed.
3. Public repo has no license — resolve before partnership/announcement.
4. Free-model provider limits (20 RPM; 50–1,000 RPD) constrain capacity `[verified — OpenRouter docs]`.
5. No live-call proof yet — one owner-approved smoke test is required.

## Contact

[Owner name/email — fill before sending. Do not send this document without the claims review.]
