[English](README.en.md)

# ChatE

تطبيق ويب عربي لمقارنة النماذج. السؤال واحد، والملفات اختيارية، والإجابات تظهر جنبًا إلى جنب كلما وصلت. تعثر نموذج لا يوقف البقية. المتصفح لا يستدعي OpenRouter ولا Anthropic؛ مفاتيح المزود تبقى على الخادم.

## ماذا يفعل

مساحة العمل في `/workspace` ترسل السؤال إلى النماذج التي يختارها المستخدم، ثم تقرأ نتيجة المقارنة من الخادم. الاختصارات الظاهرة: محادثة (Gemma 4 31B)، برمجة (Flint)، خفيف (Gemma 4 26B)، ومقارنة تجمع هذه الثلاثة مع Claude Haiku 5.5. هذا ليس سجل محادثة متعدد الجولات. صفحة `/history` نص توضيحي ولا تعرض الصفوف المحفوظة.

دعم الملفات جزئي. كود النطاق يتعرف على النوع من البايتات: PDF، PNG، JPEG، GIF، WebP، DOCX، XLSX، ZIP، OLE، نص، JSON، CSV، TSV، Markdown، وصوت وفيديو. واجهة الاختيار ترسل أسماء الملفات فقط إلى `POST /api/uploads`. ذلك المسار يتحقق من Turnstile ثم يعيد 401 ولا يخزن البايتات. إنشاء المقارنة يمرر مرفقات فارغة.

الدخول بحساب Google عبر زر Google Identity Services ورمز الهوية، مع nonce في كوكي. تدفق الهوية هذا لا يستخدم سر عميل Google. Turnstile يعمل بوضع `interaction-only` وتنفيذ `execute`: لا مربع تحقق ظاهر إلا إذا طلبت Cloudflare تفاعلًا. الخادم يتحقق من الرمز مرة واحدة ولا يعيد استخدامه.

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

لا تفتح خادم تطوير ثانٍ إذا كان واحد يعمل على 3211. لا تستخدم المنفذ 3000 لـ ChatE على هذه الآلة؛ هو تطبيق آخر. أصل JavaScript المصرح به في Google يجب أن يطابق الأصل الفعلي، ومحليًا هو `http://localhost:3211`.

`npm run build` ثم `npm start` يبنيان نسخة الإنتاج. لا يوجد نشر عام في هذا المستودع.

`npm run worker` يفتح ملف SQLite نفسه، ويطبق الهجرات المعلقة، ويعيد المهام القديمة إلى الطابور. حلقته لا تأخذ مقارنات ولا تستدعي مزودًا. تنفيذ المقارنة يتم داخل عملية Next.js.

## قاعدة البيانات

`npm run db:migrate` يشغّل `scripts/migrate.ts`. المسار من `SQLITE_PATH`، والافتراضي `data/chate.sqlite`، ويُحل نسبيًا من جذر المشروع. الأمر ينشئ الملف إن غاب ويطبق كل `migrations/*.sql` بالترتيب الأبجدي. الموجود الآن: `001_init.sql` ثم `002_admin.sql`. الأسماء المطبقة تُحفظ في `schema_migrations`. تشغيل ثانٍ يطبع `no pending migrations`. أول فتح لقاعدة التطبيق من الخادم يطبق الهجرات المعلقة أيضًا.

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
- `STORAGE_DIR` و`DOWNLOAD_URL_TTL_SECONDS`
- `USER_QUOTA_UNITS` و`SHARED_QUOTA_UNITS` و`MAX_USER_CONCURRENCY` و`MAX_GLOBAL_CONCURRENCY` و`MODEL_TIMEOUT_MS` و`MAX_PROVIDER_RETRIES`
- حدود الرفع: `MAX_FILE_BYTES` و`MAX_ZIP_ENTRIES` و`MAX_ZIP_DEPTH` و`MAX_ZIP_UNCOMPRESSED_BYTES`
- `OTP_PROVIDER` و`OTP_HTTP_URL`
- `ADMIN_GOOGLE_SUBS` و`ADMIN_EMAILS`
- `RETENTION_COMPARISON_DAYS` و`RETENTION_FILE_DAYS`

## النماذج والحصص

لا يُستدعى إلا نموذج معلّم متاحًا في السجل، مع `policyAllowsTraffic` و`liveNetwork`. النماذج المقيدة تبقى في `GET /api/models` وفي الواجهة، و`executeRun` يحفظ `POLICY_BLOCKED` بلا `dispatchModel`.

متاح للإرسال حسب السجل: `google/gemma-4-31b-it:free`، `recursive/flint-v1.0:free`، `google/gemma-4-26b-a4b-it:free`، `xingchen-agi/xing4.0-29b-a4b:free`، `cohere/north-mini-code:free`، `baseten/mammoth-1:free`، `baseten/elephant-1:free`، `respan/span-01-lite:free`، `openrouter/free`، و`claude-haiku-5-5`.

مقيد ويبقى ظاهرًا بلا استدعاء: Super VL، Lightning، Inkling، Inkling Small، Ultra، Nano Omni، LFM2.5، Embed 1B، Embed 8B، LFM embedding، Rerank 8B، Content Safety، وFish S2.1.

`POST /api/comparisons` يخطط نماذج الإجابة فقط. نماذج القرار والتقييم والتضمين وإعادة الترتيب والكلام لا تُرسل من هذا المسار حتى لو كان سجلها «متاح». `openrouter/free` خارج المقارنة المضبوطة، ومرسل OpenRouter يرفض أي معرف لا ينتهي بـ `:free`. هو ليس بديلًا صامتًا.

Claude Haiku 5.5 معرف `claude-haiku-5-5` عبر Anthropic مباشرة على `https://api.anthropic.com/v1/messages`. التفكير `thinking.type=adaptive` والجهد `output_config.effort=medium`. ليس OpenRouter، ولا يُستدعى مكان نموذج مجاني فشل أو غاب. تكلفته حساب Anthropic منفصل عن وحدات OpenRouter. هذه الوثيقة لا تدّعي نجاح استدعاء حي.

الحصة: مقارنة إلى N نماذج OpenRouter في حالة `queued` تحجز N وحدات OpenRouter. Haiku يُحجز على حساب المزود `anthropic` ولا يُسحب من رصيد OpenRouter. الافتراضي في المثال: `USER_QUOTA_UNITS=200` و`SHARED_QUOTA_UNITS=2000`. الحدود الرقمية مشتركة كأرقام بيئة، والحسابات مفصولة بالمزود.

ثلاثة معرفات قديمة للتضمين وإعادة الترتيب مرفوضة إن طُلبت وليست في الاختيارات: `nvidia/nemotron-3-embed-1b:free` و`nvidia/llama-nemotron-embed-vl-1b-v2:free` و`nvidia/llama-nemotron-rerank-vl-1b-v2:free`.

## الترخيص

لم يُختَر ترخيص لهذا المشروع بعد. لا تفترض ترخيصًا مفتوحًا من وجود المستودع. تراخيص الاعتماديات الخارجية وشروط مزودي النماذج تبقى سارية.

## الحالة

موجود في الكود، ويُفحص بمنطق واختبارات ملف مؤقت بلا مزود حي:

- زر Google ومسار إكمال الجلسة عند ضبط معرف العميل و`SESSION_SECRET`.
- ودجت Turnstile والتحقق على الخادم عند ضبط سر Turnstile.
- تخطيط المقارنة، ومنع النموذج المقيد، وشكل طلب Haiku بجهد `medium`.
- هجرات SQLite وحجز الحصة وربط المقارنة بمستخدم الجلسة.
- بوابة الجوال: بلا رقم موثّق لا يُرسل استدعاء نموذج.

غير مكتمل:

- لوحة الإدارة. `/admin` فقرة ثابتة، و`GET /api/admin/overview` يعيد 401 دائمًا بلا قراءة جلسة. لا صفحة تعرض المستخدمين أو الاستخدام أو مفاتيح API. يوجد كود خادم غير موصول بهذه الصفحة: استعلام حسابات يعيد الاسم والبريد والجوال والمدينة والعدادات بلا نص السؤال، و`002_admin.sql` يضيف جداول تشغيل بلا نص الرسالة أو اسم الملف، وعرض حالة السر يظهر آخر أربعة محارف. `stripPrivateKeys` يحذف مفاتيح مثل `question` و`output_text`. `npm test` لا يغطي هذه الملفات، لذلك القاعدة واللوحة غير منجزتين.
- الرسائل القصيرة الحقيقية غير مهيأة. المثال يضع `OTP_PROVIDER=fake`، والإنتاج يرفض غير `http`. حتى مع `OTP_PROVIDER=http` وعنوان للإرسال، `POST /api/otp/send` يعيد أن الإرسال الحقيقي غير مفعّل. لذلك تبقى استدعاءات النماذج ممنوعة حتى يُوثَّق الجوال.
- أصل Google يجب أن يشمل المنفذ المستخدم فعلًا: `http://localhost:3211` محليًا، لأن 3000 تطبيق آخر.
- لا نشر عام.
- لا يُدّعى هنا نجاح OpenRouter أو Anthropic الحي. لم يُرَ اختبار فعل ذلك ضمن هذا التجهيز.
- رفع الملفات وتخزينها وربطها بالسؤال غير مكتمل. مجلد `storage` مسار مُعد ومستبعد من Git.
- سجل المقارنات وحذف الحساب نص في الصفحات، بلا مسار ينفّذ الحذف.
- اختبارات Playwright غير مشغّلة في خطوات هذا التجهيز.
