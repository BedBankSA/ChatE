# التدقيق الأمني العدائي — ChatE (فرع `fix/p0-phone-otp-audit`)

| البند | القيمة |
| --- | --- |
| المدقق | audit-security (security-reviewer + red-team) — سرب ChatE |
| لقطة القراءة | 2026-10-29 ~08:10 بتوقيت الرياض (الشجرة كانت **تتغيّر أثناء الفحص** بواسطة فريق إصلاح موازٍ: ظهرت ملفات `phone/*` و`admin/phones` و`migrations/008` واختبارات `phone-*` خلال الجلسة) |
| الطريقة | مراجعة ساكنة سطر-بسطر لكل `src/app/api/**` و`src/server/**` و`src/domain/{auth,admin,security,files,comparisons,models}` و`next.config.ts` و`.env.example` والهجرات، مع `grep` لأنماط الحقن/التسريب/الأسرار. **لم يُشغَّل أي خادم أو اختبار** (node_modules قيد التثبيت، و`npm install/build` ممنوع). |
| المخرج | `docs/swarm/security-audit-AR.md` فقط (لم يُعدَّل أي ملف آخر) |
| المرجع السابق | `docs/audit/SECURITY-AUDIT.md` (2026-10-28). أعيد التحقق من بنوده لا من نصوصه. |

---

## 1) الملخص التنفيذي

1. **لا توجد ثغرة P0 مؤكدة** (لا يوجد تجاوز مصادقة/IDOR/حقن SQL/تنفيذ كود مثبت بالقراءة الساكنة)، والطبقات الأساسية (الجلسة، تفويض الإدارة، Turnstile أحادي الاستخدام، منع IDOR، معاملات SQL) سليمة ومُدعَّمة باختبارات موجودة.
2. **نتيجتان P1 في مسار الرفع**: (أ) `/api/uploads` لا يطبّق بوابة توثيق الجوال ولا حصة تخزين رغم أن السياسة المعلنة تقول إن «الرفع» لا يُفتح قبل التوثيق؛ أي حساب Google جديد يمكنه الرفع بلا حد تراكمي. (ب) استخراج DOCX/ZIP غير محمي بحدود إزالة الضغط رغم وجود أدوات القيود مكتوبة (dead code) وموثّقة في `.env.example` — رفع ملف واحد مضغوط بعناية قد يستهلك ذاكرة/معالج الخادم (DoS).
3. **سلسلة OTP تحتاج تشديدًا**: عدّاد المحاولات ما زال TOCTOU (فحص لقطة ثم زيادة لاحقة) ويسمح لدفعة متوازية بتجاوز 5 محاولات/تحدٍّ؛ وسقف المعدل الوحيد المبقي مبني على `x-forwarded-for`/`cf-connecting-ip` القابلة للتزوير ⇒ يمكن تعطيله.
4. **جديد فرع P0 (سجل الجوال)**: بوابة ملكية الرقم داخل المعاملة سليمة (لا يمكن حسابان توثيق نفس الرقم)، لكن استجابة `/api/otp/send` بـ `409 PHONE_TAKEN` أصبحت **أوراكل تعداد** يكشف أرقام العملاء الموثّقة دون إرسال SMS (قبل عدّادات الإرسال).
5. **الأسرار**: مفاتيح المزودين تُخزَّن **نصًا صريحًا** في جدول `system_settings` داخل SQLite، وملف القاعدة يُنشأ بأذونات افتراضية بلا تشديد (يحتاج تحقق على المضيف). هذا P2 لأن أي نسخة احتياطية/تزامن/وصول محلي للقاعدة يسرّب مفاتيح مدفوعة.
6. **الاحتفاظ والحد الأدنى من البيانات**: `RETENTION_COMPARISON_DAYS`/`RETENTION_FILE_DAYS` موثّقة في `.env.example` لكنها **غير مستخدمة في الكود إطلاقًا** (0 نتيجة grep)، وسجل `phone_history` دائم لا يقبل حذفًا/تعديلًا ⇒ بيانات شخصية بلا سياسة إزالة منفذة.
7. ما تم التحقق من سلامته بالدليل: منع IDOR في المقارنات/السجل/الملفات، تثبيت الاستعلامات (parameterized) وقوائم سماح ORDER BY، هروب LIKE، توقيع الجلسة وفحص الإيقاف/السحب، فحص Origin+CSRF لعمليات الإدارة، Turnstile أحادي الاستخدام، وحارس تسريب الهوية إلى المطالبات.
8. **القيود**: لا اختبار حي ولا شبكة، والشجرة متغيرة؛ أرقام الأسطر لحظة القراءة أعلاه، ويجب إعادة التحقق قبل التطبيق. تفاصيل «ما لم يُفحص» في §6.

---

## 2) جدول النتائج (Findings)

| ID | الخطورة | الملف:السطر | الوصف | الأثر | الإصلاح المقترح | يحتاج اختبار |
| --- | --- | --- | --- | --- | --- | --- |
| SEC-01 | **P1** | `src/app/api/uploads/route.ts:77-106`؛ `src/app/verify-phone/page.tsx:48`؛ `src/server/comparisons/handle.ts:36`؛ `src/app/api/uploads/route.ts:108-158` | رفع الملفات يتحقق من الجلسة+Turnstile فقط، **بلا فحص توثيق الجوال وبلا حصة تخزين لكل مستخدم**؛ بينما المقارنات مقيّدة بـ `modelUseBlock` (سطر 36) والصفحة تعلن أن الرفع مقيّد بالتوثيق (سطر 48). | حساب Google جديد غير موثّق يستطيع الرفع مباشرة عبر API (تجاوز سياسة معلنة) وإشباع قرص الخادم بطلبات 50MiB متكررة بلا سقف تراكمي. | تطبيق بوابة الجوال على رفع الملفات (نفس `modelUseBlock`) + محاسبة تخزين لكل مستخدم (count/bytes من جدول `files`) مع رفض 403/413، وربطها بحد التخزين. | نعم (تكامل) |
| SEC-02 | **P1** | `src/server/files/extract.ts:129-141`؛ `src/server/files/storage.ts:81-89`؛ `src/domain/files/content.ts:105-133,147`؛ `.env.example:52-54` | استخراج DOCX عبر mammoth وتصنيف ZIP عبر JSZip على بايتات المهاجم بلا أي حد لعدد المدخلات/عمق/الحجم بعد فك الضغط؛ دوال `inspectZipEntry/ZipLimits/officeRoute` **غير مستخدمة** (0 مراجع) والمتغيرات `MAX_ZIP_*` موثّقة لكنها غير مقروءة في الكود. | **Zip Bomb**: DOCX ≤25MiB قد يتضخم لمئات الميغابايتات/غيغابايتات في الذاكرة ⇒ تعليق/انهيار العملية (DoS لكل المستخدمين). | فرض حدود فك الضغط قبل الاستخراج (entries/depth/uncompressed/member)، رفض نسبة ضغط شاذة، تنفيذ الاستخراج في عامل معزول بمهلة وذاكرة محدودة. | نعم (ملف DOCX خبيث) |
| SEC-03 | **P2** | `src/server/guard.ts:134-139,176-179` | مفتاح تحديد المعدل = أول `cf-connecting-ip` أو `x-forwarded-for` من رأس يرسله العميل؛ لا يوجد وضع `TRUST_PROXY` ولا التحقق من أن الطلب من وكيل موثوق. | تزوير رأس لكل طلب ⇒ دلو جديد لكل محاولة ⇒ تعطيل `turnstile:login/otp` و`otp_verify` و`auth:intent` (إساءة إرسال SMS/تخمين أوسع/إغراق). | استخراج عنوان العميل من مقبس الاتصال افتراضيًا، وقبول الرؤوس فقط من وكلاء مُعدّين (قائمة CIDR/ثابت)، مع توثيق النشر. | نعم (تزوير XFF) |
| SEC-04 | **P2** | `src/app/api/otp/verify/route.ts:28-35,51-70`؛ `src/domain/auth/otp.ts:62-70`؛ `src/server/otp/service.ts:74-82` | TOCTOU في حد المحاولات: `verifyChallenge` يقرر من **لقطة** `challenge.attempts`، ثم `incrementAttempts` يزيد ذريًا **بعد** المقارنة؛ طلبات متوازية تقرأ كلها attempts=0 فتتجاوز حد 5، وسقف IP الوحيد قابل للتزوير (SEC-03). | توسيع نافذة تخمين رمز 6 أرقام لكل تحدٍّ (خطر "حجز" رقم عميل غير مُوثّق عبر تخمين الرمز) وإغراق سجل التدقيق. | "استهلاك محاولة" ذري قبل المقارنة (`UPDATE ... SET attempts=attempts+1 WHERE id=? AND attempts<5 AND consumed_at IS NULL` داخل معاملة) ثم المقارنة بالتجزئة؛ الرجوع بالسبب من نتيجة UPDATE. | نعم (توازٍ) |
| SEC-05 | **P2** | `src/app/api/otp/send/route.ts:88-95` (الرسالة `PHONE_TAKEN` في السطور 35-36) | تعداد أرقام: إذا كان الرقم موثّقًا في حساب آخر تُرجع `409 PHONE_TAKEN` **قبل** عدّادات الإرسال (السطور 100-107)، أي بلا إرسال SMS وبلا استهلاك نافذة الإرسال. | كشف قائمة أرقام عملاء ChatE (خصوصية) وتمكين Smishing مستهدف؛ كشف وجود الحساب عبر رقم. | استجابة موحّدة لا تكشف الملكية (مثل `200 {sent:true}` أو رسالة عامة)، وتسجيل سبب الرفض داخليًا فقط + حد معدل على استعلام الملكية. | نعم |
| SEC-06 | **P2** | `migrations/007_settings_roles.sql:4-8`؛ `src/server/db/settings.ts:105-109`؛ `src/server/db/connection.ts:9-12` | مفاتيح `ANTHROPIC_API_KEY/OPENROUTER_API_KEY/TURNSTILE_SECRET_KEY/SMS_*` تُخزَّن نصًا صريحًا في `system_settings.value`؛ ملف `data/chate.sqlite` يُنشأ بلا تشديد أذونات (mkdir بلا mode، وقاعدة SQLite بأذونات افتراضية). | تسريب قاعدة (نسخة احتياطية/تزامن سحابي/مستخدم محلي/مسار آخر) = سيطرة على مفاتيح مدفوعة وتكلفة غير مصرّح بها، وقد يشمل PII. | تشفير القيم بـ AES-256-GCM بمفتاح من متغير بيئة/KMS مع تدوير، `chmod 0700` للمجلد و`0600` للملفات على POSIX، استثناء `data/` من النسخ/التزامن، وتدوير المفاتيح. | جزئيًا (أذونات) |
| SEC-07 | **P2** | `.env.example:106-108`؛ `migrations/008_phone_audit.sql:36-46`؛ grep لـ`RETENTION_` = 0 في `src` | سياسة الاحتفاظ موثّقة لكنها غير منفذة في أي كود/عامل؛ و`phone_history` مقفلة أمام UPDATE/DELETE (وهذا صحيح كسجل تدقيق) لكن بلا مسار تقادم/إخفاء هوية. | استبقاء PII (أرقام + IP + UA) إلى الأبد ⇒ مخاطر امتثال/خصوصية وتكبير أثر أي اختراق. | مهمة احتفاظ مجدولة (comparisons/files) + تقادم `phone_history` (إخفاء الهوية أو crypto-shredding لعمود الهاتف/الشبكة)، وتوثيق مدة الاحتفاظ في `docs/`. | نعم |
| SEC-08 | P3 | `src/app/api/otp/verify/route.ts:28-35` مقابل `src/server/guard.ts:207-209` | مسار التحقق POST لا ينادي `sameOriginRequest` (بينما الإرسال/الدخول/المقارنة تفعل عبر `gateTurnstile`). | الضابط الوحيد CSRF هو SameSite=Lax؛ أي تغيير مستقبلي في الكوكيز/سياسة الوسيط يفتح CSRF على تغيير رقم الجوال. | إضافة فحص الأصل قبل معالجة الطلب (نفس `sameOriginRequest`). | نعم |
| SEC-09 | P3 | `src/app/api/admin/settings/route.ts:42-44`؛ `src/server/admin/http.ts:38-40` | مسارا الإدارة يقرآن `request.formData()` بلا حد للجسم (بينما `readJson` يحدّ 1MiB في `guard.ts:14`). | DoS لذاكرة الخادم من جلسة إدارة (ثقة أعلى، أثر أقل). | حدّ Content-Length + قراءة متدفقة محدودة قبل formData. | نعم |
| SEC-10 | P3 | `src/domain/security/headers.ts:1-19`؛ `src/app/layout.tsx:34-37,45` | CSP الإنتاج يسمح `script-src 'unsafe-inline'` بلا nonce؛ نقطة الحقن الوحيدة الحالية (`dangerouslySetInnerHTML` لتهيئة JSON) مهرَّبة بـ `<` → `\u003c` فلا XSS حاليًا. | إضعاف دفاع XSS عند أول مصرف مستقبلي. | nonce عبر middleware + `strict-dynamic`؛ إزالة `unsafe-inline`. | جزئيًا |
| SEC-11 | P3 | `src/server/sms/adapter.ts:89-97,466-478` | مزود mock التطويري يطبع **رمز OTP كاملًا** إلى stdout (`console.log` سطر 477)؛ مرفوض في `NODE_ENV=production` ومُعامل كـ production عند غياب NODE_ENV. | تشغيل صريح بـ NODE_ENV غير production على خادم مكشوف ⇒ تسريب رموز في السجلات. | عدم طباعة الرمز إطلاقًا (طباعة قناع)، واشتراط علم صريح + loopback لتشغيل mock. | لا |
| SEC-12 | P3 | `src/server/otp/config.ts:9-15` | `OTP_PEPPER` يعود إلى `SESSION_SECRET` (إعادة استخدام مفتاح بين HMAC للجلسات وSHA-256 لرموز OTP، وتدوير مرتبط). | مفتاح واحد يحمي سرّين مختلفين؛ سلوك غير موثّق لتغيير SESSION_SECRET (يبطل تحقق OTP). | اشتراط `OTP_PEPPER` مستقل في فحص بدء تشغيل الإنتاج. | نعم |
| SEC-13 | P3 | `src/server/turnstile.ts:13-22` | اسم المضيف وعنوان IP لفحص Turnstile مأخوذان من `x-forwarded-host`/`x-forwarded-for` القابلة للتمرير؛ الفحص الحاسم من Cloudflare (`remote.hostname/action/challenge_ts`) يحدّ الأثر. | تقليل عمق الدفاع فقط إذا غاب وكيل ينظّف الرؤوس. | نفس معالجة SEC-03 (قائمة وكلاء موثوقة / TRUST_PROXY). | لا |
| SEC-14 | P3 | `src/domain/admin/dashboard.ts:158-166`؛ `src/server/admin/phones.ts:164-177` | شاشة `/admin/phones` تعرض `phone_history` لكل العملاء مع IP/UA والبريد، لكن **لا يُسجَّل حدث عرض** (التسمية `"view"` موجودة بلا أي كاتب: grep = 0). | مسؤول مُخترَق/فضولي يقرأ PII بلا أثر تدقيق (مساءلة/GDPR). | تسجيل `view` في `admin_audit_events` عند فتح سجل عميل، أو توثيق الاعتماد على سجلات الوصول في الوكيل. | نعم |

---

## 3) تفاصيل أهم النتائج

### SEC-01 — رفع الملفات خارج بوابة توثيق الجوال وخارج أي حصة (P1)
- **الدليل:** `src/app/api/uploads/route.ts:77-106` ينفّذ: جلسة → حدّ جسم → formData → `gateTurnstile("upload")`؛ لا يوجد أي استدعاء لـ`readStoredProfile`/`modelUseBlock` (بخلاف `src/server/comparisons/handle.ts:34-37`). السياسة المعلنة: `src/app/verify-phone/page.tsx:48` «ولا تُفتح النماذج والرفع والمقارنات إلا بعد إدخال الرمز». الحصص الوحيدة في `uploads/route.ts:108-118` لكل **طلب** (5 ملفات/25MiB/50MiB) وليست لكل مستخدم.
- **خطوات إثبات (تحتاج تحققًا حيًا):** (1) إنشاء حساب Google جديد دون توثيق جوال؛ (2) الحصول على توكن Turnstile action=`upload`؛ (3) `POST /api/uploads` multipart بملف صغير → المتوقع 200 مع صف في `files`؛ (4) تكرار الطلب: لا يوجد أي فحص مجموع ⇒ نمو قرص بلا سقف.
- **الإصلاح:** بوابة الجوال أولًا (نفس `modelUseBlock` مع `otpProviderConfigured`) ثم حساب `SUM(byte_size)/COUNT` من `files` للمستخدم ورفض > الحد؛ أضف حذف/انتهاء صلاحية للملفات.

### SEC-02 — استخراج غير محدود للـZIP/DOCX (P1)
- **الدليل:** `src/server/files/extract.ts:129-141` يمرّر بايتات المستخدم إلى `mammoth.extractRawText` بلا حدود؛ `src/server/files/storage.ts:81-89` يشغّل `JSZip.loadAsync` للتصنيف. أدوات الحماية `ZipLimits/inspectZipEntry/officeRoute/reportPages` في `src/domain/files/content.ts:105-147` غير مستوردة في أي ملف (0 مراجع)، ومتغيرات `.env.example:52-54` (`MAX_ZIP_ENTRIES/MAX_ZIP_DEPTH/MAX_ZIP_UNCOMPRESSED_BYTES`) غير مقروءة.
- **خطوات إثبات (تحتاج تحققًا حيًا):** أنشئ DOCX بحجم ≤25MiB يحوي `word/document.xml` مضغوطًا Deflate بنسبة عالية (تكرار حشو) وارفعه؛ راقب RSS/زمن الطلب/الانهيار. البديل الأرخص: ملف ZIP تصنيفي بمدخلات كثيرة لمهاجمة `JSZip.loadAsync`.
- **الإصلاح:** قراءة Central Directory وإخضاع كل مدخل لـ`inspectZipEntry` قبل أي فك ضغط؛ رفض النسبة > حد (مثلاً 100:1) والحجم الإجمالي > `MAX_ZIP_UNCOMPRESSED_BYTES`؛ مهلة/عامل منفصل للاستخراج (worker threads) وحد ذاكرة.

### SEC-03/04 — سلسلة تحديد المعدل وتخمين OTP (P2)
- **SEC-03:** `src/server/guard.ts:134-139` يبني مفتاح الدلو من رؤوس يرسلها العميل؛ `guard.ts:176-179` يستخدمه مباشرة. هذا يجعل `grep: otp_verify` بلا معنى إذا استُخدم رأس مختلف لكل طلب. **إثبات:** 3 طلبات إلى `/api/otp/verify` مع XFF مختلف لكل واحد لا تُنتج 429.
- **SEC-04:** `src/app/api/otp/verify/route.ts:51-70`: يقرأ `latestChallenge` ثم `verifyChallenge` على اللقطة (`src/domain/auth/otp.ts:62-70`)، ثم `incrementAttempts` (`src/server/otp/service.ts:74-82`) **بعد** المقارنة. **إثبات:** أرسل N طلبًا متوازيًا بكلمات مرور مختلفة على نفس التحدي؛ ستنجح كلها في تجاوز فحص `attempts < 5` إن التقطت اللقطة قبل أول تحديث (N>5). ملاحظة مخففة: حد الإرسال لكل رقم (5/15د، `OTP_MAX_SENDS_PER_PHONE` سطر 21) وحد الإرسال لكل مستخدم (3/15د) يحدّان عدد التحديات، فيبقى التخمين الفعلي محدودًا زمنيًا، لكن الضابط المعلن (5 محاولات/تحدٍّ) مكسور.
- **الإصلاح الموحّد:** (1) عنوان عميل من الطبقة السفلية أو TRUST_PROXY؛ (2) "حجز محاولة" ذري قبل المقارنة؛ (3) تسجيل المحاولات في المعاملة نفسها.

### SEC-05 — أوراكل تعداد أرقام العملاء (P2)
- **الدليل:** `src/app/api/otp/send/route.ts:88-95` يرجع `409 PHONE_TAKEN` حين يجد `findVerifiedPhoneOwner` مالكًا موثّقًا آخر، **قبل** عدّادات `countRecentSends/countRecentSendsToPhone` (السطور 100-107) وقبل إنشاء challenge/إرسال SMS؛ الرسالة (سطر 36) تقول صراحة إن الرقم مرتبط بحساب آخر. لا يلزم توكن Turnstile جديد لكل رقم (يلزم توكن لكل طلب) لكن لا استهلاك لنافذة الإرسال.
- **الأثر:** تعداد أرقام سعودية (بسرعة الحصول على توكنات Turnstile) لكشف عملاء الخدمة ⇒ خطر خصوصية + رسائل تصيّد.
- **الإصلاح:** مسار موحّد: عند ملكية رقم لغيرك، لا ترجع معلومة؛ إما رسالة عامة 200/400 موحّدة مع تسجيل داخلي، أو أرسل SMS إلى الرقم نفسه (التحقق يعني امتلاكه). أضف حد معدل مستقل على "استعلام الملكية" وقيد طلبات لكل جلسة.

### SEC-06 — أسرار المزودين نصًا صريحًا (P2)
- **الدليل:** الجدول `system_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)` (`migrations/007_settings_roles.sql:4-8`)؛ الكتابة تُدرج `parsed.value` مباشرة (`src/server/db/settings.ts:105-109`)؛ لا تشفير في أي مكان (`getSystemKey` يقرأ القيمة كنص). إنشاء ملف القاعدة: `mkdirSync(path.dirname(filePath), {recursive:true})` بلا mode وSQLite الافتراضي (`src/server/db/connection.ts:9-12`) ⇒ على POSIX عادة 0755/0644 حسب umask وبيئة النشر، وعلى Windows حسب ACL الموروث. المستودع نفسه على مسار OneDrive (سياق هذه الجلسة) ⇒ إن عمل التطبيق من هذا المسار فقد يُزامَن `data/chate.sqlite` سحابيًا.
- **الإصلاح:** تشفير القيم بمعامل + مفتاح من env/KMS (مع إمكانية إعادة التشفير والتدوير)، تشديد الأذونات عند الإنشاء، استثناء `data/` و`storage/` من أي مزامنة/نسخ، وتدوير المفاتيح الحالية بعد الإصلاح (الوثيقة المرجعية: `docs/audit/SECRETS-INVENTORY.md`).

### SEC-07 — الاحتفاظ/الإزالة غير منفذين (P2)
- **الدليل:** `grep RETENTION_` في `src` = 0 نتيجة؛ `.env.example:106-108` يوثّق `RETENTION_COMPARISON_DAYS=90` و`RETENTION_FILE_DAYS=30`. `phone_history` يرفض UPDATE/DELETE عبر triggers (`migrations/008_phone_audit.sql:36-46`) وهذا مقصود للتدقيق، لكن لا مسار تقادم/إخفاء هوية لأي من الجداول (لا worker في `scripts/worker.ts` يستدعيه).
- **الإصلاح:** عامل احتفاظ (worker/cron) يحذف/ينقّي comparisons/files وفق السياسة، ويستبدل بيانات الشبكة/الهاتف في `phone_history` بعد المدة (أو تشفير الأعمدة بمفتاح قابل للإتلاف = crypto-shredding)، مع توثيق المدد والموافقة.

---

## 4) نقاط تحقّقت سليمًا (بدليل)

- **لا SQLi:** كل الاستعلامات `prepare(...)` بمعاملات في `src/server/**`؛ ORDER BY من قائمة سماح (`src/server/admin/users.ts:122-127`)، LIKE مهروب (`src/domain/admin/user-query.ts:103`)، والمصنّفات في `src/server/admin/phones.ts:107-161` تستخدم قائمة سماح ومعاملات أيضًا.
- **لا IDOR/تجاوز ملكية:** `readComparison` يقيّد `id AND user_id` (`src/server/comparisons/store.ts:107,112-114`)؛ `listComparisons` يقيّد `c.user_id = ?` (`src/server/comparisons/history.ts:59`)؛ `readOwnedFileRow` يقيّد `id AND user_id` (`src/server/files/repository.ts:187`); مسار `/api/history` يأخذ userId من الجلسة فقط; مسار `/api/comparisons/[id]` يعيد 404 موحّدًا.
- **الجلسات:** HMAC-SHA256 + `timingSafeEqual` + حدود طول/exp/iat (`src/domain/auth/session.ts:38-54,99-117`)؛ فحص الإيقاف/سحب الجلسات `storedSessionAllows` (`session.ts:79-92`) داخل `verifiedSession` مع فشل مغلق (`src/server/google-session.ts:17-33`).
- **CSRF/Origin:** عمليات الإدارة تتطلب Origin مطابقًا + توكن CSRF من الجلسة (`src/domain/admin/gate.ts:35-51`) ويُطبّق في `admin/http.ts:44-49` و`api/admin/settings/route.ts:48-52`؛ `gateTurnstile` يفحص الأصل (`src/server/guard.ts:207-209`)؛ `/api/auth/logout` POST + فحص أصل؛ `/api/theme` الآن same-origin ويُصدر `Location` نسبيًا (`src/app/api/theme/route.ts:9,14-15`) — أي بند L-01 السابق مغلق.
- **Turnstile:** فحص action/hostname/TTL وشكل التوكن (`src/domain/auth/turnstile.ts:26-49`) + منع إعادة الاستخدام في القاعدة بـ SHA-256 digest خارجي (`src/server/turnstile-replay.ts:19-73`, `src/domain/auth/turnstile.ts:33-42`).
- **OTP الأساسي:** تجزئة `sha256(pepper:code)` ومقارنة زمنية ثابتة (`src/domain/auth/otp.ts:37-39,66-68`)؛ TTL 5د، 5 محاولات، 3 إرسالات/15د + 5/15د لكل رقم (`otp.ts:4-21` + `send/route.ts:100-110`)؛ استهلاك أحادي ذري (`src/server/otp/service.ts:85-91`).
- **الإدارة:** الهوية من الصف المخزّن فقط بعد مطابقة session userId/googleSub (`src/domain/admin/gate.ts:19-27`, `src/server/admin/identity.ts:8-20`)؛ منع تعديل الذات (`src/server/admin/actions.ts:15`)؛ تغيير الجوال الإداري يخزّن الرقم **غير موثّق** ويعمل داخل معاملة مع فحص الملكية (`actions.ts:121-155`) — إصلاح سليم.
- **سجل الجوال الجديد:** فحص الملكية داخل معاملة الاستهلاك يمنع حسابين من توثيق نفس الرقم (`src/app/api/otp/verify/route.ts:76-99` + `src/server/phone/audit.ts:135-147`)؛ `phone_history` بقيود CHECK وtriggers منع UPDATE/DELETE (`migrations/008_phone_audit.sql:9-46`)؛ تدقيق OTP_VERIFIED/PHONE_CHANGED/FAILED داخل نفس المعاملة.
- **لا XSS sink:** `grep dangerouslySetInnerHTML|innerHTML|eval|new Function` = نقطة واحدة في `src/app/layout.tsx:34-37,45` وهي JSON عام مهرَّب؛ لا `child_process` (فقط `db.exec` لـ PRAGMA/معاملات ثابتة).
- **حارس تسريب الهوية:** `buildAnswerPrompt` يرفض أي ظهور لاسم/بريد/جوال المستخدم في الموجه إن لم يكتبه المستخدم بنفسه (`src/domain/comparison/plan.ts:46-62`) — ضابط ممتاز ضد تسريب PII للمزودين.
- **أمان مسار التخزين:** معرّف UUID من الخادم + `insideRoot` + `isSafeStorageSegment` (`src/server/files/storage.ts:64-66,108-124,165-184`).
- **الأخطاء:** `publicError` يعيد رسالة عربية عامة لأي خطأ غير `AppError` (`src/domain/errors.ts:14-19`)، و`scrub` يشذب مفاتيح الأنماط من رسائل المزودين (`src/domain/models/dispatch.ts:289-294`).

---

## 5) ما لم يُفحص / قيود (مهم)

1. **لا اختبار حي في هذه الجلسة**: لم يُشغَّل خادم/اختبارات/typecheck/build (node_modules قيد التثبيت، وممنوع npm install/build). كل النتائج ساكنة؛ البنود المعلّمة «يحتاج تحقق» تحتاج إثباتًا عمليًا.
2. **الشجرة متغيرة أثناء الفحص** (فريق إصلاح موازٍ): ظهرت أثناء الجلسة ملفات `src/server/phone/*`، `src/server/admin/phones.ts`، `src/domain/admin/phones.ts`، `migrations/008_phone_audit.sql`، `tests/phone-*.test.ts`، وعدّلت مسار verify. أرقام الأسطر أعلاه من قراءة 2026-10-29 ~08:10؛ يُرجى إعادة التحقق قبل الترقيع.
3. **لم يُفحص**: ثغرات الحزم/`npm audit` (لم يُشغَّل)، إعداد النشر (Caddy/systemd/Docker)، TLS الفعلي، صلاحيات نظام الملفات الفعلية لقاعدة/تخزين على المضيف، النسخ الاحتياطي، Google OAuth حقيقي، Cloudflare/Turnstile حي، بوابات SMS الفعلية، `scripts/*`، ومكوّنات/تنسيقات الواجهة كاملة (فُحصت البوابات ومسارات الإدخال فقط).
4. **تدفق Google** لم يُختبر حيًا (لا ID token حقيقي)؛ تحقّقت من منطق `assertGoogleClaims` وربط nonce بالكوكي قراءةً فقط.
5. **مخاطر خارج نطاق الكود**: تعرّض الخادم دون وكيل ينظّف `X-Forwarded-*` يرفع خطورة SEC-03/SEC-13؛ وتشغيل المشروع من مسار مُزامَن سحابيًا يرفع خطورة SEC-06.

---

## 6) خطة الإصلاح المرتّبة

1. **قبل أي إطلاق عام (P1):** SEC-02 (حدود ZIP/الاستخراج + مهلة/عامل معزول) ثم SEC-01 (بوابة الجوال على الرفع + حصة تخزين). اختبارات: DOCX bomb، حصر رفع غير موثّق، تجاوز الحصة.
2. **Sprint أمني تالٍ (P2):** SEC-03 + SEC-04 معًا (TRUST_PROXY/عنوان من المقبس + حجز محاولة OTP ذري) — اختبار توازٍ وتزوير XFF؛ ثم SEC-05 (استجابة موحّدة لتعداد الأرقام) مع اختبار 409/200؛ ثم SEC-06 (تشفير الأسرار + أذونات) وSEC-12 (pepper مستقل).
3. **الخصوصية/الامتثال (P2):** SEC-07 (عامل احتفاظ + تقادم `phone_history` + توثيق) وSEC-14 (تدقيق عرض PII الإداري).
4. **تقوية دفاعية (P3):** SEC-08 (Origin لمسار verify)، SEC-09 (سقف جسم نماذج الإدارة)، SEC-10 (CSP nonce)، SEC-11 (منع طبع الرمز)، SEC-13 (معالجة رؤوس الوكيل الموحّدة).
5. **بوابة القبول:** إعادة تشغيل `npm run typecheck && npm run lint && npm test` و`npm run check:bundle` بعد اكتمال التثبيت، ومراجعة Diff بقيادة Lead، وإعادة فحص SEC-01..14 على البناء النهائي (الشجرة تغيّرت أثناء الفحص).

## 7) مراجع سريعة

- الأرشيف السابق: `docs/audit/SECURITY-AUDIT.md`، `docs/audit/THREAT-MODEL.md`، `docs/audit/SECRETS-INVENTORY.md`.
- اختبارات أمنية قائمة (لم تُشغَّل): `tests/security-*.test.ts` (authz/guard/hardening/otp/regressions/session)، `tests/phone-audit.test.ts`، `tests/phone-verification-flow.test.ts`، `tests/uploads-route.test.ts`.
