# الإطلاق وتدوير الأسرار

لا تنشر هذا البناء قبل مراجعة المالك. لا يُفعَّل استدعاء Haiku الحي ولا مسار OpenRouter مدفوع.

## قبل الإطلاق

1. ملف SQLite على الخادم فقط عبر `SQLITE_PATH`. الافتراضي `data/chate.sqlite` ومستبعد من Git. لا Postgres.
2. `SESSION_SECRET` عشوائي طويل.
3. `GOOGLE_CLIENT_ID` و`NEXT_PUBLIC_GOOGLE_CLIENT_ID` هما معرّف الويب نفسه. لا سر عميل في تدفق رمز الهوية.
4. `TURNSTILE_EXPECTED_HOSTNAMES` أسماء الإنتاج فقط، بلا localhost.
5. دوّر سر Turnstile من لوحة Cloudflare للودجت الحالي `0x4AAAAAAFoJLWRjfC1ZYlwB` وضع القيمة في `TURNSTILE_SECRET_KEY`. لا يحتاج التدوير تغيير كود.
6. `OTP_PROVIDER=http` مع عنوان المزود. القيمة `fake` تُرفض في الإنتاج.
7. `ADMIN_GOOGLE_SUBS` بمعرّفات `sub` لا بالبريد وحده.
8. مجلد `storage` خارج النسخ العامة.

## التدوير

- OpenRouter: أنشئ مفتاحًا جديدًا، ضعه في بيئة الخادم، ألغِ القديم. لا تكتبه في الوثائق.
- Anthropic: بالطريقة نفسها لمتغير `ANTHROPIC_API_KEY`.
- الجلسات: غيّر `SESSION_SECRET` فيُبطل التوقيع القديم.
- Turnstile: السر الجديد يكفي. المفتاح العام يبقى إن لم تُنشئ ودجتًا آخر.

## هذا البناء

اختبارات المنطق لا تتصل بالمزود. بناء الإنتاج وملف SQLite يُسجَّلان في `docs/test-results.md` كما نُفذا فعلًا.
