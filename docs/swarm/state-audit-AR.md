# تدقيق آلة الحالات والمسارات المسدودة — ChatE

- **الفرع:** `fix/p0-phone-otp-audit` — الشجرة تحتوي إصلاح P0 الجاري (غير مُودَع).
- **لقطة التدقيق:** 2026-10-29 **07:52 +03:00**. الملفات كانت تُعدَّل أثناء التدقيق (07:38→07:50)؛ أُعيد قراءة كل ملف تغيّر، وأُدرج ما أُغلق، ولم يُفحص أي تعديل بعد هذه اللقطة.
- **المنهج:** قراءة ثابتة (static) للملفات + تتبّع كل انتقال حالة. **لم يُشغَّل** build/tsc/lint/vitest ولا قاعدة بيانات (قيود المشرف + node_modules قيد التثبيت).
- **النطاق:** الحساب/الجلسة/الجوال/OTP/بوابات الصفحات — وما يرتبط بها من حالات comparisons/model_runs/jobs/extraction_jobs/files/quota. الأمن والأداء وتجربة الواجهة التفصيلية لأسطول آخر.
- المخرج حسب تعليمات المشرف المباشرة: `docs/swarm/state-audit-AR.md` (لوحة الفريق تذكر اسمًا آخر `state-machine-audit-AR.md`؛ نفس المحتوى).

## 1) ملخص تنفيذي (7 أسطر)

1. إصلاح P0 الجاري **أغلق المسارات المسدودة الأساسية**: بوابة `/verify-phone` كانونية + alias، بانر دائم، توجيه من `/workspace` و`/history`، `next` يحدده الخادم بعد دخول Google، رفض صريح للحساب المعلّق، احتساب انتهاء الإيقاف المؤقت، وإرسال رمز Turnstile من عميل التفعيل.
2. **لا يوجد P0 مفتوح في هذه اللقطة.** أُغلق أثناء التدقيق: 3 P0 (حلقة التعليق F5، قفل الإيقاف المؤقت F6، إسقاط رمز Turnstile F7) + P1 الرفع (F11) + P2 حصة الإرسال عند فشل المزود (F12) + تحصين DB (F13).
3. بقي **3 P1** تتحول إلى قفل عند نقص تهيئة النشر: Turnstile غير المهيأ يعطي «أعد المحاولة» مضللة (S2)، اختيار مزود SMS غير متاح من واجهة الإدارة (S3)، وفشل كل النماذج يُعرض كـ«نجاح بلا نتائج» (S4).
4. بقي **8 ملاحظات P2**: حلقة `next=/verify-phone`، تعارض تعريف «موثّق»، `/history/[id]` غير مبوَّب، حالة الحساب في /admin/phones «غير معروف»، `closed` إنجليزية، 401 منتصف الصفحة بلا CTA، 429 الحصة/التزامن بلا تفاصيل، وفقدان سبب رفض إجراءات المشرف. + **4 P3**.
5. «حالات الانتظار» في المقارنات **لها إصلاح ذاتي**: `reconcileStaleComparison` ينهي أي مقارنة عالقة بعد `MODEL_TIMEOUT_MS + 30s` ويحرّر الحجز والـslot؛ لا قفل أبدي في `comparisons/model_runs/jobs`.
6. `extraction_jobs.status` و`files.status` أحاديان (لا حالات معلّقة)؛ لا طريق مسدود فيهما، لكن لا حذف/إلغاء ملفات من الواجهة.
7. الاختبارات المضافة تغطي **الخادم** والبوابات، لكنها **لا تغطي** عيب عميل Turnstile (F7) ولا حذف التحدي عند فشل المزود (F12) — يحتاجان اختبارًا وإلا يعود العيب بصمت.

## 2) ما أُغلق/تحصّن أثناء التدقيق (تحقّق ثابت، بلا تشغيل)

| # | البند | الدليل بعد الإصلاح | ملاحظة |
|---|---|---|---|
| F1 | مسار تفعيل كانوني + alias | `src/app/verify-phone/page.tsx:29-41`، `src/app/profile/complete/page.tsx:8-9` | موجود وموصول |
| F2 | توجيه غير الموثّق من المنتج | `src/app/workspace/page.tsx:12`، `src/app/history/page.tsx:48` | ✅ |
| F3 | بانر دائم غير قابل للإغلاق | `src/app/layout.tsx:75-79`، `src/components/verify-phone-banner.tsx:13-23` | ✅ |
| F4 | الدخول بGoogle → بوابة مباشرة | `src/app/api/auth/google/route.ts:81-89` + `src/components/google-intent.tsx:132-136` | الخادم يقرر `next` |
| F5 | المُعلَّق: 403 صريح بدل حلقة | `src/app/api/auth/google/route.ts:68-80` | «حسابك موقوف. تواصل مع الدعم…» |
| F6 | الإيقاف المؤقت المنتهي لا يقفل | `src/server/db/profiles.ts:24-40` (CASE على suspended_until) | يُصلح أيضًا وسم «حالة الحساب» في /account |
| F7 | رمز Turnstile يُرسل من عميل التفعيل | `src/components/phone-verification.tsx:100-104` | أُغلق 07:47:41؛ **بلا اختبار عميل** |
| F8 | تنقّل: حسابي + تسجيل الخروج | `src/app/layout.tsx:56-71` + `src/app/api/auth/logout/route.ts:16` | ✅ |
| F9 | سجل جوال دائم + قائمة العملاء العالقين | `migrations/008_phone_audit.sql:9-50`، `src/server/admin/phones.ts`، `src/app/admin/phones/page.tsx` | append-only ب trigger |
| F10 | فحص ملكية الرقم ومنع الاستيلاء | `src/server/phone/audit.ts:135-147` + `src/app/api/otp/verify/route.ts:79-99` | داخل معاملة واحدة |
| F11 | بوابة الجوال على الرفع | `src/app/api/uploads/route.ts:83-96` (`modelUseBlock` قبل قراءة البايتات) | أُغلق 07:48:46 + اختبار `tests/phone-gate-enforcement.test.ts:75-97` |
| F12 | فشل مزود SMS لا يستهلك الإرسال | `src/app/api/otp/send/route.ts:149-162` (حذف التحدي عند فشل `provider.send`) | أُغلق 07:48:46؛ **لا اختبار مباشر** |
| F13 | تحصين تفرّد الرقم الموثّق + فهارس | `migrations/009_phone_guards_and_indexes.sql:14-50` | triggers دفاعية + view `admin_phone_duplicates` (غير مستخدمة بعد) |

## 3) جدول النتائج المفتوحة

| ID | الخطورة | الملف:السطر | الوصف / السيناريو | الأثر | الإصلاح المقترح الدقيق | يحتاج اختبارًا؟ |
|---|---|---|---|---|---|---|
| S2 | **P1** | `src/domain/auth/turnstile.ts:104-116`، `src/domain/admin/dashboard.ts:100`، `src/components/google-intent.tsx:9,111-117` | نقص `TURNSTILE_SECRET_KEY` أو `TURNSTILE_EXPECTED_HOSTNAMES` يجعل الدخول/المقارنة/الرفع/OTP ترجع 503/403؛ العميل يرى «تعذر التحقق الأمني. أعد المحاولة» للأبد، ولوحة الإدارة تعتبر Turnstile «مهيأ» بمجرد وجود السر | قفل شامل بأثر رجعي لا يصلحه العميل + تشخيص إداري خاطئ؛ وبوابة إعداد ذاتية (إعدادات DB تحتاج دخولًا يحتاج Turnstile) | (أ) `serviceConfigured("turnstile")` يتطلب أيضًا `EXPECTED_HOSTNAMES`؛ (ب) رسالة تشغيلية «التحقق الأمني غير مهيأ على الخادم — تواصل مع الإدارة» بدل «أعد المحاولة»؛ (ج) بند bootstrap في `docs/launch/DEPLOYMENT-RUNBOOK.md` | نعم |
| S3 | **P1** | `src/domain/admin/settings.ts:7-19` (لا يحتوي `SMS_PROVIDER`)، `src/domain/auth/model-gate.ts:21-46`، `src/app/verify-phone/page.tsx:51-57` | المشرف يحفظ `SMS_API_KEY/SECRET/SENDER_ID` من /admin/settings فتبقى البوابة مقفلة لأن اختيار المزود env-only؛ العميل العالق يرى «تواصل مع الدعم» بلا أي قناة دعم في التطبيق | حساب جديد مقفل نهائيًا حتى يتدخل المشغّل من الـenv — بلا مسار واضح | إضافة `SMS_PROVIDER` إلى `SETTING_KEYS` أو توضيح أنه env-only في شاشة الإدارة + رابط/بريد دعم فعلي في البانر وصفحة التفعيل | نعم |
| S4 | **P1** | `src/domain/comparison/view.ts:54-58`، `src/components/workspace.tsx:322-325,723-738`، `src/domain/models/dispatch.ts:61,76` | غياب `OPENROUTER_API_KEY` أو تعطّل المزود: كل `model_runs` تفشل برسالة عربية مفيدة، لكن الشبكة تخفي الفاشلة وتُظهر «لم تُرجع النماذج المختارة إجابة ناجحة بعد» + notice نوع success | العميل ينتظر ثم يرى نتيجة فارغة بلا سبب أو مسار؛ لا يعرف أن الخلل في الخادم | إن `successful==0 && runs.length>0` اعرض بطاقة خطأ مجمّعة بها `run.message` وkind=`error`؛ واعرض النماذج «مقيدة» عند غياب المفتاح في `toPublicModel` (`catalog.ts:288-306`) | نعم |
| S5 | **P2** | `src/domain/auth/phone-history.ts:70-84`، `src/app/verify-phone/page.tsx:33,41` | `next=/verify-phone` (رابط خارجي/إشارة قديمة): بعد نجاح التوثيق تُعيد الصفحة التوجيه إلى نفسها → ERR_TOO_MANY_REDIRECTS | صفحة خطأ متصفح بعد توثيق ناجح؛ لا عودة إلا التنقّل اليدوي | استبعاد `VERIFY_PHONE_PATH` (و`/profile/complete`) في `safeNextPath` أو قبل `redirect(nextPath)` | نعم |
| S6 | **P2** | `src/server/phone/gate.ts:27`، `src/app/layout.tsx:58,75` مقابل `src/app/verify-phone/page.tsx:41` و`src/domain/auth/model-gate.ts:53-58` و`src/domain/auth/profile.ts:36` | تعريف «موثّق» غير موحّد: البوابة/البانر يفحصان `phoneVerifiedAt` فقط، `profileGate/isPhoneVerified` يشترطان الرقم+التاريخ؛ صفّ شاذ (verified_at بلا phone) يفتح workspace ويخفي البانر ثم يرفض الإرسال 403 دائمًا | قفل بلا مخرج (حالة نادرة) | تعريف واحد `isPhoneVerified` في الأربعة + ترحيل فحص/تصحيح للصفوف الشاذة | نعم |
| S7 | **P2** | `src/app/history/[id]/page.tsx:18-29` و`src/app/api/history/route.ts:26-28` مقابل `src/app/history/page.tsx:48` | تفاصيل المقارنة وAPI السجل لا تمرّان بوابة الجوال بينما صفحة السجل تُوجّه | «شاشة لا توجّهه»: عميل غير موثّق يفتح رابط تفاصيله القديم — تناقض نطاق البوابة | أضف `redirectUnverifiedToVerifyPhone("/history/"+id)`؛ ووثّق قرار `/api/history` (مبوَّب أم استثناء مقصود) | نعم |
| S8 | **P2** | `src/server/admin/phones.ts:104,194`، `src/components/admin-phones.tsx:111`، `src/domain/admin/dashboard.ts:151-156` | الصفحة تقرأ `users.status` الخام وتُمرّره إلى `accountStatusLabel` الذي يعرف active/temporary/indefinite فقط → أي حساب معلّق يظهر «غير معروف» | يعمّي المشغّل عن سبب شكوى العميل (خصوصًا بعد F6) | CASE مشتق مثل `src/server/admin/users.ts:69-74` أو إرجاع `suspended_until` وحساب التسمية | نعم |
| S9 | **P2** | `src/server/comparisons/execute.ts:103`، `src/domain/comparison/view.ts:28-42`، `src/app/history/page.tsx:92`، `src/app/history/[id]/page.tsx:59` | المقارنة المنتهية تُخزَّن `status="closed"` وهذا المفتاح غير موجود في `STATUS_TEXT` | سجل العميل يعرض الكلمة الإنجليزية «closed» | إضافة `closed: "مكتمل"` (أو توحيد الحالة النهائية إلى completed) | نعم (سطر واحد) |
| S11 | **P2** | `src/components/workspace.tsx:502-504,562-567`، `src/domain/workspace-start.ts:35-41` | انتهاء الجلسة أثناء التاب: الإرسال/الرفع يرجع 401 وتُعرض رسالة نصية فقط بلا إعادة توجيه أو زر دخول | العميل يعيد المحاولة على صفحة ميتة | عند 401 في `protectedPost/chooseFiles`: `window.location.assign("/")` أو CTA دخول ظاهر | اختياري |
| S12 | **P2** | `src/server/comparisons/store.ts:528,531`، `src/server/comparisons/handle.ts:85` | 429 للحصة (`quota`) وللتزامن (`concurrency`) برسالة قصيرة؛ لا «المتبقي»، لا retryAfter، لا «اطلب زيادة من المالك»، والحالتان تُعادان دائمًا 429 | العميل لا يعرف إن كان الانتظار يكفي أم يحتاج تدخل المشرف | مرّر `retryAfterSeconds`/المتبقي في details واعرضهما؛ أضف مسار (المالك/الدعم) عند quota | نعم |
| S13 | **P2** | `src/server/admin/http.ts:52-57`، `src/domain/admin/dashboard.ts:23-26`، `src/server/admin/actions.ts:131-133`، `src/domain/admin/command.ts:49-53` | كل فشل إجراء إداري (رقم مأخوذ/صيغة خاطئة/إجراء على النفس) → notice واحد «تعذر تنفيذ الإجراء.» بلا سبب | المشرف لا يعرف كيف يصلح الحالة — طريق مسدود تشغيلي | أعِد رموزًا (`PHONE_TAKEN/PHONE_FORMAT/SELF`) واربطها بـ NOTICES في /admin/phones | نعم |
| S14 | **P3** | `src/app/history/page.tsx:48` | التوجيه يمرر `/history` فقط فيضيع `?before=` (cursor صفحات) | العميل يعود لأول صفحة بدل مكانه | مرّر `safeNextPath` مع الـquery | لا |
| S15 | **P3** | `src/server/phone/gate.ts:20-26`، `src/app/verify-phone/page.tsx:34-40`، `src/app/layout.tsx:75` | فشل قراءة الحالة يُعامَل كـ«غير معروف»: الصفحة تُعرض، البانر يختفي، ثم تفشل API برسالة store | فشل صامت جزئي (fail-closed على API فقط) | رسالة تشغيلية ثابتة عند فشل القراءة بدل العدم | لا |
| S16 | **P3** | `migrations/002_admin.sql:7-8,103-108`، `src/server/db/jobs.ts`، `migrations/009_phone_guards_and_indexes.sql:14-19` | أعمدة `cancelled_at/cancel_requested_at` وجدول `service_controls` وview `admin_phone_duplicates` بلا قارئ/كاتب | ملاحظة اكتمال حالة لا قفل (reconcile ينهي العالق) | إمّا ربطها (شاشة تكرارات) أو حذفها (أسطول deadcode) | لا |
| S17 | **P3** | `src/server/db/quota.ts:111-118` | أول حجز يثبّت `limit_units`؛ تغيير `USER_QUOTA_UNITS` بيئيًا لاحقًا لا يغيّر الحسابات القائمة إلا بإجراء المشرف | انحراف تهيئة صامت (لا قفل) | وثّق ذلك في runbook أو أعد المزامنة عند تغيّر env | لا |

## 4) تفاصيل أهم النتائج (أدلة نصية)

**S2 — Turnstile غير المهيأ:** `assertTurnstileConfig` يرفع 503 عند غياب السر (turnstile.ts:20)، و`verifyTurnstileRequest` يرجع `TURNSTILE_HOSTS` 503 إذا كانت قائمة النطاقات فارغة (turnstile.ts:114-116)، وتصل عبر `gateTurnstile` إلى login/otp/comparison/upload (guard.ts:202-227). عميل `google-intent` يبتلع استثناء المكوّن ويعرض `RETRY` (google-intent.tsx:111-117). بالمقابل `serviceConfigured` يفحص السر فقط (dashboard.ts:100) فيرى المشغّل «مهيأ» بينما كل الطلبات تفشل.

**S3 — مزود SMS:** `otpProviderConfigured` يحتاج `SMS_PROVIDER` (model-gate.ts:21-46) وهو ليس ضمن `SETTING_KEYS` (settings.ts:7-19)؛ `runtimeEnv` لا يجلبه من قاعدة الإدارة (settings.ts:34-55). اختبار الإعدادات نفسه يقرأ `env.SMS_PROVIDER` (settings-test.ts:104-116). صفحة التفعيل تكتفي بـ«تواصل مع الدعم» (verify-phone/page.tsx:51-57) والرسالة بلا رابط (phone-verification.tsx:26).

**S4 — فشل النماذج الصامت:** التنفيذ يحفظ رسالة الفشل (execute.ts:122-157) لكن العرض يفلتر (`visibleComparisonRuns` view.ts:54-58) ويُظهر حالة فارغة عامة (workspace.tsx:723-738) مع notice success (workspace.tsx:322-325). مثال الرسالة المحجوبة: «مفتاح المزود المجاني غير مهيأ على الخادم» (dispatch.ts:61) و«مفتاح Anthropic غير مهيأ» (dispatch.ts:76).

**F12 (أُغلق، يحتاج اختبارًا):** `insertChallenge` ثم `provider.send`؛ عند الفشل يُحذف التحدي (send/route.ts:149-162) فلا يُحتسب في `countRecentSends` (otp/service.ts:98-105). لا اختبار يغطي أن إعادة المحاولة بعد 502 لا تُرجع 429.

## 5) خريطة آلة الحالات كما هي الآن

| الكيان | القيم الفعلية | الانتقالات / نقطة الخروج | ملاحظة |
|---|---|---|---|
| `users.status` | `active` \| `suspended` فقط (migrations/001_init.sql:14، 002_admin.sql:4) | suspend يضبط `suspended_until` + `session_valid_after` + يحذف الجلسات (actions.ts:61-66، account-access.ts:5-9)؛ restore يعيد active (actions.ts:71-88) | `temporary/indefinite` **تسميات مشتقة** لا قيم DB (users.ts:69-74) |
| الجلسة | كوكي موقّع 14 يومًا + `session_valid_after` | كل قراءة تفحص الحالة (`storedSessionAllows` session.ts:79-92) | لا مسار «تسجيل خروج من كل الأجهزة» للمستخدم |
| الجوال | `phone_e164` + `phone_verified_at` | لا يُوثّق إلا برمز؛ الإلغاء الإداري ينزل إلى غير موثّق (actions.ts:158-184) | سجل دائم append-only (008) + تفرّد الرقم الموثّق بtrigger (009) |
| `comparisons.status` | queued → running → closed \| failed \| incomplete | reconcile ذاتي بعد المهلة (store.ts:170-229) | «closed» بلا ترجمة (S9) |
| `model_runs.status` | queued/running/completed/incomplete/failed + policy_blocked/unfit/context_exceeded/live_disabled | تُحسم عبر dispatch؛ الفاشلة مخفية عن الشبكة | خطر الفشل الصامت (S4) |
| `jobs.status` | queued/active/completed/failed | claim + finishJob؛ العالق يُعاد/يُغلق | لا `cancelled` (CHECK يمنعه، 001:215) |
| `extraction_jobs.status` | completed \| failed (progress=100 عند الإدراج) | يُكتب مرة واحدة مع الرفع (repository.ts:89-106) | لا حالة معلّقة |
| `files.status` | `stored` فقط | لا حذف/فشل من الواجهة | لا طريق مسدود |
| `quota_accounts` | limit/used/reserved/in_flight | الحجز يحرّر في `settleAndClose` (execute.ts:74-110) | تغيير env لا يحدّث الحد القائم (S17) |
| `usage_reservations` | reserved/used/released | `closeReservations` يجعلها used عند وجود `completion_ms` (store.ts:470-486) | إحصائي أكثر منه تحكمًا |

## 6) «قفل بلا مخرج»: كل استجابة ومسارها

| الاستجابة | متى تظهر | هل للعميل إرشاد/مسار الآن؟ |
|---|---|---|
| 401 `anonymous` | جلسة منتهية/محذوفة | الصفحات تعيد التوجيه؛ API تعطي نصًا فقط بلا CTA (S11) |
| 403 `suspended` | محاولة دخول حساب معلّق | ✅ رسالة صريحة من دالة الدخول (F5) |
| 403 `profile_incomplete` | API مقارنة/رفع بحساب غير موثّق | الصفحات تُوجّه مسبقًا، والرفع أصبح مبوَّبًا (F11) — يبقى نص API بلا رابط |
| 403 `TURNSTILE_*` | إعداد Turnstile ناقص | ❌ «أعد المحاولة» لا تنجح (S2) |
| 403 `OTP_MISSING/EXPIRED` | لا تحدي نشط/منتهٍ | ✅ زر «إعادة إرسال الرمز» + «تعديل رقم الجوال» |
| 409 `PHONE_TAKEN` | رقم موثّق لحساب آخر | ✅ نفس الخطوة تسمح بالتعديل |
| 422 `OTP_PHONE` | إدخال غير صالح | ✅ رسالة إصلاح مباشرة |
| 429 `rate_limit` | سرعة الدخول/OTP/verify | ⚠️ نص + retry-after على الشبكة؛ عميل الدخول لا يعرض العدّاد |
| 429 `OTP_RESEND/ATTEMPTS` | تجاوز الإرسال/المحاولات | ✅ عدّاد إعادة إرسال مباشر |
| 429 `quota/concurrency` | حصة/تزامن مقارنة | ❌ بلا تفاصيل أو مسار (S12) |
| 502 `OTP_PROVIDER` | فشل مزود SMS | ✅ نص مؤقت، ولا يستهلك الحصة الآن (F12) |
| 503 `OTP_FAIL_CLOSED/OTP_UNCONFIGURED` | مزود غير مهيأ | ❌ قفل كامل حتى يتدخل المشغّل (S3) |
| 500 `store` | فشل SQLite | ⚠️ نص إعادة محاولة؛ لا تشخيص |

## 7) خطة إصلاح مرتبة

1. **S2 (Turnstile):** اشترط `TURNSTILE_EXPECTED_HOSTNAMES` في `serviceConfigured`، وامنع «أعد المحاولة» عند أكواد التهيئة (map في عميل الدخول/الرفع)، وأضف خطوة bootstrap إلى runbook. اختبار: `tests/admin-settings.test.ts` + حالة mapping.
2. **S3 (SMS):** أضف `SMS_PROVIDER` إلى `SETTING_KEYS/SETTING_META` أو وثّق env-only صراحةً؛ وأضف رابط/بريد دعم فعلي في `verify-phone-banner` و`verify-phone/page.tsx`. اختبار: `tests/admin-settings.test.ts`.
3. **S4 (فشل النماذج):** أضف دالة `comparisonOutcome` في `src/domain/comparison/view.ts` (ناجح/فاشل/أول رسالة فشل) واستخدمها في `workspace.tsx` لبطاقة خطأ بدل success، وفي `toPublicModel` لعرض «مقيد» عند غياب المفتاح. اختبار: `tests/comparison-view.test.ts`.
4. **S5 (حلقة next):** استبعد مسار التفعيل في `safeNextPath` (phone-history.ts:70-84). اختبار في `tests/phone-audit.test.ts`.
5. **S6 (تعريف موثّق):** استخدم `isPhoneVerified` في `server/phone/gate.ts:27` و`layout.tsx:58,75`، وأضف تدقيق صفوف شاذة في تقرير المشرف. اختبار وحدة للحالات الأربع.
6. **S7 (history detail):** أضف `await redirectUnverifiedToVerifyPhone("/history/" + id)` في `src/app/history/[id]/page.tsx` بعد جلب `id`، وقرّر مصير `/api/history` (بوابة أو توثيق استثناء).
7. **S8/S13 (الإدارة):** أعد CASE الحالة المشتقة في `server/admin/phones.ts:104`، وأعِد رموز رفض `applyAdminAction` واربطها notices. اختبارات: `tests/admin-phones.test.ts`.
8. **S9/S11/S12:** أضف `closed` إلى STATUS_TEXT؛ عالج 401 في عميل workspace بـCTA؛ أضف `retryAfterSeconds`/المتبقي ومسار الحصة في 429.
9. **P3s:** تمرير query في توجيه history، رسالة تشغيلية عند فشل قراءة الحالة، ربط/حذف الكيانات غير المستخدمة (تنسيق مع أسطول deadcode)، وتوثيق انحراف الحصص.
10. **بوابة الجودة قبل الدمج:** `npm run typecheck && npm run lint && npm test` + **اختباران ناقصان**: (أ) عميل `phone-verification` يرسل `cf-turnstile-response` ويصل إلى 200 (F7) — اختبار مكوّن/فيديو E2E؛ (ب) فشل مزود `/api/otp/send` ثم إعادة المحاولة لا تُرجع 429 (F12).

## 8) ما لم يُفحص / قيود

- **لم يُشغَّل أي اختبار أو بناء أو فحص أنواع** (تعليمات المشرف: node_modules قيد التثبيت، لا npm install/build). كل النتائج ثابتة وقد تتغير بعد لقطة 07:52.
- **لا git** (ممنوع) → لم تُقارن التغييرات بـ HEAD ولا بأي commit؛ التقرير يصف الشجرة الحالية فقط.
- **الملفات تغيّرت أثناء التدقيق** (07:38→07:50): أُعيد قراءة كل ملف متأثر، لكن أي تعديل بعد 07:52 غير مشمول؛ يجب إعادة التحقق عند الدمج (خصوصًا أن ملفات `tests` و`migrations/009` جديدة).
- لم تُفحص: كل مسارات `/api/admin/*`، أمان/أداء/UX التفصيلي (أسطول آخر)، سلوك Next.js client-router-cache بعد تغيّر الحالة (قد يعرض جزءًا قديمًا حتى refresh)، وسلوك المتصفح الفعلي لـlogout/Turnstile.
- لم تُفحص قدرة migrations (خصوصًا backfill `008` و`ANALYZE` في `009`) على قواعد كبيرة، ولا أثر الـtriggers على أدوات الإدارة.
- لم يُختبر E2E حي مع مزود SMS/Turnstile حقيقي، ولا تدفق «عميل قديم عالق» على بيانات إنتاج.
- تقييم «أفضل ممارسة» لتعريف `users.status` (نص حر) خارج النطاق؛ التوصية المعمارية: enum/CHECK لحالات الحساب لتقليل انحراف التسميات.
