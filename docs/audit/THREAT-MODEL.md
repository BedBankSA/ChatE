# نموذج التهديد — ChatE (Threat Model)

| البند | القيمة |
| --- | --- |
| التاريخ | 2026-10-28 |
| النطاق | مستودع ChatE كاملًا: تطبيق Next.js 16 (App Router)، SQLite محلي، عامل خلفية، مسارات API، لوحة إدارة، تكاملات Google/Turnstile/OpenRouter/Anthropic/SMS |
| طريقة البناء | مراجعة مستندة إلى المستودع + هجمات حية مُصرّحة على :3211/:3212/:3213 (تفاصيلها في `docs/audit/SECURITY-AUDIT.md`) |
| خارج النطاق | أمن سحابة Google/Cloudflare/مزودي النماذج، أمن محطة المطوّر، محتوى النماذج نفسه (سلامة المخرجات)، E2E متصفح كامل |

## English Executive Summary

ChatE is a single-tenant Arabic web app: an anonymous visitor can load public pages and models; a signed-in Google user gets a signed HMAC session cookie; sending a comparison additionally requires a completed profile (verified phone), a valid single-use Turnstile token, quota, and a model marked allowed. Admins are decided only from the stored user account plus an env allowlist, and admin mutations require a same-host Origin plus the session CSRF value. The highest-value assets are provider API keys, the session signing secret, Turnstile secret, per-user question/answer data, quota/account integrity, and the admin control plane. The most realistic attackers are (1) unauthenticated internet scanners, (2) authenticated low-privilege users abusing quota/IDOR/CSRF, (3) anyone who can reach the Node port directly or influence Host/forwarded headers behind a misconfigured proxy, and (4) a compromised or curious admin. Key trust boundaries are browser↔Next, Next↔SQLite, Next↔external providers, and the public↔admin surfaces. After the fixes in this audit, the dominant residual risks are: secret rotation/operational hygiene, CSP `unsafe-inline` (accepted), Host-header trust in `/api/theme`, no distributed rate limiting, and the accepted OTP/queue edge races. The model below maps each boundary to concrete abuse paths, existing controls with file evidence, and residual risk.

## 1. نموذج النظام (System model)

**المكوّنات وقت التشغيل:**

1. **تطبيق Next.js واحد** (App Router) يقدّم الصفحات ومسارات API: `src/app/**`. لا middleware (`src/middleware.ts` غير موجود)؛ التحقق داخل كل مسار.
2. **طبقة النطاق النقية:** `src/domain/**` (الجلسة، OTP، Turnstile، التخطيط، الحصص، الإدارة، الأمان). قابلة للاختبار بلا شبكة.
3. **طبقة الخادم:** `src/server/**` (guard، turnstile، replay، google-session/identity، db، comparisons، admin، otp).
4. **SQLite ملف واحد** عبر `node:sqlite` (`SQLITE_PATH`, افتراضي `data/chate.sqlite`؛ WAL؛ `migrations/001..005`). يحتوي المستخدمين/الملفات الشخصية/المقارنات/التشغيلات/الحصص/الرموز/الإحصاءات/التدقيق.
5. **عامل خلفية** `npm run worker` (`scripts/worker.ts`) يشارك الملف نفسه؛ تنفيذ المقارنة داخل عملية Next (`src/server/comparisons/execute.ts:26-56`).
6. **تكاملات خارجية:** Google Identity Services (ID token، بلا client secret: `src/server/google-identity.ts`)، Cloudflare Turnstile siteverify (`src/domain/auth/turnstile.ts:4,66-90`)، OpenRouter (`https://openrouter.ai/api/v1/chat/completions`)، Anthropic (`https://api.anthropic.com/v1/messages`)، مزود SMS عبر HTTP (`src/domain/auth/otp.ts:67-86`).
7. **متصفح العميل:** مكوّنات `src/components/*` تستدعي فقط مسارات Same-origin؛ لا مفاتيح مزودين في المتصفح.

**الوصول:** لا نشر عام في هذا المستودع (README). بيئة الاختبار محلية: dev 3211، production-like 3213، harness 3212. في الإنتاج المفترض يُنشر خلف HTTPS/وكيل عكسي.

## 2. الحدود والجهات الفاعلة والأصول

### 2.1 حدود الثقة (Trust boundaries)

| الحد | البروتوكول/الضوابط | الدليل |
| --- | --- | --- |
| متصفح ↔ Next | HTTPS في الإنتاج، CSP/HSTS/COOP، كوكي HMAC HttpOnly SameSite=Lax، Turnstile، Origin/CSRF للمسارات الحساسة | `src/domain/security/headers.ts`، `src/domain/auth/session.ts:56-69`، `src/server/guard.ts:82-118,202-228` |
| Next ↔ SQLite | ملف محلي، معاملات `BEGIN IMMEDIATE`، استعلامات مُعدّة، WAL | `src/server/db/transaction.ts:10-20`، `src/server/comparisons/store.ts` |
| Next ↔ Google GIS | ID token يُتحقق عبر `google-auth-library`، `aud`/`iss`/`exp`/`email_verified`/nonce | `src/server/google-identity.ts:4-20`، `src/domain/auth/google.ts:14-34` |
| Next ↔ Cloudflare Turnstile | siteverify بسر خادم، action/hostname/TTL، single-use | `src/domain/auth/turnstile.ts:26-49,92-149`، `src/server/turnstile*.ts` |
| Next ↔ OpenRouter/Anthropic | مفاتيح خادم فقط، مسارات ثابتة، رفض غير `:free` ورفض مسار مدفوع | `src/domain/models/dispatch.ts:47-94`، `src/server/comparisons/execute.ts:110-124` |
| Next ↔ مزود SMS | URL+Authorization من env، فشل مغلق إن غابا، لا صدى لجسم المزود | `src/domain/auth/otp.ts:88-103`، `src/app/api/otp/send/route.ts:80-85` |
| عام ↔ إدارة | حساب مخزّن + قائمة سماح + CSRF + Origin؛ لا بريد من الرابط | `src/domain/admin/gate.ts:10-55`، `src/server/admin/http.ts:31-58` |
| خادم ↔ مشغّل/عامل | نفس ملف SQLite؛ `jobs` + claim token؛ لا شبكة من العامل | `migrations/001_init.sql:211-227`، `src/server/comparisons/store.ts:142-155` |

### 2.2 الأصول (Assets) وأهميتها

| الأصل | لماذا يهم | أين |
| --- | --- | --- |
| مفاتيح المزودين (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) | إنفاق مالي مباشر وسرقة هوية مزود | `.env.local` (غير متتبع)، `execute.ts:121-122` |
| `SESSION_SECRET` | تزوير جلسة أي مستخدم/إدارة | `.env.local`، `google-session.ts` |
| `TURNSTILE_SECRET_KEY` | تعطيل بوابة مكافحة الآلات | `.env.local`، `server/turnstile.ts:60` |
| `OTP_PEPPER` / fallback SESSION_SECRET | حماية تجزئة رموز SMS | `src/server/otp/config.ts` |
| بيانات المستخدم: البريد/الجوال/المدينة/العمر | خصوصية (PII) | `profiles`, `users` |
| أسئلة/أجوبة المقارنات | بيانات حساسة محتملة (قد تحتوي PII) | `comparisons.question`, `model_runs.output_text`, `evidence_snapshots.payload` |
| الحصص/الاستخدام | سلامة أعمال ومنع الإنفاق | `quota_accounts`, `usage_reservations`, `jobs` |
| لوحة الإدارة وسجل التدقيق | منع التصعيد والمساءلة | `admin_audit_events`, `src/server/admin/**` |
| ملف SQLite نفسه | كل ما سبق | `data/*.sqlite` (gitignored) |
| إعدادات الإدارة (allowlist) | من يُدير | env `ADMIN_GOOGLE_SUBS`/`ADMIN_EMAILS` |
| سمعة/توافر الخدمة | إساءة استخدام التكلفة/الرسائل/النماذج | Turnstile/quota/rate limits |

### 2.3 الجهات الفاعلة والقدرات

| الفاعل | القدرات الواقعية | غير قادر على |
| --- | --- | --- |
| زائر مجهول (ماسح إنترنت) | استدعاء كل المسارات العامة/المحمية بلا جلسة، أجسام كبيرة/مشوّهة، طرق بديلة، Host/XFF مخصص، محاولات Turnstile | توقيع جلسة، اجتياز Turnstile الحقيقي بلا رمز، قراءة قاعدة البيانات |
| مستخدم Google عادي | الحصول على جلسة صحيحة، ملف شخصي، رفع/مقارنة ضمن الحصة، محاولة IDOR/CSRF/إساءة حصص | رؤية بيانات غيره (تحقق حي 404)، إدارة |
| مستخدم موقوف/محذوف | كوكي قديم صحيح التوقيع | استخدامه بعد الإصلاح (307/401) |
| مشرف | كل عمليات الإدارة، رؤية قوائم المستخدمين والإحصاءات | تعديل نفسه بالحذف/الإيقاف الذاتي (مرفوض)، تجاوز Origin/CSRF |
| مهاجم يتحكم بالشبكة/وكيل معكوس | رؤوس Host/X-Forwarded-*، إعادة توجيه، اعتراض HTTP قبل HSTS | كسر HMAC أو TLS في الإنتاج |
| مهاجم على نفس المضيف (محلي) | قراءة `.env.local`، قاعدة البيانات، العمليات | خارج نطاق الويب (ثقة المحطة) |
| مشرف/موظف داخلي سيئ النية | وصول إداري مشروع | لا يوجد سجل تدقيق مضاد للتلاعب (SQLite محلي) |

## 3. مسارات الإساءة (Abuse paths)

| ID | الهدف | المسار | احتمال | أثر | أولوية | الضوابط الحالية | المتبقي |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T-01 | سرقة إنفاق Anthropic | مستخدم مكتمل يختار Haiku → dispatch بمفتاح حقيقي | كان متوسطًا؛ مرتفع قبل الإصلاح | مرتفع | **High** | `HAIKU_LIVE_CALLS=1` opt-in فقط (`haiku.ts:12-14`, `dispatch.ts:79`) | تدوير المفاتيح + فحص بدء تشغيل |
| T-02 | تزوير جلسة أي مستخدم/مشرف | الحصول على SESSION_SECRET أو توقيع HMAC صحيح | منخفض | حرج | **High** إذا تسرّب | HMAC-SHA256 + timingSafeEqual + عدم تسريب السر | تدوير + تشديد تشغيل |
| T-03 | تجاوز إيقاف/سحب الجلسات | استخدام كوكي قديم بعد إيقاف الحساب | متوسط (كان) | متوسط | **Medium** | فحص `session_valid_after`+`suspended` لكل قراءة (H-02) | جدول sessions قابل للإلغاء |
| T-04 | CSRF على مسارات الحالة | موقع خارجي يرسل POST؛ كوكي Lax لا يُرسل، لكن مسارات بلا Origin | منخفض-متوسط | متوسط | **Medium** | same-origin في gateTurnstile + إدارة CSRF؛ Lax أساسًا | `/api/theme` (L-01)؛ توكن CSRF موحّد |
| T-05 | IDOR على بيانات مقارنة | تخمين UUID وقراءته بجلسة أخرى | منخفض | مرتفع | **Medium** | تقييد `user_id` في `readComparison` | تحقق حي 404/200 |
| T-06 | تصعيد إداري | بريد/رابط/حقل مزوّر أو CSRF | منخفض | حرج | **Medium** | هوية من الحساب المخزّن، allowlist، Origin+CSRF، لا بريد من الرابط | تدوير/تقييد allowlist بـ sub |
| T-07 | إغراق SMS/OTP | إعادة إرسال/تخمين متوازٍ | متوسط | متوسط (تكلفة/توثيق) | **Medium** | 3/15د، 5 محاولات، عدّاد ذري، Turnstile، جلسة | سقف verify + معاملة عدّاد الإرسال (L-08) |
| T-08 | استنزاف/تجاوز الحصة | مقارنات محجوبة فقط، idempotency abuse | متوسط | منخفض-متوسط | **Medium-Low** | UUID idempotency + unique(user,key) + حجز ذري | سقف لكل مستخدم (L-07) |
| T-09 | DoS موارد | أجسام JSON ضخمة/متكررة، intent spam | متوسط (كان) | متوسط | **Medium** (مُغلق) | سقف 1MiB + token-bucket + Turnstile | حد موزّع/WAF |
| T-10 | إعادة استخدام Turnstile | سرقة/إعادة رمز | متوسط | متوسط | **Medium** | single-use ذري (SQLite+ذاكرة)، action/hostname/TTL | fail-closed عند تعذّر DB (L-04) |
| T-11 | Open redirect/تصيّد | Host/Referer للتوجيه من `/api/theme` | منخفض | منخفض-متوسط | **Low** | Referer origin allowlist | ثغرة Host header (L-01) |
| T-12 | ثغرة XSS | حقن HTML من سؤال/جواب/اسم | منخفض | مرتفع | **Low** | React escaping، لا HTML sinks، CSP جزئي | CSP unsafe-inline (M-05) |
| T-13 | SQLi | حقن في بحث/ترتيب/معرّفات | منخفض | حرج | **Low** | استعلامات مُعدّة + قائمة سماح ORDER BY + LIKE مهروب | لا شيء معروف |
| T-14 | SSRF | جعل الخادم يطلب URL مهاجم | منخفض | مرتفع | **Low** | عناوين مزودين ثابتة؛ OTP URL من env | مراجعة عند إضافة تكاملات |
| T-15 | تسريب أسرار في الحزمة/الريبو | متغير خادم يُستورد في client أو يُرفع إلى git | منخفض | حرج | **Low** | فصل server-only + `check:bundle` + gitignore | تدوير + فحص CI |
| T-16 | استنزاف عرض/إساءة نماذج | استدعاء نماذج free عبر مفتاح حقيقي | منخفض-متوسط | منخفض-متوسط | **Low** | `:free` فقط، حصص، Turnstile | سقوف مزود/مستخدم |
| T-17 | كشف معلومات عبر أخطاء/إحصاءات | رسائل stack، أسماء أسرار في لوحة | منخفض | متوسط | **Low** | أخطاء عامة، لوحة بلا نص سؤال/جواب، تدقيق | سجل تدقيق محلي غير مقاوم للتلاعب |
| T-18 | تعطيل/إساءة العامل | jobs عالقة/تكرار | منخفض | متوسط | **Low** | claim token، إعادة تأهيل stale، معاملات | مراقبة/حدود طابور |

## 4. التحقق من الضوابط الحالية (مختصر مع أدلة)

- **المصادقة:** ID token عبر Google، فحص `aud`/`iss`/`exp`/`email_verified`/`nonce` (`src/domain/auth/google.ts:14-34`)، upsert من الـ claims فقط (`profileFromVerifiedClaims` يتجاهل جسم العميل). جلسة HMAC موقّعة مع `csrf` و`iat` و`exp` 14 يومًا (`auth/google/route.ts:63-81`).
- **التفويض:** دالة `evaluateAccess` ترتّب: جلسة → إيقاف → adminRoute → اكتمال ملف → Turnstile → حصة → سياسة نموذج (`src/domain/auth/access.ts:13-22`)، لكن المسارات الحالية تكرر الفحوص يدويًا (المقارنة: `handle.ts:17-34`؛ OTP: مساراته). الفحص الحي أثبت 401/403/429 المتوقعة.
- **Turnstile:** action/hostname/TTL/single-use؛ حي: 200 ثم replay 403 reused، wrong action 403، missing 403؛ إعداد إنتاج محلي → 503 فشل مغلق.
- **الحصة:** حجز ذري داخل `BEGIN IMMEDIATE` مع صف job (`store.ts:28-90,274-334`).
- **الإدارة:** `adminDecision` يشترط تطابق `userId/googleSub` مع صف `users` + allowlist؛ `adminMutationAllowed` Origin==Host + CSRF بمقارنة ثابتة الزمن (`gate.ts:32-55`). حي: 403/200/303 كما هو موصوف.
- **RTL/عرض المخرجات:** React text nodes فقط؛ لا `dangerouslySetInnerHTML` (grep).
- **الأسرار:** `.env.local` غير متتبع، لا أثر له في تاريخ git، والحزمة نظيفة (`check:bundle` مع env: 14 ملفًا بلا أسماء/قيم).

## 5. التخفيفات الموصى بها (مرتبة)

1. (عالية) تدوير كل الأسرار الحية الآن + إضافة `OTP_PEPPER` مخصص + فحص بدء تشغيل يمنع `HAIKU_LIVE_CALLS=1` خارج بيئة معتمدة.
2. (عالية) جدول جلسات قابل للإلغاء (jti/hash) + سجل جلسات، بدل الاعتماد فقط على `session_valid_after`.
3. (متوسطة) رقعة `/api/theme`: اشتقاق الأصل من `APP_URL` ورفض Host غير المعروف + Origin/CSRF.
4. (متوسطة) nonce-based CSP عبر middleware مع `strict-dynamic` وإزالة `unsafe-inline` من script-src.
5. (متوسطة) `Cache-Control: no-store` على مسارات المقارنات/الجلسة؛ مراجعة كل استجابات تحتوي بيانات مستخدم.
6. (متوسطة) سقف موزّع (proxy/WAF) + سقف لكل مستخدم على إنشاء المقارنات وOTP verify.
7. (متوسطة) معاملة/قيد فريد لعدّاد إرسال OTP؛ إبطال التحديات القديمة عند إرسال جديد (اختياري).
8. (منخفضة) وثّق افتراض الوكيل العكسي: `x-forwarded-*` موثوقة فقط من وكيل معروف؛ وإلا قدم `TRUST_PROXY`.
9. (منخفضة) رفض المقارنات التي لا تحتوي أي run قابل للتنفيذ، وتسجيل رفض الإساءة.
10. (منخفضة) مراقبة إنفاق المزودين وخروج عن المألوف في العدّادات؛ تنبيهات عند فشل الإحصاءات.

## 6. المخاطر المتبقية (Residual risk)

| المخاطرة | لماذا تبقى | التخفيف الجزئي |
| --- | --- | --- |
| تسريب/إساءة مفاتيح حقيقية قبل التدوير | الأسرار موجودة في `.env.local` على محطة تطوير وتاريخ غير معروف من الاستخدام؛ لا يمكن إثبات عدم الاستخدام | الإصلاح H-01 + تحقق الحي بأن الحزمة نظيفة؛ التدوير هو الحل |
| المستخدم المحلي/المحطة | من يقرأ ملف الأسرار يستطيع تزوير الجلسات وقراءة SQLite | خارج نطاق التطبيق (ثقة المضيف) |
| إساءة بعد سرقة SESSION_SECRET | لا يوجد تدوير تلقائي/كشف إلغاء مركزي | عمر 14 يومًا + تدوير يدوي؛ جدول جلسات مستقبلي |
| CSP بلا nonce | اختيار مقصود (Next inline bootstrap) | تقليل XSS عبر React + no sinks |
| حد المعدل في الذاكرة | عدة عمليات/إعادة تشغيل | حد الوكيل الموصى به |
| إساءة موارد محدودة (مقارنات محجوبة، intent) | لا حصة على بعض المسارات | Turnstile + السقوف المضافة |
| سجل تدقيق محلي | يمكن لمشرف/ملف SQLite تعديله | نسخ احتياطي/خارجي مستقبلي |
| صفحة `/history` وإحصاءات غير موصولة | إعلان صادق في الوثائق | لا أثر أمني مباشر |

## 7. الافتراضات والأسئلة المفتوحة

**افتراضات (تحتاج تأكيد المالك):**
1. النشر العام سيكون خلف HTTPS ووكيل عكسي يفرض Host/Forwarded صحيحة ويضيف حدودًا (WAF).
2. مستخدم واحد لكل حساب Google، ولا multi-tenant؛ بيانات كل مستخدم معزولة بمعرّف المستخدم.
3. لا تُخزَّن بيانات دفع أو محتوى صحي/حكومي؛ الأسئلة قد تحتوي PII لكن التخزين ضروري وظيفيًا مع سياسة احتفاظ (90 يومًا افتراضيًا).
4. الأسرار الحالية في `.env.local` خاصة بالتطوير/الاختبار ولم تُستخدم في إنتاج حقيقي (غير مُثبت).
5. التطبيق يعمل بعملية Node واحدة (حد المعدل داخل الذاكرة كافٍ مرحليًا).

**أسئلة مفتوحة:** هل سيُضاف middleware/CSP nonce قبل النشر؟ ما نطاق `ADMIN_GOOGLE_SUBS` في الإنتاج (هل سيُستخدم البريد فقط)؟ هل ستُشغَّل عملية واحدة أم عدة (يحدد استراتيجية حد المعدل)؟ هل توجد بيانات PII حقيقية في `data/*.sqlite` الحالية (يلزم التأكد قبل النسخ/النسخ الاحتياطي)؟

## 8. المراجع المستندة إلى المستودع

- الجلسة والمصادقة: `src/domain/auth/session.ts`، `src/server/google-session.ts`، `src/server/google-identity.ts`، `src/app/api/auth/google/route.ts`
- Turnstile: `src/domain/auth/turnstile.ts`، `src/server/turnstile.ts`، `src/server/turnstile-replay.ts`، `migrations/001_init.sql:49-55`، `migrations/003_security.sql`
- الحصص والطابور: `src/server/comparisons/store.ts`، `migrations/001_init.sql:155-227`، `src/server/db/transaction.ts`
- الإدارة: `src/domain/admin/gate.ts`، `src/server/admin/http.ts`، `src/server/admin/actions.ts`، `src/server/admin/identity.ts`
- الإدخال والعرض: `src/domain/comparison/input.ts`، `src/domain/auth/profile.ts`، `src/domain/auth/otp.ts`، مكوّنات `src/components/*`
- الترويسات والأسرار: `src/domain/security/headers.ts`، `src/domain/security/redact.ts`، `scripts/check-client-bundle.ts`، `.gitignore`
- دليل التدقيق: `docs/audit/SECURITY-AUDIT.md`، `docs/audit/SECRETS-INVENTORY.md`
