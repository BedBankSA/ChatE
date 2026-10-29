# تدقيق الكود الميت والبقايا المهجورة — ChatE

- الفرع: fix/p0-phone-otp-audit | المهمة المشتركة: task-4 | المدقق: audit-deadcode
- نافذة التدقيق (Asia/Riyadh): 2026-10-29 07:37–07:47 | لقطة العدّ: 07:44–07:46
- النطاق: src/** و tests/** و scripts/** و package.json و migrations/** + ملفات الضبط الجذرية (next.config.ts, vitest.config.ts, postcss.config.mjs, eslint.config.mjs, .env.example) + READMEs/docs للسياق.
- الطريقة: مسح متكرر لكل الملفات النصية (282 ملفًا، بلا node_modules) + بناء رسم استيراد (import graph) مع حل @/ إلى src/ والمسارات النسبية + عدّ مرات ظهور كل تصدير/استيراد/اسم حزمة/جدول/مفتاح بيئة + تحقق يدوي بـ grep على src/tests/scripts لكل نتيجة حذف.
- التنبيه الأهم: زميل آخر يعمل الآن على ميزة phone-OTP على نفس الشجرة، وأُنشئت/عُدّلت أثناء التدقيق ملفات كثيرة (src/server/phone/*, src/components/phone-verification.tsx, src/components/verify-phone-banner.tsx, src/app/verify-phone/page.tsx, src/server/admin/phones.ts, src/app/admin/phones/page.tsx, src/components/admin-phones.tsx, src/domain/admin/phones.ts, migrations/008_phone_audit.sql). هذه الملفات مستثناة من أي توصية حذف، والنتائج صورة لحظية يلزم إعادة التحقق قبل التنفيذ.

## 1) ملخص تنفيذي

- لا وجود لملفات أو صفحات Next يتيمة بنسبة 100% خارج ما يلي: أربعة ملفات/وحدات بلا أي مستهلك إنتاجي، اثنان منها «قديم» فقط بسبب استيراد الاختبارات له.
- أهم ملف ميت مؤكد 100%: src/components/otp-request.tsx (5.6KB) — استُبدل بالكامل بـ phone-verification.tsx ولا يوجد أي استيراد له في src/tests/scripts.
- وحدة أمنية قديمة مكررة: src/domain/auth/google-claims.ts لها نسخة حيّة في src/domain/auth/google.ts، والاختبارات فقط ما زالت تستورد النسخة القديمة (اختلاف نوع الخطأ وترتيب الوسائط).
- 8 حزم runtime غير مستوردة: zod و word-extractor (حزم ميتة فعلية)، و6 حزم shadcn/tremor/tanstack موثقة في README بقصد الاحتفاظ بها (تحتاج قرارًا لا حذفًا أعمى).
- next.config.ts يعلن serverExternalPackages لحزم غير موجودة أصلًا (exceljs, xlsx) ولحزمة غير مستوردة (word-extractor).
- تحذير عالٍ: توصية قديمة في docs/audit/PERFORMANCE-QUICKWINS.md:7 بحذف jszip وmammoth وunpdf خطرها P1 لأنها مستوردة فعليًا في الخادم؛ تنفيذها يكسر الرفع واستخراج النص.
- 8 استيرادات غير مستخدمة، و13 جدولًا/عرضًا في الهجرات بلا مستهلك في الكود (مخطط لميزات غير منفذة) — لا تُحذف الهجرات المطبقة.
- الزائد الأكبر حجمًا (ليس خطرًا): 109 تصديرًا يُستخدم داخل ملفه فقط، و76 تصديرًا تستورده الاختبارات فقط — تنظيف تدريجي اختياري P3.

## 2) جدول Findings

| ID | الخطورة | الملف:السطر | الوصف | الأثر | الإصلاح المقترح | يحتاج اختبار |
| --- | --- | --- | --- | --- | --- | --- |
| F-01 | P1 | docs/audit/PERFORMANCE-QUICKWINS.md:7 | توصية بحذف jszip/mammoth/unpdf ضمن «11 حزمة غير مستوردة»، لكنها مستوردة فعلًا: jszip في src/server/files/storage.ts:4، وmammoth/unpdf عبر dynamic import في src/server/files/extract.ts:131 و:104. تصنيف: تحذير/وثيقة (Keep) | تنفيذ التوصية يكسر رفع الملفات واستخراج نص PDF/DOCX | صحّح الوثيقة لتستثني هذه الحزم الثلاث؛ لا تنفذ الحذف | لا (تحقق grep فقط) |
| F-02 | P2 | src/components/otp-request.tsx:1 | ملف كامل بلا أي مرجع في src/tests/scripts (0 نتيجة)، وصادراته OtpRequestForm:22 غير مستوردة؛ بديله phone-verification.tsx مستخدم في /verify-phone و/account. تصنيف: Safe 100% | كود واجهة ميت + ازدواج نصوص OTP (SECURITY_RETRY/FALLBACK_SEND/FALLBACK_VERIFY) | احذف الملف؛ حدّث الوثائق التي تشير إليه (F-22) | لا (typecheck/lint بعد الحذف) |
| F-03 | P2 | src/domain/auth/google-claims.ts:12,34 | نسخة قديمة مكررة من assertGoogleClaims وprofileFromVerifiedClaims في src/domain/auth/google.ts:14,36؛ الإنتاج يستورد google.ts (src/server/google-identity.ts:2، src/app/api/auth/google/route.ts:2)، والاختبارات فقط تستورد google-claims (tests/product.test.ts:5). تصنيف: Safe 100% للإنتاج | ازدواج منطق تحقق أمني باختلاف نوع الخطأ والرسائل وترتيب الوسائط | احذف الوحدة وحدّث tests/product.test.ts لتستورد google.ts (أو وحّد التنفيذ في وحدة واحدة) | نعم (product.test.ts) |
| F-04 | P2 | src/domain/security/markdown.ts:9 | escapeHtml مستوردة فقط من tests/product.test.ts:40؛ لا مستهلك في src، والتدقيق الأمني يذكر أنها غير مستخدمة. تصنيف: Safe 100% | أداة أمنية ميتة | احذف الملف والاختبار المرتبط | نعم (product.test.ts) |
| F-05 | P2 | src/components/admin-denied.tsx:1 | AdminDenied يستوردها فقط tests/admin-dashboard.test.ts:11؛ صفحة /admin تعيد التوجيه للمجهول (src/app/admin/page.tsx:19) ولا تعرض المكوّن. تصنيف: Safe 100% للإنتاج | مكوّن غير معروض في المنتج | احذف المكوّن واستخدامه في الاختبار أو أعد ربطه إن كان مطلوبًا | نعم (admin-dashboard.test.ts) |
| F-06 | P2 | package.json:33 | zod مُعلنة كاعتمادية runtime ولا يوجد أي import لها في src/tests/scripts (الظهور الوحيد داخل scripts/bench/build-stats.mjs:187 كخريطة نصوص). تصنيف: Safe 100% | تثبيت/CI وسطح هجوم بلا فائدة | أزل zod من package.json (وlockfile) وأزل مدخلها من MARKERS | نعم (CI/typecheck/build) |
| F-07 | P2 | package.json:32 + next.config.ts:14 | word-extractor غير مستوردة إطلاقًا، وextract.ts لا يدعم .doc (DOCX عبر mammoth فقط). تصنيف: Safe 100% | حزمة ميتة + إعداد serverExternalPackages بائد | أزل الحزمة والإدخال من next.config.ts | نعم (build) |
| F-08 | P2 | next.config.ts:12,17 | serverExternalPackages تعلن exceljs وxlsx وهما غير موجودين في package.json ولا مستوردين. تصنيف: Safe 100% | إعداد بائد يضلّل القراءة | أزل الإدخالين | لا (build للتحقق) |
| F-09 | P2 | src/app/api/auth/logout/route.ts:1 | المسار موجود ومختبَر (tests/auth-logout.test.ts:2) لكن لا يوجد أي مستهلك في src ولا ذكر في README/docs (0 نتيجة لكلمة logout خارج الملف والاختبار). تصنيف: Likely (منفذ شغّال لكن يتيم) | لا يمكن للمستخدم تسجيل الخروج من الواجهة | قرار: اربط زر خروج في layout/الحساب، أو وثّقه كـAPI عام، أو احذفه مع اختباره | نعم (اختبار موجود) |
| F-10 | P2 | src/domain/admin/settings.ts:211,224,235,243 | أربعة تصديرات ميتة 100%: TESTABLE_SETTING_KEYS وSettingTestResult وisUserRole وROLE_LABELS (كل منها ظهور واحد فقط: سطر التعريف)؛ SettingTestResult نسخة مكررة من SettingsTestResult في src/server/admin/settings-test.ts:5. تصنيف: Safe 100% | قائمة «فحوصات مسموحة» أمنية ميتة + ازدواج نوع | احذفها أو أزل export؛ أبقِ roleLabel:v239 المستخدمة في admin-dashboard.tsx:2 | لا |
| F-11 | P2 | src/domain/models/endpoints.ts:55 (+82) | embeddingBody ميت 100%، وplanDefaultEmbedding تستورده الاختبارات فقط (tests/product.test.ts:36,227)؛ لا كود منتج يستدعي مسار embedding، وجداول embedding_indexes/embedding_vectors بلا مستهلك (F-17). تصنيف: Safe 100% | مسار ميزة ملغاة/مؤجلة | قرّر: احذف المسار وجداوله، أو وثّقه كـ«مخطط لميزة قادمة» | نعم (product.test.ts) |
| F-12 | P2 | src/components/admin-settings.tsx:120 | settingsNoticeText ميتة 100% وتكرر settingsNotice في src/domain/admin/settings.ts:226 (المستخدمة فعلًا). تصنيف: Safe 100% | دالة عرض مكررة | احذفها | لا |
| F-13 | P3 | src/domain/workspace-start.ts:21 | SENDING_MESSAGE ظهور واحد فقط (تعريفها)؛ لا مستهلك في src/tests/scripts. تصنيف: Safe 100% | ثابت نصي ميت | احذفها | لا |
| F-14 | P3 | src/server/phone/state.ts:37 | hasVerifiedPhoneState ظهور واحد فقط؛ الملف جديد ضمن العمل الجاري على phone-OTP (كُتب قبل دقائق). تصنيف: Needs confirmation (لا تحذف قبل تنسيق) | قد تكون أداة قادمة للبوابات/الاختبارات | تأكيد مع مالك ميزة phone-OTP ثم حذف أو ربط | لا |
| F-15 | P3 | package.json:18,19,20,21,22,30 + README.md:19-21 | ست حزم غير مستوردة لكن موثقة صراحة: @radix-ui/react-slot, @tanstack/react-table, @tremor/react, class-variance-authority, clsx, tailwind-merge. تصنيف: Keep بقرار مالك | حجم تثبيت/CI فقط (صفر بايت للمتصفح) | قرار: احذفها كما توصي docs/audit أو ضع تعليقًا يوثّق سبب الاحتفاظ | نعم (CI) |
| F-16 | P3 | scripts/bench/inspect-db.mjs:17؛ scripts/dev/verify-full-flow.mjs:4؛ scripts/qa/run-e2e.mjs:23,25؛ tests/admin-settings.test.ts:2,5؛ tests/security-regressions.test.ts:3 | ثمانية استيرادات غير مستخدمة: readFileSync؛ appendFileSync؛ spawnSync؛ existsSync؛ readFileSync؛ randomUUID؛ SETTING_KEYS؛ AppError. تصنيف: Safe 100% | ضجيج lint/قراءة | أزل الاستيرادات | لا (lint/typecheck) |
| F-17 | P3 | migrations/001_init.sql:97,107,187,204؛ migrations/002_admin.sql:58,82,98,103,122,139,155,162,169 | 13 كائنًا بلا مستهلك في src: embedding_indexes, embedding_vectors, user_feedback, retention_settings؛ operation_rollups, presence_rollups, provider_sync_lock, service_controls, integration_secret_versions, secret_audit, admin_view_preferences؛ والعرضان admin_operation_feed وadmin_account_directory. تصنيف: Keep مؤقتًا (سجل هجرات مطبّق) | مخطط لميزات غير منفذة (تدوير أسرار/حضور/تقييم/احتفاظ) | لا تعدّل هجرات مطبقة؛ وثّقها كـ«محجوز» أو أضف هجرة حذف جديدة بقرار منتج | لا |
| F-18 | P3 | scripts/fetch-openrouter-models.mjs:1؛ scripts/inspect-model-policy.mjs:3؛ scripts/slim-openrouter-snapshot.mjs:1 | ثلاثة سكربتات صيانة لسجل النماذج بلا أي مرجع في package.json/CI/docs/سكربتات أخرى (0 نتيجة لكل اسم). تصنيف: Likely (أدوات يدوية) | أدوات قديمة قد تُحذف أو تُوثّق | تأكيد مع مالك سجل النماذج ثم توثيق طريقة التشغيل أو الحذف | لا |
| F-19 | P3 | .env.example:48 + src/domain/models/dispatch.ts:110 | MAX_PROVIDER_RETRIES موثّق في env لكنه غير مقروء في الكود؛ عدد المحاولات محفور (attempt < 3) وقرار إعادة المحاولة في src/domain/quota/reserve.ts:44. تصنيف: Dead config (وثّق أو احذف) | تغيير المتغير لا يؤثر — تضليل تشغيلي | اربطه بالكود أو احذفه من .env.example وdeploy/README | نعم (dispatch tests) |
| F-20 | P3 | src/domain/auth/otp.ts:74,84,86,103,120,192 مقابل src/server/sms/adapter.ts:74,77,120,126,213 | أدوات OTP مكررة حرفيًا تقريبًا: OTP_CODE_PATTERN (84/74)، LOOPBACK_HOSTS (86/77)، normalizeHostname (103/120)، discardBody (192/213)؛ مع تكرار رسائل ANONYMOUS_MESSAGE في 5 ملفات، وSTORE_MESSAGE في 4، وPHONE_TAKEN_MESSAGE في 2؛ وتكرار parseJson/numberValue/readAttachments (history.ts/store.ts/repository.ts)، وrequireQueue/readAccount/ensureAccount (quota.ts/jobs.ts/store.ts)، وasRecord (dispatch.ts:281/haiku.ts:224)، وfirstValue (src/app/history/page.tsx:26 / src/app/verify-phone/page.tsx:15). تصنيف: Likely (توحيد) | صيانة مزدوجة وخطر انحراف | استخرج helpers مشتركة على مراحل مع إبقاء الحدود بين domain/server | نعم |
| F-21 | P3 | (109 ملفًا) + (76 تصديرًا) | 109 تصديرات تُستخدم داخل ملفها فقط، و76 تصديرًا تستوردها الاختبارات/السكربتات فقط (أمثلة: AdminDenied، escapeHtml، planDefaultEmbedding، readSession، consumeTurnstile). تصنيف: Keep (سطح اختبار) — تنظيف اختياري | توسيع سطح API بلا حاجة | أزل export عن المتسلسلات الداخلية تدريجيًا (لا تغيّر سلوكًا) | نعم (typecheck/tests) |
| F-22 | P3 | README.md:116؛ docs/marketing/CLAIMS-AND-EVIDENCE.md:89؛ docs/launch/LAUNCH-READINESS.md:61 | وثائق تصف واجهة OTP في /profile/complete وتشير إلى otp-request.tsx بعد أن صارت /profile/complete مجرد تحويل إلى /verify-phone والمكوّن بديل. تصنيف: Safe 100% (وثائق) | توثيق قديم يربك التدقيق/التسويق | حدّث الوثائق مع F-02 | لا |

## 3) تفاصيل أهم النتائج

### 3.1 ملفات/وحدات بلا مستهلك إنتاجي
- src/components/otp-request.tsx — صفر إشارات في src/tests/scripts. المكوّن الحالي هو PhoneVerification في src/components/phone-verification.tsx المستخدم في src/app/verify-phone/page.tsx:3 وsrc/app/account/page.tsx:3. النصوص المكررة فيه (SECURITY_RETRY:18، FALLBACK_SEND:19، FALLBACK_VERIFY:20) موجودة أيضًا في phone-verification.tsx:22-24 → حذفه لا يفقد شيئًا.
- src/domain/auth/google-claims.ts — نسخة ثانية من تحقق Google: في google-claims يرمي Error عاديًا وترتيب الوسائط (payload, audience, nowSec, nonce)، وفي google.ts يرمي AppError برسائل عربية وترتيب (payload, audience, nonce, nowSec). الإنتاج يستعمل google.ts فقط؛ الفرق بينهما يعني أن اختبارات product.test.ts تختبر مسارًا غير المستخدم في الإنتاج.
- src/domain/security/markdown.ts — escapeHtml مذكورة في تدقيق أمني كغير مستخدمة؛ الفرع الوحيد الذي يستوردها هو tests/product.test.ts:40.
- src/components/admin-denied.tsx — صفحة /admin توجّه غير المشرف إلى /?forbidden=admin (src/app/admin/page.tsx:19) ولا تعرض AdminDenied؛ الاختبار وحده يعرضه server-side.

### 3.2 اعتماديات package.json
- غير مستوردة إطلاقًا (7): zod:33، word-extractor:32، @radix-ui/react-slot:18، @tanstack/react-table:19، @tremor/react:20، class-variance-authority:21، clsx:22، tailwind-merge:30 (المجموع 8 مع word-extractor وzod).
- مستوردة ومستخدمة (Keep): google-auth-library (src/server/google-identity.ts:1)، jszip (src/server/files/storage.ts:4)، libphonenumber-js (src/domain/auth/profile.ts:1)، mammoth (استيراد ديناميكي src/server/files/extract.ts:131)، unpdf (src/server/files/extract.ts:104)، next/react/react-dom.
- devDependencies كلها مبرَّرة: @tailwindcss/postcss (postcss.config.mjs:3)، tailwindcss (src/app/globals.css:1)، eslint/eslint-config-next (eslint.config.mjs:1-2)، tsx/typescript (package.json:10,13-15)، vitest (vitest.config.ts:3 + الاختبارات)، @vitest/coverage-v8 (provider v8)، pdf-lib (اختبارات الرفع)، @types/* ضمنية.
- تصحيح لتدقيق سابق: الفقرة التي توصي بحذف jszip/mammoth/unpdf في PERFORMANCE-QUICKWINS:7 غير صحيحة حاليًا.

### 3.3 next.config.ts وإعدادات بائدة
- serverExternalPackages (سطور 11-18) تذكر exceljs:12 وxlsx:17 وهما غير معلنتين في package.json وغير مستوردين، وword-extractor:14 غير مستورد؛ الإبقاء عليها يوهم بوجود ميزة Excel/Word .doc.

### 3.4 صادرات ميتة مؤكدة (ظهور واحد = التعريف)
- src/domain/admin/settings.ts:211,224,235,243؛ src/components/admin-settings.tsx:120؛ src/domain/workspace-start.ts:21؛ src/domain/models/endpoints.ts:55؛ src/components/otp-request.tsx:22 (الملف نفسه ميت)؛ src/server/phone/state.ts:37 (جديد، يحتاج تأكيد).

### 3.5 تكرارات تستحق التوحيد (P3)
- تحقق Google: google-claims.ts:12,34 مقابل google.ts:14,36 (F-03).
- مزودو OTP: otp.ts:74/84/86/103/120/192 مقابل sms/adapter.ts:74/77/120/126/213 (F-20).
- رسائل مسارات API: ANONYMOUS_MESSAGE في 5 ملفات وSTORE_MESSAGE في 4 وPHONE_TAKEN_MESSAGE في 2 — نصوص API موحّدة الشكل تُدار يدويًا في كل ملف.
- طبقة DB: parseJson/numberValue/readAttachments مكررة بين src/server/comparisons/history.ts:222,232,167 وsrc/server/comparisons/store.ts:607,617,313 وsrc/server/files/repository.ts:266؛ وrequireQueue/readAccount/ensureAccount بين src/server/db/quota.ts:138,120,112 وsrc/server/db/jobs.ts:76 وsrc/server/comparisons/store.ts:551,543.
- src/domain/models/dispatch.ts:281 وsrc/domain/models/haiku.ts:224 يعرّفان asRecord متطابقتين تقريبًا.

### 3.6 سكربتات ووصلات
- موصولة بـ package.json: scripts/migrate.ts، scripts/worker.ts، scripts/check-client-bundle.ts (سطور 13-15) وCI (.github/workflows/ci.yml:64-79).
- موصولة بالوثائق/التشغيل اليدوي (Keep): scripts/qa/* (scripts/qa/README.md وتقارير docs/evidence)، scripts/bench/* (scripts/bench/README.md)، scripts/dev/* وscripts/deploy/public-demo.ps1.
- غير موصولة بأي مرجع (Likely): scripts/fetch-openrouter-models.mjs، scripts/inspect-model-policy.mjs، scripts/slim-openrouter-snapshot.mjs — أدوات صيانة سجل النماذج (تقرأ .tools) بلا توثيق تشغيل.

## 4) قائمة Keep — لا تُحذف بلا دليل إضافي
- كل صفحات/مسارات src/app/**: Next يحمّلها بالمسار لا بالاستيراد. تحققنا من كل مسار: /workspace و/verify-phone و/history و/account و/admin و/admin/settings و/admin/phones و/ و/privacy و/terms مستخدمة؛ /profile/complete بديل دائم بقرار موثّق (src/app/profile/complete/page.tsx:3-9).
- /api/admin/overview (توثيق README.md:125 واختبارات)، /api/history (README.md:9 واختبارات)، /api/health (جاهزية تشغيلية: scripts/qa/verify-release.mjs:907,1065؛ scripts/deploy/public-demo.ps1).
- jszip/mammoth/unpdf/libphonenumber-js/google-auth-library وجميع devDependencies (مبرَّرة أعلاه).
- مفتاحا البيئة DOWNLOAD_URL_TTL_SECONDS (.env.example:39) وMAX_ZIP_* (52-54) وRETENTION_* (107-108): README.md:79,81,84,129-130 يصرّح بعدم قراءتها بعد — فجوة موثقة لا كود ميت يُحذف. MAX_PROVIDER_RETRIES استثناء (F-19) لأنه موثّق دون تصريح مماثل.
- الجداول/العروض المستخدمة: admin_storage_totals وadmin_secret_status (src/server/admin/overview.ts:217,297) — Keep.
- ملفات phone-OTP الجديدة (src/server/phone/*، src/components/phone-verification.tsx، src/components/verify-phone-banner.tsx، src/app/verify-phone/**، src/server/admin/phones.ts، src/app/admin/phones/**): عمل جارٍ، لا تلمسها.

## 5) ما لم يُفحص / قيود
- لم نشغّل npm install ولا build ولا tsc ولا vitest ولا lint (node_modules قيد التثبيت، ومُنع صراحة)؛ كل الأدلة ثابتة (grep/عدّ) وليست سلوكية.
- لم يُفحص node_modules ولا .next ولا deploy/** (خارج النطاق، واستُخدمت deploy فقط للتحقق من استخدام مفاتيح البيئة).
- لا git: تعذّر تحديد الفرق عن الفرع الأب أو حالة uncommitted؛ اعتمدنا mtime لرصد التعديلات الجارية.
- التغطية الديناميكية جزئية: اكتشفنا الاستيرادات الديناميكية الموجودة (mammoth/unpdf) لكن لا يمكن إثبات عدم وجود استدعاء خارجي (مثل curl لمستخدم خارجي) لأي مسار API؛ لذلك المسارات المصنفة Keep وليست حذفًا.
- لم نفحص: CSS classes الميتة، الأعمدة غير المستخدمة داخل الجداول، الفهارس (indexes) غير المستخدمة، تكرار المنطق بنسبة تشابه (اعتمدنا تطابق الأسماء)، ولا صحة تشغيل الاختبارات.
- بعض الملفات تغيّرت أثناء التدقيق (07:37–07:46)؛ قبل أي حذف أعد تشغيل أوامر القسم 7. خصوصًا F-14 وF-17 وF-18.

## 6) خطة إصلاح مرتبة
1) المرحلة أ — بلا قرار منتج (P2): حذف otp-request.tsx (F-02)، admin-denied.tsx (F-05)، markdown.ts (F-04)، دمج google-claims.ts في google.ts وتحديث الاختبار (F-03)، حذف الصادرات الميتة (F-10,F-12,F-13)، إزالة zod/word-extractor ومدخلي exceljs/xlsx من next.config (F-06,F-07,F-08)، وتصحيح الاستيرادات الثمانية (F-16) ووثائق F-22. التحقق: npm run typecheck && npm test && npm run build (بعد اكتمال node_modules) + npm run lint.
2) المرحلة ب — قرارات: /api/auth/logout (F-09)، مسار embedding (F-11)، الجداول/العروض غير المستخدمة (F-17)، hasVerifiedPhoneState (F-14 مع مالك phone-OTP)، سكربتات سجل النماذج (F-18)، حزم F-15، ربط/حذف MAX_PROVIDER_RETRIES (F-19).
3) المرحلة ج — تنظيف بنيوي (P3): de-export التدريجي لـ109+76 (F-21) ثم توحيد الأدوات المكررة (F-20) وكتلة رسائل API، مع إضافة اختبارات للوحدات التي تُدَمج.
4) تحقق نهائي قبل الحذف الفعلي: rg -n لكل رمز/ملف في src tests scripts + npm test + npm run build، ثم تحديث docs/audit/PERFORMANCE-QUICKWINS.md:7.

## 7) أوامر التحقق المستخدمة
- مسح شامل: برنامج Node داخل run_code (readdir متكرر لـ src/tests/scripts، قراءة كل الملفات النصية 282، regex للاستيرادات + حل @/→src والمسارات النسبية، وعدّ مرات الظهور لكل تصدير/اسم).
- تحقق الأدوات: DSH grep tool (pattern، path) على src/tests/scripts لكل رمز في قسم Findings؛ أمثلة الأوامر المكافئة:
  rg -n "SENDING_MESSAGE|embeddingBody|settingsNoticeText|TESTABLE_SETTING_KEYS|SettingTestResult|isUserRole|ROLE_LABELS|hasVerifiedPhoneState" src tests scripts
  rg -n "otp-request" src tests scripts            # النتيجة الآن: 0
  rg -n "components/admin-denied|domain/auth/google-claims|domain/security/markdown" src tests scripts
  rg -n "from \"zod\"|require\(\"zod\"\)|from \"word-extractor\"" src tests scripts   # 0 في الكود، ظهور داخل build-stats فقط
  rg -n "exceljs|xlsx|word-extractor" next.config.ts package.json src tests scripts
  rg -n "admin_view_preferences|operation_rollups|presence_rollups|provider_sync_lock|service_controls|secret_audit|integration_secret_versions|user_feedback|retention_settings|embedding_indexes|embedding_vectors|admin_operation_feed|admin_account_directory" src tests scripts
  rg -n "MAX_PROVIDER_RETRIES" src tests scripts   # 0
- فحص مسارات Next: مطابقة مسار كل route.ts/page.tsx مع كل نصوص src للتحقق من وجود رابط/استدعاء، مع استثناء src/app من قاعدة «ملف غير مستورد» لأنه محمّل بالمسار.

— انتهى التقرير. لا تغييرات في src/tests/migrations؛ المخرج الوحيد هو هذا الملف.