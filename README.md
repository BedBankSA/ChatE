[English](README.en.md)

# ChatE

تطبيق ويب عربي لمقارنة النماذج. السؤال واحد، والملفات اختيارية، والإجابات تظهر جنبًا إلى جنب كلما وصلت. تعثر نموذج لا يوقف البقية. المتصفح لا يستدعي OpenRouter ولا Anthropic؛ مفاتيح المزود تبقى على الخادم.

## ماذا يفعل

مساحة العمل في `/workspace` ترسل السؤال إلى النماذج التي يختارها المستخدم، ثم تقرأ نتيجة المقارنة من الخادم. الاختصارات الظاهرة: محادثة (Gemma 4 31B)، برمجة (Flint)، خفيف (Gemma 4 26B)، ومقارنة تجمع هذه الثلاثة مع Claude Haiku 5.5. هذا ليس سجل محادثة متعدد الجولات. صفحة `/history` تعرض المقارنات المحفوظة لحسابك من الأحدث إلى الأقدم (20 في الصفحة) مع صفحة تفاصيل للقراءة فقط على `/history/[id]`، و`GET /api/history` يعيد الصفوف نفسها.

دعم الملفات منفّذ. واجهة الاختيار ترسل بايتات الملفات عبر `multipart/form-data` إلى `POST /api/uploads` مع رمز Turnstile (الإجراء `upload`). المسار يشترط الجلسة أولًا ثم Turnstile، ويخزّن البايتات في `STORAGE_DIR/<userId>/<fileId>` بمسار يولّده الخادم (مجلد 0700 وملف 0600، كتابة ذرّية)، ويكتشف النوع من البايتات (PDF، PNG، JPEG، GIF، WebP، DOCX، XLSX، ZIP، OLE، نص، JSON، CSV، TSV، Markdown، وصوت وفيديو)، ويحسب sha256 ويسجّل صفًا في `files` بحالة `stored`. الحدود: `MAX_FILE_BYTES` (الافتراضي 25 مبيبايت) للملف، وخمسة ملفات كحد أقصى، و50 مبيبايت إجمالًا للطلب. يُستخرج النص من PDF عبر `unpdf` ومن DOCX عبر `mammoth` ومن النصوص عبر `decodeText` ويُحفظ في `documents`/`chunks` بـ `processing_version=v1`؛ الصور بلا نص، والأنواع الأخرى تسجّل فشل استخراج. إنشاء المقارنة يقبل `attachmentIds` (حتى خمسة معرفات مملوكة لصاحب الجلسة)، ويبني نص الأدلة المشترك لكل النماذج من النص المستخرج، ويرسل الصور مباشرة للنماذج التي تدعم الصور (≤ 5 مبيبايت)، ويسجّل المعرفات في `evidence_snapshots.payload`. لا يوجد رابط تنزيل عام للملفات.

الدخول بحساب Google عبر الزر الرسمي من Google Identity Services. الزر يفتح نافذة حساب واحدة، ثم تكتمل الجلسة برمز الهوية مع nonce في كوكي. تدفق الهوية هذا لا يستخدم سر عميل Google. Turnstile يعمل بوضع `interaction-only` وتنفيذ `execute`: لا مربع تحقق ظاهر إلا إذا طلبت Cloudflare تفاعلًا. الخادم يتحقق من الرمز مرة واحدة ولا يعيد استخدامه.

## المكدس

- Next.js 16 وReact 19 وTypeScript.
- Tailwind CSS 4. التنسيق في `src/app/globals.css`.
- حزم أسلوب shadcn/ui موجودة في الاعتماديات: `class-variance-authority` و`clsx` و`tailwind-merge` و`@radix-ui/react-slot`. لا يوجد `components.json` ولا `src/components/ui`، وتطبيق `src` لا يستورد هذه الحزم.
- SQLite عبر `node:sqlite` في Node.js 24. ملف واحد. التشغيل لا يحتاج Docker ولا Postgres.
- `@tanstack/react-table` و`@tremor/react` مُعلنان في `package.json` وغير مستوردين من `src`.

`package.json` يضبط `"private": true`، فالنشر إلى سجل npm مرفوض. هذا مستقل عن قرار نشر مستودع GitHub.

## التشغيل

المطلوب Node.js 24. على هذه الآلة قد لا يكون `node` أو `npm` على PATH. الثنائي المستخدم هنا `C:\Pak\node.exe` ومعه `C:\Pak\npm.cmd`.

```powershell
Copy-Item .env.example .env.local
$env:PATH = "C:\Pak;" + $env:PATH
npm install
npm run db:migrate
npm test
npm run dev -- --port 3211
```

املأ `.env.local` محليًا ولا ترفعه. إن فشل التثبيت بسبب شهادة TLS فجرّب `$env:NODE_OPTIONS='--use-system-ca'` ثم أعد `npm install`.

لا تفتح خادم تطوير ثانٍ إذا كان واحد يعمل على 3211. لا تستخدم المنفذ 3000 لـ ChatE على هذه الآلة؛ هو تطبيق آخر. أصل التطوير يجب أن يُسجَّل في Google Cloud ضمن أصول JavaScript المصرح بها: `http://localhost:3211`.

`npm run build` ثم `npm start` يبنيان نسخة الإنتاج. بعد البناء شغّل `npm run check:bundle` للتأكد أن أسماء أسرار الخادم وقيمها لم تدخل حزمة المتصفح. لا يوجد نشر عام دائم في هذا المستودع. يوجد CI في `.github/workflows/ci.yml` (Node 24: typegen/typecheck/lint/test/build/check:bundle، بلا أسرار) لا ينشر شيئًا. لتوليد رابط عام مؤقت للعرض (Cloudflare quick tunnel، بلا حساب) استخدم `scripts/deploy/public-demo.ps1`؛ الدليل يُكتب في `docs/evidence/public-deployment.md`. هذا ليس نشرًا إنتاجيًا ولا يعوّض `docs/launch/DEPLOYMENT-RUNBOOK.md`.

`npm run worker` يفتح ملف SQLite نفسه، ويطبق الهجرات المعلقة، ويعيد المهام القديمة إلى الطابور. حلقته لا تأخذ مقارنات ولا تستدعي مزودًا. تنفيذ المقارنة يتم داخل عملية Next.js.

## قاعدة البيانات

`npm run db:migrate` يشغّل `scripts/migrate.ts`. المسار من `SQLITE_PATH`، والافتراضي `data/chate.sqlite`، ويُحل نسبيًا من جذر المشروع. الأمر ينشئ الملف إن غاب ويطبق كل `migrations/*.sql` بالترتيب الأبجدي. الموجود الآن: `001_init.sql` ثم `002_admin.sql` ثم `003_security.sql` (فهرس انتهاء رموز Turnstile) ثم `004_stats.sql` (دلاء العدادات ومدرج الكمون) ثم `005_indexes.sql` (فهارس مسارات قراءة التشغيل والمستخدم) ثم `006_uploads.sql` (فهارس قراءة المرفقات في `documents`/`chunks`/`extraction_jobs`/`files`). الأسماء المطبقة تُحفظ في `schema_migrations`. تشغيل ثانٍ يطبع `no pending migrations`. أول فتح لقاعدة التطبيق من الخادم يطبق الهجرات المعلقة أيضًا.

الملف التشغيلي وملفات `-wal` و`-shm` و`-journal` مستبعدة من Git. لا تحذف `data/chate.sqlite` عند تجهيز المستودع.

## النسخ الاحتياطي

SQLite هنا ملف بكاتب واحد في اللحظة. الاتصال يفعّل وضع WAL. عملية الويب والعامل يشتركان في الملف، والكتابة تُسلسل عبر مهلة الانشغال. الملف لا يناسب عدة أجهزة تكتب معًا.

لا يوجد أمر نسخ داخل التطبيق. انسخ الملف بعد إيقاف التطبيق والعامل. إن بقي `data/chate.sqlite-wal` أو `data/chate.sqlite-shm` فانسخهما مع الملف الرئيسي. البديل هو واجهة النسخ في SQLite (`backup` أو `VACUUM INTO`) بدل نسخ ملف مفتوح تحت كاتب نشط.

## البيئة

الأسماء والقيم الفارغة في [`.env.example`](.env.example). لا تضع قيمة سر في Git.

أسرار الخادم، وتبقى فارغة في المثال:

- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY`
- `SESSION_SECRET`
- `TURNSTILE_SECRET_KEY`
- `OTP_HTTP_AUTHORIZATION`
- `OTP_PEPPER`

قيم عامة وليست أسرارًا:

- `NEXT_PUBLIC_TURNSTILE_SITE_KEY` و`TURNSTILE_SITE_KEY`: مفتاح موقع Turnstile العام، ومكتوب في المثال.
- `GOOGLE_CLIENT_ID` و`NEXT_PUBLIC_GOOGLE_CLIENT_ID`: معرف عميل Google العام نفسه.
- `APP_URL`: في المثال `http://localhost:3211`.
- `TURNSTILE_EXPECTED_HOSTNAMES`
- `SQLITE_PATH=data/chate.sqlite`
- `STORAGE_DIR`: مجلد التخزين الخاص للملفات (افتراضي `storage`، مستبعد من Git). `DOWNLOAD_URL_TTL_SECONDS` غير مقروء بعد لعدم وجود مسار تنزيل عام.
- `USER_QUOTA_UNITS` و`SHARED_QUOTA_UNITS` و`MAX_USER_CONCURRENCY` و`MAX_GLOBAL_CONCURRENCY` و`MODEL_TIMEOUT_MS` و`MAX_PROVIDER_RETRIES`
- حدود الرفع المنفّذة: `MAX_FILE_BYTES` (الافتراضي 26214400) وخمسة ملفات و50 مبيبايت للطلب. `MAX_ZIP_ENTRIES` و`MAX_ZIP_DEPTH` و`MAX_ZIP_UNCOMPRESSED_BYTES` موثقة لكن غير مقروءة بعد.
- `OTP_PROVIDER` و`OTP_HTTP_URL`
- `ADMIN_GOOGLE_SUBS` و`ADMIN_EMAILS`
- `RETENTION_COMPARISON_DAYS` و`RETENTION_FILE_DAYS`
- `HAIKU_LIVE_CALLS`: `0` افتراضيًا؛ لا يُرسل Haiku حيًا إلا بالقيمة `1` وموافقة المالك على التكلفة.

## النماذج والحصص

لا يُستدعى إلا نموذج معلّم متاحًا في السجل، مع `policyAllowsTraffic` و`liveNetwork`. النماذج المقيدة تبقى في `GET /api/models` وفي الواجهة، و`executeRun` يحفظ `POLICY_BLOCKED` بلا `dispatchModel`.

متاح للإرسال حسب السجل: `google/gemma-4-31b-it:free`، `recursive/flint-v1.0:free`، `google/gemma-4-26b-a4b-it:free`، `xingchen-agi/xing4.0-29b-a4b:free`، `cohere/north-mini-code:free`، `baseten/mammoth-1:free`، `baseten/elephant-1:free`، `respan/span-01-lite:free`، `openrouter/free`، و`claude-haiku-5-5`.

مقيد ويبقى ظاهرًا بلا استدعاء: Super VL، Lightning، Inkling، Inkling Small، Ultra، Nano Omni، LFM2.5، Embed 1B، Embed 8B، LFM embedding، Rerank 8B، Content Safety، وFish S2.1.

`POST /api/comparisons` يخطط نماذج الإجابة فقط. نماذج القرار والتقييم والتضمين وإعادة الترتيب والكلام لا تُرسل من هذا المسار حتى لو كان سجلها «متاح». `openrouter/free` خارج المقارنة المضبوطة، ومرسل OpenRouter يرفض أي معرف لا ينتهي بـ `:free`. هو ليس بديلًا صامتًا.

Claude Haiku 5.5 معرف `claude-haiku-5-5` عبر Anthropic مباشرة على `https://api.anthropic.com/v1/messages`. التفكير `thinking.type=adaptive` والجهد `output_config.effort=medium`. ليس OpenRouter، ولا يُستدعى مكان نموذج مجاني فشل أو غاب. تكلفته حساب Anthropic منفصل عن وحدات OpenRouter. الاستدعاء الحي معطّل افتراضيًا: لا يُرسل Haiku إلا عند ضبط `HAIKU_LIVE_CALLS=1` صراحةً بعد موافقة المالك على الصرف. سُجّل استدعاء حي ناجح مرة واحدة في تحقق الإصدار (2026-10-28) كما في قسم «الأدلة الحية»، ويبقى القاطع البيئي هو الافتراضي.

الحصة: مقارنة إلى N نماذج OpenRouter في حالة `queued` تحجز N وحدات OpenRouter. Haiku يُحجز على حساب المزود `anthropic` ولا يُسحب من رصيد OpenRouter. الافتراضي في المثال: `USER_QUOTA_UNITS=200` و`SHARED_QUOTA_UNITS=2000`. الحدود الرقمية مشتركة كأرقام بيئة، والحسابات مفصولة بالمزود.

ثلاثة معرفات قديمة للتضمين وإعادة الترتيب مرفوضة إن طُلبت وليست في الاختيارات: `nvidia/nemotron-3-embed-1b:free` و`nvidia/llama-nemotron-embed-vl-1b-v2:free` و`nvidia/llama-nemotron-rerank-vl-1b-v2:free`.

## الترخيص

هذا المشروع مرخّص بترخيص MIT — انظر [LICENSE](LICENSE). حقوق النشر (c) 2026 BedBankSA. تراخيص الاعتماديات الخارجية وشروط مزودي النماذج تبقى سارية. المستودع عام، والترخيص يسمح بالاستخدام والتعديل وإعادة التوزيع مع الإبقاء على نص الترخيص.

## الحالة

موجود في الكود، ويُفحص باختبارات ملف مؤقت وبخادم إنتاجي محلي وتحقق حي من المزودين (قسم الأدلة أدناه):

- زر Google الرسمي يفتح نافذة حساب واحدة، ويكتمل مسار الجلسة عند ضبط معرف العميل و`SESSION_SECRET`. أصل التطوير `http://localhost:3211` يجب أن يكون مسجّلًا في Google Cloud.
- ودجت Turnstile والتحقق على الخادم عند ضبط سر Turnstile، مع منع إعادة الاستخدام عبر SQLite.
- تخطيط المقارنة، ومنع النموذج المقيد، وشكل طلب Haiku بجهد `medium`، وتعطيل Haiku الحي افتراضيًا حتى `HAIKU_LIVE_CALLS=1`.
- هجرات SQLite وحجز الحصة وربط المقارنة بمستخدم الجلسة، وتحقق جلسة مقابل صف المستخدم الفعلي (إيقاف/إبطال فوري).
- بوابة الجوال: بلا رقم موثّق لا يُرسل استدعاء نموذج.
- توثيق الجوال منفّذ: `POST /api/otp/send` و`POST /api/otp/verify` مع تخزين تحدٍّ مجزّأ، ومحددات إرسال (3/15 دقيقة) ومحاولات (5)، وواجهة من خطوتين في `/profile/complete`. مزود الرسائل HTTP مثبّت بعقد موثّق ويُختبر ضد خادم HTTP حقيقي محليًا؛ يحتاج المالك إلى `OTP_PROVIDER=http` و`OTP_HTTP_URL` (https) لمزود رسائل حقيقي.
- رفع الملفات: تخزين بايتات خاص، كشف النوع من المحتوى، استخراج نص PDF/DOCX/نصوص، وربط `attachmentIds` بإنشاء المقارنة وتمرير الأدلة/الصور للنماذج.
- سجل المقارنات للقراءة فقط: `/history` و`/history/[id]` و`GET /api/history` مع عزل الحسابات.
- `GET /api/health` فحص جاهزية خفيف (قاعدة البيانات) بلا بيانات حساسة، و`Cache-Control: no-store` على ردود المقارنات.
- ترخيص MIT وCI بلا أسرار في `.github/workflows/ci.yml` وأداة عرض عام مؤقت في `scripts/deploy/public-demo.ps1`.
- حزمة تحقق متصفح بلا اعتماديات إضافية: `scripts/qa/run-e2e.mjs` عبر Chrome DevTools Protocol، وخادم اختبار محلي بمزودات وهمية `scripts/dev/mock-externals.cjs`، وحزمة تحقق إصدار E2E في `scripts/qa/verify-release.mjs`.

غير مكتمل:

- لوحة الإدارة: `/admin` محمية بجلسة Google المخزنة وبقائمة `ADMIN_GOOGLE_SUBS`/`ADMIN_EMAILS`، لا ببريد مكتوب في الرابط. تعرض عدادات محلية (الأسئلة، الاستدعاءات، الأخطاء، الرموز، الملفات، التخزين)، وجدول مستخدمين بلا نص سؤال أو إجابة، وسجل تدقيق، وآخر أربعة أحرف من إصدارات الأسرار. `GET /api/admin/overview` يعيد 401/403 أو بيانات الإدارة، و`POST /api/admin/users` يقبل إيقافًا أو تفعيلًا أو تعديل حصة مع تحقق CSRF وأصل مطابق. العدادات تُكتب من مسار المقارنة في `operation_stats` و`operation_buckets` و`latency_histogram` (الهجرة `004_stats.sql`). لا نبض حضور موصول، لذلك تظهر بطاقتا الحضور «غير متاح» بدل صفر مضلّل. لا تدوير أسرار ولا تنبيه خارجي من الصفحة.
- مزود الرسائل الحقيقي غير مهيأ في هذا التجهيز، ولم يُرسل رمز SMS حي عبر شبكة مشغّل رسائل. المثبت هو دورة HTTP حقيقية: المسار ← `HttpOtpProvider` ← خادم HTTP محلي ← التقاط الرمز ← التحقق ← `phone_verified_at`.
- لا نشر عام دائم، ولا نطاق، ولا TLS إنتاجي، ولا نظام دفع. العرض العام المؤقت عبر Cloudflare quick tunnel أداة عرض لا تنشر إنتاجيًا (B2).
- لا يُدّعى نجاح استدعاء حي إلا ما هو مسجّل في قسم الأدلة أدناه مع مزود محدد وتاريخ.
- رفع الملفات منفّذ لكن غير منفّذ: رابط تنزيل عام، حذف الملفات، وتطبيق `RETENTION_FILE_DAYS`؛ ولا يقرأ الكود بعد `DOWNLOAD_URL_TTL_SECONDS` أو `MAX_ZIP_*`.
- حذف الحساب ما زال غير منفّذ بمسار، وإعدادات الاحتفاظ في `retention_settings` لا يطبّقها عامل دوري بعد.
- لا توجد حزمة Playwright؛ التحقق المتصفحي هنا يعتمد على سكربت CDP داخل المستودع (`scripts/qa`).

## الأدلة الحية

- **استدعاءات المزودين الحية (2026-10-28):** نُفّذت مقارنة كاملة عبر خادم إنتاجي محلي مع شبكة حقيقية. `claude-haiku-5-5` أكمل برد حقيقي (433 توكن دخل/6 خرج، 1935 مللي ثانية، تكلفة 0.000046 دولار)، و`cohere/north-mini-code:free` أكمل برد حقيقي (178/152 توكن، 2678 مللي ثانية). فشل نموذجان مجانيان آخران بسبب 429 من المزود ولم يمنعا نجاح البقية. الأدلة الخام: `docs/evidence/live-provider-calls.md` و`docs/evidence/release-verification-2026-10-28T14-06-54-260Z.json`. القيود المعلنة: Turnstile مرّ عبر رمز QA لا ودجت متصفح، والجلسة مزروعة لا دخول Google، وOTP عبر خادم HTTP محلي لا مزود SMS.
- **تحقق الإصدار (mock + live):** `scripts/qa/verify-release.mjs` يغطي 14 فحصًا (13 PASS + 1 SKIP للتحقق المتصفحي الاختياري) في الوضعين: الصحة والرؤوس، السجل، 401 للمجهول، Turnstile (مفقود/خاطئ/معاد)، OTP حقيقي عبر HTTP loopback حتى `phone_verified_at`، رفع txt/pdf/png، مقارنة بمرفقات مع 4 نتائج مستقلة، ربط الأدلة في القاعدة، السجل `/history` و`/history/[id]`، عزل IDOR، وتنقية الأسرار. الأدلة: `docs/evidence/release-verification-*.json`.
- **CI:** `.github/workflows/ci.yml` يشغّل typegen/typecheck/lint/test/build/check:bundle بلا أسرار. النشر العام الدائم ما زال غير منفّذ (B2)؛ العرض المؤقت لا يُحتسب نشرًا.

## التوثيق الإضافي

- `docs/audit/SECURITY-AUDIT.md` و`docs/audit/THREAT-MODEL.md` و`docs/audit/SECRETS-INVENTORY.md`: تدقيق أمني وهجوم محلي وجرد أسرار.
- `docs/audit/PERFORMANCE-RESOURCES.md` و`docs/audit/PERFORMANCE-QUICKWINS.md`: قياسات الأداء والذاكرة والسعة وأولويات التحسين.
- `docs/audit/QA-UX-REPORT.md`: تجربة المستخدم والتحقق المتصفحي.
- `docs/launch/`: جاهزية الإطلاق، قائمة الإطلاق، دليل النشر، نموذج التكلفة، المراجعة القانونية، وأصول المالك. `deploy/` يحوي Docker وsystemd وCaddy ونسخًا احتياطيًا.
- `docs/marketing/`: حزمة تسويق عربية/إنجليزية، حملة إطلاق، وسجل ادعاءات بأدلة.
