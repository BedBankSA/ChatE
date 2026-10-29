# جرد الأسرار — ChatE (Secrets Inventory)

> **سياسة:** هذا الملف يذكر **الأسماء والمواقع وحالة التدوير فقط**. لم تُطبع أي قيمة سر في هذا الملف أو في أي مخرج آخر أثناء التدقيق. القيم المذكورة كأمثلة عامة (مثل `0x4AAA...` في `.env.example`) هي مفاتيح **عامة** موثّقة أصلًا في المستودع وليست أسرارًا.

| البند | القيمة |
| --- | --- |
| التاريخ | 2026-10-28 |
| المصدر الرئيسي للأسرار | `.env.local` (على القرص، غير متتبع في Git) |
| الملف المرجعي العام | `.env.example` (قوالب فارغة) |
| قاعدة التشغيل | `data/chate.sqlite` (gitignored) |
| الحالة | **توجد مفاتيح تبدو حية/حقيقية في `.env.local` → يجب التدوير قبل أي إطلاق.** لم تُجرَّب أي مفاتيح ولا استدعاء مدفوع. |

## 1. الجرد (أسماء فقط — بلا قيم)

### 1.1 أسرار خادم (Server secrets)

| الاسم | موجود في `.env.local`؟ | يُستخدم في | نوع الدوران المطلوب | حالة التدوير |
| --- | --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | **نعم — غير فارغ (قيمة تبدو حقيقية)** | `src/server/comparisons/execute.ts:122` → `dispatch.ts:74` → `haiku.ts` | إبطال القديم + إنشاء جديد في Anthropic Console | **لم يُدوَّر — مطلوب قبل الإطلاق** |
| `OPENROUTER_API_KEY` | **نعم — غير فارغ (قيمة تبدو حقيقية)** | `execute.ts:121` → `dispatch.ts:59` | إبطال القديم + مفتاح جديد | **لم يُدوَّر — مطلوب** |
| `SESSION_SECRET` | **نعم — غير فارغ (طول ~40)** | توقيع/التحقق من `chate_session`: `src/domain/auth/session.ts`، `src/server/google-session.ts`، fallback `OTP_PEPPER` | تغيير عشوائي ≥32 بايت (يُبطل كل الجلسات القائمة وOTP المعلّق) | **لم يُدوَّر — مطلوب** |
| `TURNSTILE_SECRET_KEY` | **نعم — غير فارغ (بطول 32)** | `src/server/turnstile.ts:60` → siteverify | تدوير من لوحة Cloudflare للودجت الحالي (المفتاح العام `NEXT_PUBLIC_TURNSTILE_SITE_KEY` يبقى) | **لم يُدوَّر — مطلوب** |
| `OTP_HTTP_AUTHORIZATION` | **لا (غائب/فارغ)** | `src/domain/auth/otp.ts:75-85` عبر `OTP_PROVIDER=http` | يُدَّرح مع مزود SMS عند تفعيله | غير مهيّأ |
| `OTP_PEPPER` | **لا (غائب/فارغ)** | `src/server/otp/config.ts` — fallback إلى `SESSION_SECRET` | إنشاء سر مخصص ≥32 بايت (يُفضّل قبل الإنتاج) | غير مهيّأ |
| `GOOGLE_CLIENT_SECRET` | **لا (غير مستخدم)** | تدفق GIS ID-token لا يستخدم سر عميل (موثّق في README/.env.example) | لا ينطبق | لا ينطبق |

### 1.2 إعدادات (ليست أسرارًا لكنها حساسة تشغيليًا)

| الاسم | القيمة المسجّلة (آمنة) | ملاحظة |
| --- | --- | --- |
| `ADMIN_EMAILS` | عنصر واحد (بريد مشرف) — **لم تُطبع القيمة** | مسار إدارة بالبريد (بديل `sub`)؛ يُفضّل `ADMIN_GOOGLE_SUBS` |
| `ADMIN_GOOGLE_SUBS` | فارغ/غائب | لا يوجد مسار `sub` مُفعّل في هذه البيئة |
| `APP_URL` | `http://localhost:3211` (حاليًا) | كان `http://localhost:3000` في أول رصد (16:24) وصُحّح (16:27)؛ `auth/google/route.ts:79` له fallback ثابت `localhost:3000` |
| `TURNSTILE_EXPECTED_HOSTNAMES` | `localhost,127.0.0.1` | تطوير فقط؛ الكود يرفض localhost في الإنتاج (`domain/auth/turnstile.ts:21-23`، تحقق حي 503) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SITE_KEY` | `0x4AAAAAAFoJLWRjfC1ZYlwB` (عام) | مفتاح موقع عام، ليس سرًا |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_ID` | معرّف عميل عام معروف للمتصفح | عام، ليس سرًا |
| `HAIKU_LIVE_CALLS` | **غائب** | الافتراضي معطّل (`haikuLiveCallsEnabled` يشترط `"1"`); أي تفعيل يفتح إنفاق Anthropic حقيقي |
| `SQLITE_PATH` | غائب → الافتراضي `data/chate.sqlite` | ملف تشغيلي gitignored |
| `OTP_PROVIDER` / `OTP_HTTP_URL` | غائبان | OTP يفشل مغلقًا إن لم يُهيّأ |
| `RETENTION_*`, `USER_QUOTA_UNITS`, `SHARED_QUOTA_UNITS`, `MAX_*` | قيم افتراضية في `.env.example` | سياسات تشغيل، ليست أسرارًا |

## 2. فحص التسريب إلى Git

| الفحص | الأمر | النتيجة |
| --- | --- | --- |
| هل `.env.local` متتبع؟ | `git ls-files --error-unmatch .env.local` | **لا** — `error: pathspec ... did not match any file(s) known to git` |
| تاريخ الملفات المتتبعة | `git rev-list --all --objects | Select-String -SimpleMatch '.env'` | **كائن واحد فقط:** `.env.example` (لا `.env.local` ولا أي `.env.*`) |
| قواعد التجاهل | `.gitignore:1-7` | `.env`، `.env.local`، `.env.*.local`، `.env.*` مستبعدة، مع استثناء `!.env.example` |
| حالة الشجرة | `git status --porcelain` | لا تغييرات غير متتبعة تخص الأسرار (مسارات `scripts/qa/` و`docs/audit/` فقط) |

**الخلاصة:** لا دليل على تسريب `.env.local` إلى تاريخ Git. هذا **لا يبرّئ** القيم: قد تكون ظهرت في لقطات شاشة/سجلات محطة/نسخ احتياطية خارج Git، ولذلك التدوير مطلوب.

## 3. فحص التسريب إلى حزمة المتصفح

| الفحص | الأمر | النتيجة |
| --- | --- | --- |
| فحص الحزمة الرسمي (أسماء + قيم env) | `C:\Pak\node.exe --env-file=.env.local --import tsx scripts/check-client-bundle.ts` | **clean: 14 ملفًا في `.next/static` بلا أسماء أسرار خادم ولا قيم** |
| `npm run check:bundle` (بلا تحميل env — أسماء فقط) | `C:\Pak\npm.cmd run check:bundle` | clean: 14 files |
| مسح يدوي لقيم الأسرار الأربعة داخل `.next/static/*.js/css` | سكربت Node يقرأ `.env.local` في الذاكرة ويطابق القيم (بلا طباعة) | **0 مطابقة اسم أو قيمة** |
| أسماء أسرار في `src/app` و`src/components` | اختبار `product.test.ts` ("keeps provider secrets out of client source") | ناجح |
| لوحة الإدارة | `admin-dashboard.tsx:243-271` يعرض آخر أربع أحرف فقط من `integration_secret_versions` | الجدول فارغ في قاعدة الاختبار؛ لا أسرار في الصفحة (تحقق حي: لا قيم/أسماء أسرار في HTML/JSON) |

**ملاحظة:** الحزمة المفحوصة هي بناء production الحالي (بعد `next build` الساعة 16:39). بعد إعادة البناء النهائية يجب إعادة `check:bundle` مع تحميل `.env.local` (أمر جاهز أعلاه).

## 4. فحص الريبو/شجرة العمل (غير `.env.local`)

| النمط | النتيجة |
| --- | --- |
| `sk-ant-[A-Za-z0-9_-]{10,}` | لا نتائج في ملفات المصدر/الوثائق |
| `sk-or-v1-[A-Za-z0-9]{10,}` | 3 نتائج **اصطناعية** فقط في `tests/admin-dashboard.test.ts` و`tests/admin-operations.test.ts` (قيم وهمية لاختبار التنقية/العرض — ليست مفاتيح حية؛ لا تُطبع هنا) |
| `AIza[0-9A-Za-z_-]{30,}` | لا نتائج |
| `-----BEGIN ... PRIVATE KEY-----` | لا نتائج |
| إسناد `SESSION_SECRET|TURNSTILE_SECRET_KEY|OTP_PEPPER` لقيمة غير فارغة | لا نتائج خارج `.env.local` |
| `.env.example` | قوالب فارغة للأسرار؛ قيم عامة فقط (APP_URL، site key، client id) |

**الحالة:** لا توجد أسرار حية في الملفات المتتبعة. القيم الوحيدة الموجودة (في `.env.local`) خارج Git ومستبعدة.

## 5. المخاطر والحالة التشغيلية

1. **مفاتيح تبدو حيّة:** `ANTHROPIC_API_KEY` و`OPENROUTER_API_KEY` غير فارغين في `.env.local`. قبل إصلاح H-01 كان الكود يفعّل استدعاء Haiku حيًا؛ الآن الافتراضي معطّل (`HAIKU_LIVE_CALLS` غائب). لا يمكن إثبات أن المفاتيح لم تُستخدم (لا سجلات فواتير هنا) → **افتراض عدم السلامة حتى إثبات العكس**.
2. **`SESSION_SECRET`:** تزوير جلسات ممكن لمن يقرأ الملف. الدوران يُبطل كل الجلسات (بما فيها QA) — نفّذه قبل الإطلاق أو في نافذة صيانة.
3. **`TURNSTILE_SECRET_KEY`:** دوران السر يُبطل الرموز الجارية فقط؛ المفتاح العام للودجت لا يتغير ما لم يُنشأ ودجت جديد.
4. **OTP:** لا يوجد `OTP_PEPPER` مخصص؛ fallback إلى `SESSION_SECRET` يعني أن تدوير سر الجلسة يُبطل أي تحديات OTP معلّقة (مقبول) لكنه يخلط الغرضين. أضف `OTP_PEPPER` قبل تفعيل SMS إنتاجيًا.
5. **`ADMIN_EMAILS`:** بريد مشرف واحد مفعّل بدل `ADMIN_GOOGLE_SUBS`؛ ليس سرًا لكنه سطح تفويض؛ راجع من يوجد في القائمة وفضّل `sub`.
6. **`APP_URL`:** يجب أن يكون أصل HTTPS الإنتاجي المطابق تمامًا (بلا مسار)؛ fallback البرمجي `localhost:3000` مقلق ويجب إزالته في رقعة Lead.

## 6. خطة التدوير الموصى بها (تنفيذ المالك/Lead)

| الترتيب | السر | الخطوة | التحقق بعد |
| --- | --- | --- | --- |
| 1 | `ANTHROPIC_API_KEY` | مفتاح جديد في Anthropic Console، ضع القيمة في مخزن بيئة الخادم، ألغِ القديم | مزود Anthropic يعيد 401 للقديم؛ لا استدعاء حي حتى `HAIKU_LIVE_CALLS=1` معتمد |
| 2 | `OPENROUTER_API_KEY` | مفتاح جديد + إلغاء القديم | `GET /api/models` لا يتأثر؛ أول مقارنة free ناجحة فقط بعد الاعتماد |
| 3 | `TURNSTILE_SECRET_KEY` | تدوير من Cloudflare dashboard للودجت الحالي | تسجيل دخول/mutation مع Turnstile يعمل؛ الإعداد المحلي يبقى fail-closed |
| 4 | `SESSION_SECRET` | قيمة عشوائية ≥32 بايت | كل الجلسات القديمة 401/307؛ الدخول الجديد يعمل |
| 5 | `OTP_PEPPER` (جديد) | سر مستقل ≥32 بايت | OTP send/verify ناجح؛ لا fallback إلى SESSION_SECRET |
| 6 | `ADMIN_GOOGLE_SUBS` | نقل قائمة المشرفين إلى `sub` فقط | حساب المشرف 200، غير المشرف 403 |

**بعد التدوير:** أعد تشغيل الخادم والعامل (يقرآن env عند البدء)، ثم نفّذ:
```powershell
C:\Pak\node.exe --env-file=.env.local --import tsx scripts/check-client-bundle.ts
C:\Pak\npm.cmd test
```

## 7. ما لم يُفعل (حدود الجرد)

- لم تُطبع أو تُنسخ أي قيمة سر إلى أي مخرج/وثيقة/اختبار.
- لم يُجرَّب أي مفتاح مزود ولا أي استدعاء مدفوع (سياسة صارمة).
- لم يُجرَ تدوير فعلي (مسؤولية المالك/Lead)، ولم يُعدَّل `.env.local`.
- لم يُفحص تاريخ Git كاملًا بحثًا عن قيم أسرار (فحص المسارات فقط) — يوصى بأداة `gitleaks`/history scan قبل الإطلاق.
- لم تُفحص النسخ الاحتياطية/لقطات الشاشة/سجلات المحطة خارج المستودع.
