# تدقيق معماري P0 — رحلة الجوال/OTP والعملاء العالقين (ChatE)

| البند | القيمة |
| --- | --- |
| الفرع | `fix/p0-phone-otp-audit` |
| لقطة التدقيق | 2026-10-29 07:37–07:47 (+03:00) — قراءة كود فقط |
| النطاق | `src/domain/auth/*`، `src/server/{otp,phone,admin,comparisons,db}/*`، `src/app/{api/auth,api/otp,verify-phone,workspace,history,account,admin}/*`، `migrations/*`، `tests/otp*` |
| المنهج | تتبّع استدعاءات + إسناد كل نتيجة إلى ملف:سطر مقروء فعليًا |
| تنبيه حاسم | الشجرة كانت تُعدَّل بالتوازي أثناء التدقيق (12+ ملفًا ظهر/تغيّر بين 07:37 و07:47). أرقام الأسطر أعلاه لقطة 07:47 ويجب إعادة التحقق قبل الدمج |

## 1) ملخص تنفيذي

- العطل الجذري لم يكن في OTP نفسه، بل في **غياب بوابة تنقّل**: الدخول كان يثبّت `/workspace`، ولا رابط ولا بانر ولا إعادة توجيه إلى التحقق، فيبقى العميل القديم في مساحة عمل ترفض كل إرسال (403/503) بلا مسار إصلاح. أُصلح ذلك في الشجرة الجارية (F01–F03).
- أربعة مسارات مسدودة إضافية مؤكدة: لا تعديل للرقم أثناء رمز خاطئ، ولا تغيير للرقم بعد التوثيق إطلاقًا، ولا فحص ملكية الرقم لحساب آخر، ولا سجل تدقيق تاريخي (F04–F06) — بدأت تُعالَج الآن.
- الإصلاح الجاري يضيف `phone_history` بستة أحداث وappend-only، ووضعي Send (initial/change)، وبوابة `/verify-phone` وبانرًا عامًا، ولوحة عميل وسجل إدارة (migration 008، §4.1–§4.3).
- **P0 رُصد وأُصلح أثناء التدقيق:** مكوّن التحقق الجديد كان لا يرسل رمز Turnstile مع طلب send (`phone-verification.tsx:100-101` في اللقطة الأولى)؛ أُضيف الإرسال بعد الرصد (`phone-verification.tsx:100-105`) — يبقى اختبار عقد من المكوّن مطلوباً (F08).
- **P0/P1 مفتوح:** لا قيد UNIQUE على الأرقام الموثقة في قاعدة البيانات؛ الفحص تطبيقي داخل معاملة فقط، وأي كاتب آخر يتجاوزه (F09).
- **P1 مفتوح:** `/api/uploads` غير مربوط ببوابة الجوال رغم أن نصوص الواجهة تعِد بإغلاق الرفع (F10)، والـcooldown (60ث) يُعرض ولا يُفرض على الخادم، وفشل مزود SMS يستهلك محاولة إرسال (F11–F12).
- أُضيفت اختبارات جزئية أثناء التدقيق (`tests/phone-verification-flow.test.ts`، `phone-audit`، `admin-phones`، `phone-ux`)؛ تبقى فجوات: بوابة الرفع، cooldown الخادم، فشل المزود، وقيد DB الفريد — مصفوفة 18 سيناريو في §4.5 ومخاطر العقد في §4.6.

## 2) جدول Findings

| ID | الخطورة | الملف:السطر | الوصف | الأثر | الإصلاح المقترح | يحتاج اختبار |
| --- | --- | --- | --- | --- | --- | --- |
| F01 | P0 | `src/app/api/auth/google/route.ts:66-74` + `src/components/google-intent.tsx:132-136` | كان الدخول يوجّه إلى `/workspace` دائماً؛ الآن الخادم يحسب `next` إلى `/verify-phone` للمستخدم غير الموثق | كان أساس "العميل العالق" | أُصلح في الشجرة؛ يجب تثبيت العقد `data.next` في اختبار | نعم |
| F02 | P0 | `src/app/workspace/page.tsx:9-12` | كانت الصفحة تتحقق من الجلسة فقط؛ الآن `redirectUnverifiedToVerifyPhone("/workspace")` | مساحة عمل تعمل شكلياً وترفض كل إرسال | أُصلح؛ أضف اختبار صفحة يعيد 307 | نعم |
| F03 | P0 | `src/app/layout.tsx:29-31,63-68` + `src/components/verify-phone-banner.tsx:13-23` | لم يكن هناك أي رابط/بانر إلى التحقق في التنقل أو الصفحات؛ الآن بانر عام غير قابل للإخفاء | العميل لا يجد طريق الإصلاح | أُصلح؛ ثبّت الظهور/الاختفاء على `/verify-phone` | نعم |
| F04 | P0 | `src/app/api/otp/send/route.ts:75-86` + `src/app/account/page.tsx:105-110` | كان الرقم الموثّق نهائياً (send يعيد verified:true فقط)؛ الآن وضع change يسمح برقم جديد دون المساس بالقديم قبل نجاح الرمز | لا يمكن تصحيح رقم خاطئ بعد التوثيق | أُصلح؛ اختبر أن القديم يبقى موثقاً حتى النجاح | نعم |
| F05 | P0 | `src/app/api/otp/verify/route.ts:76-97` + `src/server/phone/audit.ts:135-147` | لم يكن هناك فحص أن الرقم مسجَّل لحساب آخر؛ الآن فحص داخل معاملة الكتابة | انتحال/ازدواج هوية برقم واحد | أُصلح تطبيقياً؛ ينقصه قيد DB (F09) | نعم |
| F06 | P1 | `migrations/008_phone_audit.sql:9-46` + `src/server/phone/audit.ts:74-121` | لا سجل أرقام/تدقيق سابق؛ الآن `phone_history` بستة أحداث + triggers منع UPDATE/DELETE | لا يمكن تتبّع من غيّر الرقم ومتى | أُصلح؛ يلزمه مصفوفة §4.5 | نعم |
| F07 | P1 | `src/components/phone-verification.tsx:285-297` | كان الرمز الخاطئ/الرقم الخاطئ يفرض إعادة تحميل الصفحة لتصحيح الرقم | تدفق هش وفقدان عدّاد الإرسال | أُصلح بزر "تعديل رقم الجوال" | نعم |
| F08 | P0→أُصلح | `src/components/phone-verification.tsx:100-105` | كان يصدر رمز Turnstile ثم يرسل `{ phone }` فقط بلا `cf-turnstile-response` (السطر 101 في اللقطة الأولى)؛ أُصلح أثناء التدقيق وأصبح الرمز يُرسل في نفس الطلب | كان سيعطّل كل إرسال OTP في الإنتاج (403) | أُصلح؛ أضف اختبار عقد من المكوّن لا من الخادم فقط | نعم |
| F09 | P0 | `migrations/008_phone_audit.sql:48-52` + `src/server/phone/audit.ts:135-147` | فهرسان غير فريدين فقط؛ الملكية تُفحص SELECT داخل المعاملة | سباق متعدد العمليات أو كاتب غير متعاون قد يُنتج رقماً موثقاً لحسابين | migration 009: فحص تكرار مسبق ثم `UNIQUE INDEX ... WHERE phone_verified_at IS NOT NULL` | نعم |
| F10 | P1 | `src/app/api/uploads/route.ts:77-79` | الرفع متاح لأي جلسة بلا فحص جوال، خلافاً لنص `src/app/verify-phone/page.tsx:47-49` و`src/app/account/page.tsx:101-104` | تخزين/استهلاك بلا تفعيل + وعد واجهة مخالف | استخدم `modelUseBlock` بعد قراءة الملف الشخصي (403/503) | نعم |
| F11 | P1 | `src/app/api/otp/send/route.ts:107-111,183-188` | `cooldownSeconds=60` يُعاد للعميل فقط؛ الخادم يفرض 3/15د و5/15د لكل رقم لكن لا حداً أدنى بين إرسالين | SMS bomb/تكلفة + زر "إعادة إرسال" بلا عقوبة خادم | ارفض الإرسال إذا `now-latest.createdAt < 60s` مع retryAfterSeconds | نعم |
| F12 | P1 | `src/app/api/otp/send/route.ts:133-144` | التحدي يُدرَج قبل `provider.send`؛ فشل المزود (502) يترك صفاً يُحتسب في 3/15د و5/15د | العميل يرى خطأ ثم 429 سريعاً بلا رسالة وصلت | أدرج التحدي بعد قبول المزود، أو علّم الصف failed واستثنه من العدّ | نعم |
| F13 | P2→أُصلح | `src/app/api/otp/send/route.ts:183-191` | العميل يتوقع `data.targetPhone`؛ أُضيف في الاستجابة أثناء التدقيق وأصبح المعروض E.164 | عرض رقم غير موحّد | أُصلح؛ يغطيه `tests/phone-verification-flow.test.ts:161` | نعم |
| F14 | P3 | `src/app/api/otp/verify/route.ts:79-94` | مسار PHONE_TAKEN يعيد 409 دون استهلاك التحدي؛ الاختبار الجديد يعتبر ذلك مقصوداً ليتمكن العميل من تعديل الرقم (`tests/phone-verification-flow.test.ts:239-244`) | تكرار 409 يضخّم سجل FAILED_OTP_ATTEMPT حتى حد IP | أبقِ السلوك لكن وثّق نافذة بقاء التحدي وأثره | نعم |
| F15 | P2 | `src/app/api/otp/verify/route.ts:32-35` + `src/server/guard.ts:141-146` | حد المحاولات للتحقق in-memory لكل عملية | brute-force موزّع عبر عمليات متعددة يتجاوزه؛ الحد الحقيقي هو attempts لكل تحدٍّ | وثّق القيد أو انقل العدّ إلى SQLite كما في send | نعم |
| F16 | P3 | `src/server/phone/gate.ts:27` + `src/app/layout.tsx:64` | `!state` (لا صف profiles) يُمرَّر بدل التحويل للبوابة، والبانر مخفي | حساب بلا صف profiles يبقى عالقاً بلا رابط (نادر) | عامل `state===null` كغير موثق ما لم يكن فشل قراءة | نعم |
| F17 | P3 | `src/app/history/page.tsx:46-48` × `src/app/history/[id]/page.tsx:16-18` | القائمة محمية بالجوال، وصفحة التفاصيل غير محمية | سياسة غير متسقة؛ بيانات قديمة تُعرض بلا تفعيل | قرّر السياسة وطبّقها في الموضعين | نعم |
| F18 | P2 | `migrations/008_phone_audit.sql:24-26,36-46` | IP/UA مخزّنان بلا احتفاظ/تمويه، وtrigger يمنع DELETE فيتعارض مع حذف الحساب مستقبلاً | مخاطر خصوصية/امتثال عند تنفيذ حذف الحساب | سياسة احتفاظ/redaction موثقة + تحديث الخصوصية | مراجعة |
| F19 | P2 | `tests/phone-verification-flow.test.ts:155-267`، `tests/phone-audit.test.ts:66-234`، `tests/admin-phones.test.ts:133-206`، `tests/phone-ux.test.ts:10-141` | أُضيفت اختبارات جزئية أثناء التدقيق (activation/change، audit/backfill، admin، wiring) | لا تغطية بعد لبوابة الرفع/cooldown الخادم/فشل المزود/سباق DB | أكمل §4.5 خصوصاً A10 وA18 | نعم |
| F20 | P3 | `migrations/008_phone_audit.sql:56-93` | backfill يستخدم `hex(randomblob)` لا UUID، ويزيل التكرار بمطابقة `created_at` النصية | معرفات غير متسقة؛ تكرار محتمل عند فروق تنسيق | استخدم صيغة UUID موحدة ومفتاحاً أصلياً منطقياً | نعم |
| F21 | P3 | `src/server/db/accounts.ts:41-51` + `src/app/api/auth/google/route.ts:76-85` | لا كاتب لجدول `sessions` (تسجيل الدخول يوقّع كوكي فقط) | جدول/فهرس ميت؛ مراجعة نموذج الجلسات لاحقاً | خارج نطاق P0 — توثيق أو إزالة | لا |

## 3) تفاصيل أهم النتائج

### 3.1 سلسلة "العميل العالق" قبل الإصلاح (F01–F03)
الدخول كان يثبّت الوجهة `router.push("/workspace")` (السطر 133 قبل التعديل)، و`src/app/page.tsx:12` يعيد المستخدم المسجَّل إلى `/workspace`، وصفحة workspace كانت تفحص الجلسة فقط (5–9 قبل التعديل)، والتنقل في layout لا يحتوي أي رابط تحقق. النتيجة: مستخدم قديم بلا رقم يرى مساحة العمل كاملة، وعند الإرسال يحصل على 403 `profile_incomplete` أو 503 `OTP_UNCONFIGURED` (`src/server/comparisons/handle.ts:34-37`, `src/domain/auth/model-gate.ts:49-60`) بلا أي طريق إلى `/profile/complete` (لم يكن مرجع لأي صفحة تحقق في `src` وقت اللقطة الأولى). الإصلاح الجاري يغلق السلسلة في أربع نقاط: الخادم يقرر `next`، بوابة صفحات، بانر عام، ولوحة حساب.

### 3.2 Turnstile (F08) — انحدار رُصد وأُصلح أثناء التدقيق
في اللقطة الأولى كان `requestCode` يصدر الرمز ثم يرسل `{ phone }` فقط (`phone-verification.tsx:100-101`)، فيرفض الخادم الطلب missing 403 (`send/route.ts:79` + `domain/auth/turnstile.ts:117-120`)؛ أي أن أي إنتاج مُهيّأ بـTurnstile كان سيفقد مسار التفعيل بالكامل. أُصلح في الشجرة فور الرصد وأصبح الإرسال يحمل `"cf-turnstile-response": token` (`phone-verification.tsx:100-105`). النموذج القديم `otp-request.tsx:44` كان يرسل الرمز فعلاً، فهو انحدار إعادة كتابة؛ يلزم اختبار عقد من المكوّن لمنع التكرار.

### 3.3 منع تكرار الرقم (F09)
السلوك الحالي: `findVerifiedPhoneOwner` داخل `immediateTransaction` عند verify (`verify/route.ts:76-97`) و`BEGIN IMMEDIATE` يسلّس الكتّاب (`db/transaction.ts:6-19`)، لذا سباق المسارين لن ينجح — **بشرط** أن يبقى كل كاتب داخل نفس المعاملة. ما ينقص:
1. قيد DB يمنع أي كاتب آخر (سكربت/استعلام إداري/مسار مستقبلي).
2. قرار للمالك: هل الأرقام **غير الموثقة** يجوز تكرارها؟ المقترح: الملكية الفريدة للأرقام الموثقة فقط، مع السماح برقم pending لأكثر من حساب.
3. معالجة البيانات القائمة: قبل إنشاء الفهرس الفريد، فحص `SELECT phone_e164, COUNT(*) FROM profiles WHERE phone_verified_at IS NOT NULL GROUP BY phone_e164 HAVING COUNT(*)>1`، ثم قرار يدوي/أتمتة (إبقاء الأقدم + تسجيل حدث `PHONE_CHANGED_BY_ADMIN` أو حدث نظامي) — لا يمكن اكتشاف حجم التكرار لأن قاعدة بيانات الإنتاج غير موجودة في المستودع.

### 3.4 الحدود والتكلفة (F11–F12)
الأرقام الحالية: 3 إرسالات/15د للمستخدم، 5/15د لكل رقم عبر الحسابات (`domain/auth/otp.ts:4-21`)، 5 محاولات إدخال، TTL 5د. الخادم لا يفرض الـ60 ثانية المعلنة، وفشل المزود لا يُعاد منه الإرسال. كما أن `retryAfterSeconds` عند 429 يُحسب من آخر تحدٍّ للمستخدم (`send/route.ts:107-111`) وقد يكون غير دقيق إذا كان السبب هو حدّ الرقم المشترك — يُفضّل حساب أقصى (المستخدم/الرقم).

### 3.5 السباق داخل verify وتدفق change
الترتيب الحالي سليم: فحص الملكية → consume شرطي → `setVerifiedPhone` → أحداث `OTP_VERIFIED` و`PHONE_CHANGED_BY_USER` داخل نفس المعاملة. إذا كان الرقم مأخوذاً يعيد 409. في وضع change يُرسل الرمز إلى الرقم الجديد، و`profiles` يظل على القديم الموثق حتى النجاح (`verify/route.ts:100-129`). هذا يحقق شرط "لا استبدال قبل التحقق".

### 3.6 بيانات phone_history وأثر الـbackfill
migration 008 يحوّل كل `otp_challenges` و`profiles.phone_e164` القائمة إلى أحداث، ويعمل داخل معاملة المهاجر (`db/migrate.ts:16-20`). على قاعدة كبيرة قد يطيل قفل الكتابة عند أول تشغيل؛ يفضّل سكربت backfill دفعي منفصل أو تبرير الحجم إن كان صغيراً (غير معروف هنا).

### 3.7 الأحداث الستة — تغطية الكود الحالي
`INITIAL_ENTRY` و`OTP_SENT` (`send/route.ts:148-182`)، `OTP_VERIFIED` و`PHONE_CHANGED_BY_USER` (`verify/route.ts:100-129`)، `PHONE_CHANGED_BY_ADMIN` (`server/admin/actions.ts:142-152,171-181`)، `FAILED_OTP_ATTEMPT` (`verify/route.ts:68,142-165`). التعريفات عربية مشتركة في `domain/auth/phone-history.ts:10-36`.

## 4) التصميم المقترح (لا يُنفَّذ في هذا التقرير)

### 4.1 جدول phone_history
- الأعمدة: `id`, `user_id` (بلا FK), `old_phone`, `new_phone NOT NULL`, `action CHECK (6 قيم)`, `phone_verified 0/1`, `actor_type (user/admin/system)`, `actor_user_id`, `ip`, `user_agent`, `metadata json_valid`, `created_at` (migration 008:9-29).
- **بلا FK CASCADE** عمداً: الجدول سجل دائم يجب أن يبقى بعد حذف الحساب/المستخدم؛ CASCADE يمحو الدليل، وON DELETE SET NULL يفقده هوية الفاعل. يُقبل أن `user_id` يشير إلى صف محذوف ويُفسَّر بسجل admin.
- triggers `BEFORE UPDATE/DELETE` → `RAISE(ABORT,'PHONE_HISTORY_APPEND_ONLY')` (008:36-46)، وكل الكتابة عبر `recordPhoneAudit` فقط (audit.ts:74-104).
- فهارس: `(user_id, created_at)`, `(new_phone, created_at)`, `(action, created_at)`, `(created_at)` (008:31-34) + فهارس profiles وotp (008:48-52).
- **إضافة إلزامية**: migration 009 للفهرس الفريد الجزئي على `profiles(phone_e164)` للأرقام الموثقة بعد preflight، وسياسة احتفاظ/تمويه للأعمدة `ip`/`user_agent`.

### 4.2 عقود API
- `POST /api/otp/send` — body: `{ phone?: string, "cf-turnstile-response"?: string }`؛ سلوك: بلا phone + موثق → `{sent:false,verified:true}` بلا Turnstile؛ غير موثق → رقم + Turnstile → `{sent:true,expiresInSeconds,cooldownSeconds,change:false,targetPhone}`؛ موثق + رقم مختلف → نفس الشكل مع `change:true`؛ نفس الرقم → `{sent:false,verified:true}`. أخطاء: 401 `anonymous`/`account_missing`، 403 Turnstile، 422 `OTP_PHONE`، 409 `PHONE_TAKEN`، 429 `OTP_RESEND` + `retryAfterSeconds`/`retry-after`، 502 `OTP_PROVIDER`، 503 `OTP_FAIL_CLOSED`.
- `POST /api/otp/verify` — body `{ code: string }`؛ 200 `{verified:true}` (أول مرة) أو `{verified:true,changed:true}` (تغيير)؛ أخطاء: 422 `OTP_CODE`، 403 `OTP_MISSING`/`OTP_MISMATCH`+`remainingAttempts`/`OTP_EXPIRED`، 429 `OTP_ATTEMPTS` أو حد IP، 409 `PHONE_TAKEN`.
- إدارة: `POST /api/admin/users` form `action=phone|unverify` مع `csrf` و`userId` و`returnTo=phones` (command.ts:14-25,49-53؛ actions.ts:121-184؛ http.ts:44-57). يلزم: فحص مالك الرقم، إلغاء التوثيق، `PHONE_CHANGED_BY_ADMIN` + `admin_audit_events`، وإعادة توجيه notice.
- حدود: send 3/15د/مستخدم و5/15د/رقم و(cooldown 60ث مقترح)، verify 5 محاولات/تحدٍّ + حد IP، رفع/مقارنة بعد التفعيل.

### 4.3 سياسة بوابة الصفحات
- المحميّة: `/workspace` و`/history` (والأفضل `/history/[id]`) → `redirectUnverifiedToVerifyPhone(nextPath)` (gate.ts:18-29) و307 إلى `/verify-phone?next=...`.
- غير المحمية: `/verify-phone` نفسها (منع الحلقة)، `/account` (سطح التفعيل/التغيير)، الصفحات العامة، و`/admin/**` (بوابة المشرف فقط).
- وجهة العودة: `safeNextPath` يرفض المطلق و`//` والشرطة العكسية ومحارف التحكم ويقبل مساراً داخلياً ≤512 حرفاً (phone-history.ts:69-91)؛ `next` يُرمّز في الرابط ويُعاد التحقق منه في الصفحة (verify-phone/page.tsx:32-42).
- فشل مخزن القراءة: لا تحويل (تفادي حلقة) ويبقى خطأ API عربياً؛ الموصى به إضافة: `state===null` مع جلسة سليمة = تحويل بدل تمرير (F16).

### 4.4 منع تكرار الرقم — خوارزمية race-safe
1. فحص مبكر بلا معاملة في send لإرجاع 409 ودّي قبل إرسال SMS.
2. عند verify داخل `BEGIN IMMEDIATE`: `findVerifiedPhoneOwner` مرة أخرى → إن وُجد: 409 + استهلاك التحدي (F14)؛ وإلا `consumeChallenge` شرطي ثم `setVerifiedPhone` ثم الأحداث.
3. إنشاء فهرس فريد جزئي في DB ليصبح القيد نهائياً (يفشل upsert المكرر حتى لو تجاوز كاتب الفحص).
4. نفس القاعدة للمشرف: `setPhone` يفحص الملكية ويعيد فشلاً صامتاً → notice "مرفوض" (admin-phones.tsx:189-222).
5. سياسة معروفة: الرقم الموثّق ملك حساب واحد؛ الأرقام pending قد تتكرر والتحقق يفصل بينها.

### 4.5 مصفوفة اختبار قبول
| # | السيناريو | المتوقع |
| --- | --- | --- |
| A01 | عميل قديم عالق (جلسة سارية، لا رقم) يفتح /workspace | 307 إلى /verify-phone?next=/workspace؛ بانر ظاهر؛ لا 403 صامت |
| A02 | عميل جديد: دخول Google | استجابة auth تحمل `next=/verify-phone?...`؛ ثم OTP ناجح → /workspace وإرسال مقارنة 200 |
| A03 | رقم أجنبي/صيغة خاطئة | 422 OTP_PHONE برسالة موحدة؛ صفر SMS |
| A04 | رقم خاطئ أثناء OTP ثم "تعديل رقم الجوال" وإرسال صحيح | 200؛ تحدٍّ جديد واحد؛ لا إعادة تحميل |
| A05 | إعادة إرسال فورية | 429 + retryAfterSeconds؛ الزر معطّل بعدّاد تنازلي |
| A06 | إرسال رابع خلال 15د | 429 OTP_RESEND بلا SMS |
| A07 | 6 حسابات تستهدف نفس الرقم خلال 15د | 429 عند تجاوز 5 إرسالات للرقم |
| A08 | تغيير الرقم بعد التوثيق | SMS للجديد فقط؛ القديم يبقى موثقاً حتى النجاح؛ ثم PHONE_CHANGED_BY_USER + OTP_VERIFIED |
| A09 | رقم موثّق لحساب آخر (send) | 409 PHONE_TAKEN؛ صفر SMS |
| A10 | سباق توثيق نفس الرقم من حسابين | واحد 200 والآخر 409؛ صف موثق واحد؛ الاختبار على طبقة التخزين أيضاً |
| A11 | 5 محاولات خاطئة | 429 OTP_ATTEMPTS؛ حتى الرمز الصحيح 429؛ FAILED_OTP_ATTEMPT مسجل |
| A12 | مشرف يعيّن رقماً | PHONE_CHANGED_BY_ADMIN + admin_audit_events؛ إلغاء التوثيق؛ الدخول التالي للبوابة |
| A13 | مشرف يلغي التوثيق | PHONE_CHANGED_BY_ADMIN (source=admin_unverify)؛ العميل للبوابة |
| A14 | سجل العميل /account | 20 حدثاً newest-first بأسماء عربية؛ موبايل |
| A15 | سجل الإدارة /admin/phones | فلاتر status=unverified وevent وuserId؛ عدادات صحيحة |
| A16 | الأحداث الستة | كل حدث يُكتب مرة على الأقل في سيناريوهاته الستة |
| A17 | Append-only | UPDATE/DELETE على phone_history → RAISE ABORT |
| A18 | توافق خلفي + Turnstile + uploads + cooldown | F08/F10/F11 مغلقة: token يُرسل، upload غير الموثق 403، الإرسال الثاني خلال 60ث 429، وtests/otp-route + otp-flow تمر دون تعديل |

### 4.6 مخاطر التوافق الخلفي وما يجب الحفاظ عليه
- `tests/otp-route.test.ts:242-265` يثبت استجابة verify الأولى بـ`toEqual({ok:true,data:{verified:true},error:null})` — أي حقل إضافي في هذه الحالة يكسر الاختبار؛ أبقِ `changed` للحالة المتغيرة فقط.
- `send` no-op للموثق بلا رقم يجب أن يبقى 200 `{sent:false,verified:true}` بلا Turnstile (`send/route.ts:76-77`) — يغطيه `tests/otp-route.test.ts:218-225`.
- رمز وسلوك 429: `OTP_RESEND` مع رسالة عربية (otp-route:186-196) و`OTP_ATTEMPTS` (otp-route:267-289) يجب ألا تتغير.
- `setVerifiedPhone`/`hasVerifiedPhone`/ترتيب `latestChallenge` و`countRecentSends` تُغطى في `tests/otp-flow.test.ts:143-235`؛ الإضافة `countRecentSendsToPhone` فقط، دون تغيير الدلالات القائمة.
- المهاجر تُنفَّذ قبل زرع المستخدمين في الاختبارات (`db/migrate.ts:12-22`) لذا backfill 008 لا يمس بيانات الاختبار؛ لا تُغيّر ترتيب/معاملة الهجرة.
- استخدام `immediateTransaction` ممنوع التداخل (`transaction.ts:10`)؛ أي مسار جديد يستدعيها داخل مسار قائم يفشل.
- `/profile/complete` صار alias 307 إلى `/verify-phone` (`src/app/profile/complete/page.tsx:8-10`)؛ سكربتات QA تقيس 307 فقط (`scripts/qa/run-e2e.mjs:532-540`, `scripts/qa/verify-release.mjs:1164-1166`) فتبقى ناجحة، لكن README.md:116 وما تزال تذكر المسار القديم ويجب تحديثه.
- حد verify in-memory: `tests/otp-route.test.ts` يستدعي verify نحو 12 مرة دون `resetRateLimits()` وسعة الكائن 20 (`src/server/guard.ts:120-131`) — هامش ضيق؛ أي اختبارات إضافية على نفس الملف يجب أن تستدعي `resetRateLimits` في beforeEach.
- تغيير بوابة الرفع سلوك جديد على جلسات غير موثقة؛ تأكد أن سكربتات QA الحالية التي ترفع كعميل غير موثق (`scripts/qa/run-e2e.mjs:1059`) لا تتوقع 200.
- `docs/launch/LEGAL-REVIEW.md:51` يسجل نقص إفصاح الخصوصية عن الجوال ومزود SMS؛ إضافة phone_history تزيد الحاجة لتحديث ملف الخصوصية.

## 5) خطة إصلاح مرتبة
1. **P0/F08 (تم أثناء التدقيق)** — تحقق من إرسال Turnstile في `phone-verification.tsx:100-105` وأضف اختبار عقد من المكوّن؛ لا تُغلق البند دونه.
2. **P0/F09** — migration 009: preflight تكرار + فهرس فريد جزئي؛ اختبار سباق على التخزين.
3. **P0/F10** — اربط `/api/uploads` ببوابة الجوال وأضف اختبار 403 لغير الموثق.
4. **P1/F12** — لا تستهلك حد الإرسال عند فشل المزود (إدراج بعد القبول أو تعليم failed).
5. **P1/F11** — فرض cooldown 60ث خادمياً + retryAfterSeconds دقيق (max للمستخدم/الرقم).
6. **P1/اختبارات** — نفّذ A01–A18 على مستوى route + طبقة التخزين، مع `resetRateLimits` حيث يلزم.
7. **P2/F13–F14** — أعد targetPhone واستهلك التحدي عند PHONE_TAKEN.
8. **P2/F18** — سياسة احتفاظ/تمويه IP/UA + خطة حذف حساب متوافقة مع append-only.
9. **P2/F16–F17** — وحّد سياسة البوابة (state=null، history detail) ووثّقها.
10. **P3/F20–F21** — اتساق معرفات backfill، وتوثيق/تنظيف جدول sessions الميت.
11. **بوابة الدمج** — `npm test` + `npm run typecheck` + `npm run lint` + `npm run build` + E2E staging بـTurnstile وSMS حقيقيين، وترحيل 008/009 على نسخة من قاعدة الإنتاج مع تقرير تكرار الأرقام.

## 6) ما لم يُفحص / قيود
- **لم أشغّل** `npm test` ولا `typecheck` ولا `lint` ولا `build` (تعليمات المهمة تمنع التثبيت/البناء، وكانت الشجرة تُعدَّل بالتوازي). كل نتائج "أُصلح" أعلاه مبنية على قراءة الكود فقط، وليست نتيجة اختبار.
- **لا قاعدة بيانات إنتاج/ملف SQLite في المستودع** (تحقق بـglob) → حجم duplicates وأثر backfill غير معروفين؛ يلزم فحص ما قبل migration 009.
- **لا تحقق متصفح/E2E** ولا مزود Turnstile/SMS حي؛ لا تحقق من أن أزرار الإدارة تعمل فعلياً عبر form POST.
- الشجرة متزامنة: أرقام أسطر بعض الملفات قد تتغير بعد 07:47، وبعض البنود أُصلح فعلاً أثناء التدقيق (F08، F13، اختبارات F19) كما هو مثبت أعلاه؛ هذا التقرير لقطة وليست حكماً نهائياً على الشجرة النهائية.
- لم يُفحص أثر التغييرات على CSS/الواجهة بصرياً ولا على حزمة العميل (`scripts/check-client-bundle.ts`) ولا على docs/README عدا ما ذُكر.
- لم تُنفَّذ أي عملية git (محظورة)، ولم تُفحص فروق الشجرة مقابل HEAD.
