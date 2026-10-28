# أصول الإطلاق التي يملكها المالك — ChatE
# Launch assets the owner must produce (no secrets in this file)

**الغرض:** قائمة مختصرة بما يملكه المالك فقط ولا يستطيع أي وكيل تقني إنتاجه (حسابات، نطاقات، قرارات، عقود). كل بند: الأصل، الإجراء المطلوب، متغيرات البيئة الناتجة (القيم العامة صريحة، والأسرار تبقى فارغة)، أمر التحقق، والمانع المرتبط في `LAUNCH-READINESS.md`.

---

## English summary

Thirteen owner-only assets gate the launch: domain + DNS, production Google OAuth client/origins, Turnstile production hostnames and a rotated secret, an SMS OTP provider contract, admin Google `sub` values, off-SQLite private storage decision (no S3 in scope), a license decision, a support email/entity identity, the Haiku spend decision, OpenRouter credit purchase, VPS + SSH access, an offsite backup destination, and an uptime-monitor account. None can be produced by code; each maps to an env var or a written decision. Do not paste any secret into this file or into the repository.

---

## 1. جدول الأصول / Asset table

| # | الأصل | المالك يُنتج | متغيرات البيئة/المخرجات | التحقق | المانع |
| --- | --- | --- | --- | --- | --- |
| A1 | **النطاق + DNS** | شراء نطاق إنتاجي (مثل `chate.example.com`) وضبط A/AAAA إلى IP الخادم | `APP_URL=https://chate.example.com`؛ `TURNSTILE_EXPECTED_HOSTNAMES=chate.example.com` | `dig +short chate.example.com`؛ `curl -sI https://chate.example.com/` | B2 |
| A2 | **Google OAuth (إنتاج)** | إنشاء/تعديل OAuth Web Client، إضافة `https://chate.example.com` إلى Authorized JavaScript origins (بلا client secret — تدفق ID token) | `GOOGLE_CLIENT_ID=<public>`، `NEXT_PUBLIC_GOOGLE_CLIENT_ID=<same>` | نافذة تسجيل دخول حقيقية على النطاق تُكمل جلسة؛ الكوكي Secure | B2/G2 |
| A3 | **Turnstile إنتاج** | إضافة النطاق إلى ودجت `0x4AAAAAAFoJLWRjfC1ZYlwB` في Cloudflare، ثم تدوير السر | `NEXT_PUBLIC_TURNSTILE_SITE_KEY=0x4AAAAAAFoJLWRjfC1ZYlwB` (عام)، `TURNSTILE_SITE_KEY=0x4AAAAAAFoJLWRjfC1ZYlwB`، `TURNSTILE_SECRET_KEY=` (فارغ هنا)، `TURNSTILE_EXPECTED_HOSTNAMES=chate.example.com` | محاولة مقارنة على النطاق تمر عبر Turnstile؛ لا أخطاء `TURNSTILE_HOSTS` | B2/G2 |
| A4 | **مزود SMS** | عقد/حساب مزود OTP (HTTP API) + `OTP_PEPPER` عشوائي + رأس تفويض | `OTP_PROVIDER=http`، `OTP_HTTP_URL=https://<provider>/send`، `OTP_HTTP_AUTHORIZATION=` (سر)، `OTP_PEPPER=` (سر) | اختبار إرسال/استلام حقيقي؛ بعد التحقق تصبح `profiles.phone_verified_at` غير فارغة | B1/B8 |
| A5 | **هوية الإدارة** | استخراج `sub` من Google ID token لحساب المالك (لا البريد وحده) | `ADMIN_GOOGLE_SUBS=<google-sub>`، `ADMIN_EMAILS=owner@example.com` | `/admin` يفتح للمالك ويرفض حسابًا آخر | B2 |
| A6 | **قرار التخزين بلا S3** | إقرار أن الملفات تبقى على قرص الخادم الخاص (`STORAGE_DIR`) بلا روابط عامة، أو تأجيل الرفع | `STORAGE_DIR=/var/lib/chate/storage`، `DOWNLOAD_URL_TTL_SECONDS=300` | وجود المجلد بصلاحية `chate:chate 0750`؛ قرار مكتوب بشأن B3 | B3 |
| A7 | **الترخيص** | اختيار ترخيص/بيان حقوق للمشروع | ملف `LICENSE` أو صفحة حقوق — لا متغير بيئة | وجود الملف/الصفحة ومراجعته | B5 |
| A8 | **بريد الدعم + هوية الكيان** | بريد `support@`/`privacy@` + اسم الكيان/العنوان للصفحات القانونية | `SUPPORT_EMAIL` (إن أُضيف للمنتج)، نصوص الصفحات | بريد يستقبل فعلًا؛ الصفحات تعرضه | B12/D1 |
| A9 | **قرار Haiku** | إبقاء `HAIKU_LIVE_CALLS=0` (افتراضي) أو الموافقة على سقف إنفاق مكتوب + تنبيه فاتورة ثم `HAIKU_LIVE_CALLS=1` | `HAIKU_LIVE_CALLS=0` (غير سر) | `sudo grep '^HAIKU_LIVE_CALLS=' /etc/chate/chate.env` = 0 حتى القرار | B9 |
| A10 | **رصيد OpenRouter** | شراء `$10` أرصدة لمرة واحدة لرفع حد النماذج المجانية من 50 إلى 1000 طلب/يوم | `OPENROUTER_API_KEY=` (سر) | `/admin` يظهر استدعاءات ناجحة؛ لا 429 مستمر | B6/G2 |
| A11 | **مفتاح Anthropic** | حساب Anthropic + مفتاح إنتاجي (بعد قرار A9) | `ANTHROPIC_API_KEY=` (سر) | استدعاء Haiku واحد في staging ينجح | B6/B9 |
| A12 | **خادم VPS + وصول SSH** | خادم Ubuntu 24.04 + مفتاح SSH + جدار ناري | — | `ssh chate@<ip>`؛ `node -v` v24.x | B2 |
| A13 | **نسخ احتياطي خارجي** | مساحة خارج الخادم (rclone/B2/خادم آخر) | `BACKUP_DIR=/var/backups/chate`، `BACKUP_RETENTION_DAYS=14` (سكربت) | نسخة خارجية موجودة ومُتحقَّقة; تدريب استعادة | G3 |
| A14 | **مراقبة خارجية** | حساب UptimeRobot/BetterStack على `https://chate.example.com/api/models` keyword `"ok":true` + تنبيه للمالك | — | تنبيه تجريبي يصل خلال دقيقة | B11/G8 |

## 2. قيم بيئة جاهزة للنسخ (عامة فقط؛ الأسرار فارغة)

```ini
# /etc/chate/chate.env — public values only; fill secrets on the server, never here
APP_URL=https://chate.example.com
GOOGLE_CLIENT_ID=<google-web-client-id>
NEXT_PUBLIC_GOOGLE_CLIENT_ID=<google-web-client-id>
NEXT_PUBLIC_TURNSTILE_SITE_KEY=0x4AAAAAAFoJLWRjfC1ZYlwB
TURNSTILE_SITE_KEY=0x4AAAAAAFoJLWRjfC1ZYlwB
TURNSTILE_EXPECTED_HOSTNAMES=chate.example.com
HAIKU_LIVE_CALLS=0
OTP_PROVIDER=http
OTP_HTTP_URL=https://<sms-provider>/send
SQLITE_PATH=/var/lib/chate/chate.sqlite
STORAGE_DIR=/var/lib/chate/storage
DOWNLOAD_URL_TTL_SECONDS=300
USER_QUOTA_UNITS=200
SHARED_QUOTA_UNITS=2000
MAX_USER_CONCURRENCY=2
MAX_GLOBAL_CONCURRENCY=8
ADMIN_GOOGLE_SUBS=<admin-google-sub>
ADMIN_EMAILS=owner@example.com
RETENTION_COMPARISON_DAYS=90
RETENTION_FILE_DAYS=30

# secrets — intentionally empty in this document and in any committed file
ANTHROPIC_API_KEY=
OPENROUTER_API_KEY=
SESSION_SECRET=
TURNSTILE_SECRET_KEY=
OTP_HTTP_AUTHORIZATION=
OTP_PEPPER=
```

## 3. قرارات مكتوبة مطلوبة أيضًا (ليست متغيرات)

| القرار | القيمة المقترحة | المرجع |
| --- | --- | --- |
| ترخيص المشروع / حقوق المصدر | «كل الحقوق محفوظة» للـSaaS أو MIT إن أُريد نشر المصدر | `LEGAL-REVIEW.md` D10 |
| هوية الكيان/المتحكّم + عناوين | اسم قانوني + `privacy@`/`support@` | D1 |
| منطقة الاستضافة/النقل الدولي | خادم قريب + نسخ مشفرة | D2 |
| مدد الاحتفاظ النهائية + تنفيذها | 90/30 يومًا على أن تُنفَّذ فعليًا | D4 |
| حذف/تصدير بيانات المستخدم | تنفيذ قبل الإطلاق العام | D5 |
| سياسة القُصّر | 18+ في البيتا | D8 |
| تشفير القرص/النسخ | LUKS + نسخ مشفرة | D9 |

## 4. ما لا يستطيع الوكلاء فعله (صريح)

لا يمكن إنشاء نطاق، أو التحقق من ملكية Cloudflare/Google/SMS/VPS، أو توقيع عقد، أو إصدار ترخيص، أو الموافقة على إنفاق مالي من داخل هذا المستودع. هذه القائمة هي الحد الفاصل بين «جاهز تقنيًا» و«مُطلَق تجاريًا».
