# مراجعة الصفحات القانونية والبيانات — ChatE
# Legal & data review: privacy, terms, account, history pages vs actual data

**التاريخ / Date:** 2026-10-28 · **المراجع:** launch-commander (مراجعة هندسية) · **ليس رأيًا قانونيًا.** يلزم مستشار مرخّص (سعودي لـPDPL، وأوروبي لـGDPR إن خُدم مستخدمون في الاتحاد) قبل أي إطلاق مدفوع.
**الملفات المراجَعة:** `src/app/privacy/page.tsx`، `src/app/terms/page.tsx`، `src/app/account/page.tsx`، `src/app/history/page.tsx`، مع مخطط قاعدة البيانات `migrations/001_init.sql` و`002_admin.sql`، ومسارات API، و`.env.example`.

---

## English executive summary

**The four public pages make three claims the code does not honour:** privacy says files are stored privately with expiring owner-scoped download links (they are not — `POST /api/uploads` always returns 401), privacy and account both say the user can delete their account/files/history (no delete route exists), and privacy says retention is enforced by the admin (the `retention_settings` row exists but nothing reads it). Actual collection is broader than the pages admit in one direction (Google `sub`, email, name, phone, age, city, prompt text, model outputs, token/cost counters, admin audit) and narrower in another (files are never stored today). There is **no license**, **no controller identity, contact, lawful basis, retention schedule, rights process, DPA list, or DPIA**, and **no data export/deletion flow**. Before a paid public launch the owner must make 12 recorded decisions (§6) and re-write privacy/terms to match reality; private beta should carry a clear "beta, data may be reset, deletion on request by email" notice in the meantime. This is a risk report, not legal advice.

---

## 1. ما تجمعه القاعدة فعليًا / What is actually collected

| Data | Table/field | Evidence | Notes |
| --- | --- | --- | --- |
| Google account identity | `users.google_sub` (unique), `email`, `name`, `last_activity_at` | `migrations/001_init.sql:9-18`؛ `src/app/api/auth/google/route.ts:52-59` | يُحفظ عند أول دخول |
| Phone + verification | `profiles.phone_e164`، `phone_verified_at` | `001_init.sql:20-27` | مطلوب لكن غير قابل للتحقق اليوم (B1) |
| Optional demography | `profiles.age`، `city` | same | «اختياريان ولا يُستنتجان» (`src/app/account/page.tsx:10`) |
| Session | `sessions.token_hash`، `expires_at` | `001_init.sql:29-35` | HMAC-signed cookie payload has userId/googleSub/csrf (`src/domain/auth/session.ts:3-9`) |
| OTP challenge | `otp_challenges.phone_e164`، `code_hash` | `001_init.sql:37-47` | الرمز مُهشَّر بمِلح `OTP_PEPPER` (`src/domain/auth/otp.ts:23-25`) |
| Turnstile replay | `turnstile_tokens.token_hash`، `hostname`، `action` | `001_init.sql:49-55` | لا يُحفظ الرمز الخام |
| File metadata | `files.original_name`، `detected_type`، `sha256`، `storage_key` | `001_init.sql:57-67` | الجدول موجود لكن لا مسار يكتبه اليوم (uplods 401) |
| **Prompt text (plaintext)** | `comparisons.question` | `001_init.sql:116-125` | يُرسل أيضًا إلى المزودين |
| Evidence snapshot | `evidence_snapshots.payload` JSON فيه السؤال | `001_init.sql:127-132`؛ `src/server/comparisons/store.ts:53-61` | ملفات فارغة حاليًا |
| **Model output + usage** | `model_runs.output_text`، tokens، `cost_usd`، timings | `001_init.sql:134-153` | النص الكامل محفوظ |
| Cost/quota events | `usage_events`، `usage_reservations`، `quota_accounts` | `001_init.sql:155-185` | مالية/تشغيلية |
| Feedback | `user_feedback.rating` | `001_init.sql:187-193` | تقييم بلا نص |
| Admin audit | `admin_audit_events.admin_user_id/action/target/metadata` | `001_init.sql:195-202`؛ `src/server/admin/actions.ts:118` | هدف الإجراء = معرّف مستخدم |
| Ops statistics | `operation_stats`، `operation_buckets`، `latency_histogram` | `migrations/002_admin.sql:20-44`، `004_stats.sql` | بلا نص سؤال/إجابة (قائمة مفاتيح ممنوعة في `src/domain/admin/privacy.ts:1`) |
| Service registry/secrets metadata | `integration_secret_versions`، `secret_audit` | `002_admin.sql:122-147` | آخر 4 محارف فقط، لا سر كامل |
| Cookies | `chate_session` (HttpOnly, Secure when https, Lax)، `chate_google_nonce` (HttpOnly, 10m)، `chate_theme` | `src/domain/auth/session.ts:48-55`؛ `src/app/api/auth/google/intent/route.ts:11-17`؛ `src/app/layout.tsx:23` | لا كوكيز تحليلات/إعلانات |
| Server logs | stderr JSON منقّى (`writeLog`) | `src/domain/security/redact.ts:22-25` | أحداث مقارنة بأرقام/رموز، بلا نص |
| VPS/backups | ملف SQLite + نسخ gzip | لا شيء في التطبيق؛ `deploy/scripts/backup.sh` | **غير مشفّرة افتراضيًا** |

**مزودون يستلمون بيانات:** Google (هوية/متصفح)، Cloudflare Turnstile (IP/متصفح)، OpenRouter (السؤال/الأدلة عبر النماذج المجانية؛ سياسات الاحتفاظ تختلف — Gemma يحتفظ بالمطالبات 55 يومًا `docs/openrouter-model-registry.md:94`)، Anthropic (السؤال عند اختيار Haiku)، مزود SMS (رقم الجوال — غير مهيأ). **لا يوجد سجل معالجة/اتفاقيات معالجة (DPA) موثّق.**

## 2. ادعاءات الصفحات مقابل الواقع / Page claims vs reality

| الصفحة والادعاء | الواقع | الحكم |
| --- | --- | --- |
| `privacy:5` «يرسل نص السؤال ومحتوى الملفات … إلى مزودي النماذج» | صحيح للسؤال؛ الملفات لا تُرسل ولا تُخزَّن اليوم (uplods 401، attachments=[]) | جزئيًا صحيح، مضلّل في الملفات |
| `privacy:6` «الملفات تُحفظ في تخزين خاص … روابط تنزيل قصيرة ومقيدة بصاحب الحساب» | لا حفظ ولا روابط تنزيل؛ `STORAGE_DIR`/`DOWNLOAD_URL_TTL_SECONDS` غير مقروءة في `src` | **ادعاء غير صحيح** |
| `privacy:7` «يمكن حذف الحساب والملفات والسجل … مدد الاحتفاظ يضبطها المشرف» | لا مسار حذف؛ `RETENTION_*` غير مقروءة؛ لا مهمة احتفاظ؛ جدول `retention_settings` فقط | **ادعاء غير صحيح** |
| `account:11` «حذف الحساب يزيل … عند اتصال قاعدة البيانات» | لا واجهة ولا API للحذف | **ادعاء غير صحيح** |
| `history:10` «يظهر هنا سجل حسابك بعد تسجيل الدخول» | صفحة ثابتة لا تعرض صفوفًا | مضلّل (ليس قانونيًا لكنه وعد منتج) |
| `terms:5-8` «الاستخدام مجاني ضمن الحصص … Haiku مدفوع على حساب المالك … لا ضمان لزمن» | يتطابق مع الكود (الحصص، Haiku)؛ لكن لا يذكر أن الاستخدام **محجوب** حتى توثيق الجوال | ناقص |
| `privacy:8-16` ملحق Turnstile (سكربت Cloudflare، معالجة IP/متصفح) | صحيح ويتوافق مع `src/domain/security/headers.ts:1-19` (CSP يسمح challenges.cloudflare.com) | جيد |
| الصفحات كلها **لا تذكر** جمع رقم الجوال ولا مزود SMS | `profiles.phone_e164` + `otp_challenges.phone_e164/code_hash` يُجمعان فعلًا (`001_init.sql:20-27,37-47`)؛ واجهة OTP الجديدة (`src/components/otp-request.tsx`، `src/app/profile/complete/page.tsx` — شجرة عمل غير مُودَعة) ترسل الرقم لمزود SMS خارجي | **نقص إفصاح** — يجب إضافة الرقم/مزود SMS/مدة الاحتفاظ إلى الخصوصية |

## 3. الفجوات القانونية الحرجة / Critical legal gaps

1. **لا ترخيص للمشروع** — لا `LICENSE` في الجذر، وREADME يقول صراحة إن الترخيص لم يُختَر (`README.md:101-103`). أي نشر للمصدر أو استخدام تجاري بلا ترخيص غير محدد.
2. **لا هوية متحكّم/مسؤول حماية بيانات** — لا اسم كيان، لا سجل تجاري، لا عنوان، لا بريد خصوصية، لا DPO. مطلوب في PDPL/GDPR.
3. **لا أساس قانوني معلن ولا موافقة** — لا صفحة تقول «باستخدامك توافق على الشروط/الخصوصية»، ولا checkbox موافقة عند الدخول.
4. **لا حقوق أفراد قابلة للتنفيذ** — لا وصول/تصدير/تصحيح/حذف؛ الحذف الحقيقي يحتاج تنفيذًا (cascade موجود في المخطط، لكن بلا مسار).
5. **لا سياسة احتفاظ منفّذة** — القيم 90/30 يومًا مخزّنة فقط (`migrations/001_init.sql:204-209`، `002_admin.sql`?)؛ لا كود يقرأها → احتفاظ غير محدود فعليًا.
6. **لا تنظيم للنقل عبر الحدود** — المزودون خارج المملكة/الاتحاد؛ مطلوب تقييم أثر النقل/ضمانات (SCCs) وإن كان الـVPS في منطقة أخرى.
7. **لا عملية إبلاغ عن حوادث** — لا سياسة إخطار (GDPR 72 ساعة؛ PDPL له متطلبات إبلاغ عن التسريبات). دليل الحوادث التشغيلي موجود (`DEPLOYMENT-RUNBOOK.md §15`) لكن بلا التزام قانوني مكتوب.
8. **لا تشفير في الراحة** — SQLite ونسخها بنص صريح (أسئلة/إجابات/بريد/جوال). المخفف الحالي: صلاحيات ملفات فقط. يلزم LUKS على القرص و/أو تشفير النسخ.
9. **لا DPIA** — معالجة نصوص قد تحتوي بيانات شخصية عبر نماذج AI + بروفايل (جوال/عمر/مدينة) = تقييم أثر مطلوب قبل التوسع.
10. **الأسئلة/الإجابات محفوظة بلا حد وبلا تصدير** — التزام «المساءلة» (Art.30 سجل معالجة) غائب.
11. **صفحة الشروط غير صالحة لعقد مدفوع** — لا سعر، لا استرداد، لا إنهاء، لا مسؤولية، لا قانون حاكم، لا كيان، لا ضريبة/فاتورة. «الإطلاق المدفوع» يحتاج إعادة كتابة كاملة.
12. **بيانات القُصّر** — `age` اختياري بلا تحقق ولا بوابة سن؛ PDPL/GDPR يشددان على بيانات الأطفال.
13. **لا إفصاح عن رقم الجوال ومزود الرسائل** — رقم E.164 يُخزَّن (`profiles.phone_e164`) ويُرسل لمزود SMS خارجي، ولا تذكره الخصوصية. (شجرة العمل أضافت مسار OTP فعليًا؛ الإفصاح لم يُحدَّث.)
14. **إشعار «بيتا» غائب** — قبل البيتا يجب نص واضح: بيانات قد تُعاد، وطلب الحذف عبر البريد حتى يتوفر الحذف الآلي.

## 4. GDPR / PDPL — قائمة تحقق مختصرة (غير قانونية)

| الموضوع | GDPR (إن خُدم EU) | PDPL (السعودية) | الحالة |
| --- | --- | --- | --- |
| هوية المتحكّم ووسيلة الاتصال | Art.13(1)(a) | م.12/13 إفصاح | ❌ |
| الغرض والأساس القانوني | Art.6، 13(1)(c) | م.4-5 (موافقة/مصلحة مشروعة) | ❌ |
| فئات البيانات والمصادر | Art.14 | إفصاح | جزئي (نصوص الصفحات) |
| المشاركة مع أطراف ثالثة | Art.13(1)(e) | إفصاح عن الإفصاح | جزئي (Turnstile فقط) |
| النقل الدولي | Art.44-49 (SCCs/TIA) | ضوابط نقل البيانات | ❌ |
| مدة الاحتفاظ | Art.13(2)(a) | مدة الاحتفاظ | ❌ (غير منفّذة) |
| حقوق الأفراد (وصول/تصحيح/حذف/نقل/اعتراض) | Art.15-22 | حقوق م.3-4 من اللائحة | ❌ |
| سجل معالجة | Art.30 | سجل | ❌ |
| أمن المعالجة | Art.32 | ضوابط أمنية | جزئي (TLS، صلاحيات، WAL) |
| الإبلاغ عن الخروقات | Art.33 (72h) | إبلاغ الجهة/الأفراد | ❌ |
| DPIA | Art.35 | تقييم أثر عند الحاجة | ❌ |
| موافقة القُصّر | Art.8 | بيانات الأطفال | ❌ |
| مسؤول حماية البيانات | Art.37 (عند الانطباق) | DPO عند الانطباق | ❌ |

## 5. ملاحظات على سلوك المنتج ذات أثر قانوني

- `buildAnswerPrompt` يمنع تسرّب الاسم/البريد/الجوال في الموجّه ما لم يكتبه المستخدم بنفسه (`src/domain/comparison/plan.ts:39-55`) — إجراء أمني جيد يجب ذكره في الخصوصية.
- الحصص تُحسب لكل **استدعاء نموذج**، لا لكل سؤال (`README.md:97`؛ `src/server/comparisons/store.ts:264-272`)؛ أي تسعير مستقبلي يجب أن يعرّف هذا بوضوح في الشروط.
- لوحة الإدارة لا تعرض نص السؤال/الإجابة (`src/domain/admin/privacy.ts:1`؛ `README.md:117`) لكنها تعرض بريد/جوال/مدينة — يحتاج قرار «وصول الموظفين» وسجل تدقيق وصول.
- `model_runs.output_text` قد يحتوي محتوى مؤذيًا/شخصيًا؛ الاحتفاظ به 90 يومًا (غير المنفّذ) قرار منتج وقانون.
- الشروط الحالية تقول «الاستخدام مجاني» — إن أُطلق دفع لاحقًا يجب تغييرها وإضافة سياسة استرداد وضريبة قيمة مضافة.

## 6. قرارات المالك المطلوبة / Required owner decisions

| # | القرار | لماذا الآن | الافتراضي المقترح |
| --- | --- | --- | --- |
| D1 | الكيان القانوني (اسم/سجل/عنوان) والمسؤول عن حماية البيانات + بريد خصوصية | مطلوب في كل الصفحات والإفصاحات | شركة/مؤسسة مسجلة + `privacy@<domain>` |
| D2 | منطقة استضافة البيانات والنسخ الاحتياطية | يحدد النقل عبر الحدود وPDPL/GDPR | خادم في منطقة قريبة من المستخدمين + نسخ مشفرة |
| D3 | الأساس القانوني (عقد/مصلحة مشروعة/موافقة) لكل غرض | شرط مشروعية المعالجة | عقد للخدمة + مصلحة مشروعة للأمن، وموافقة صريحة للنماذج إن لزم |
| D4 | مدد الاحتفاظ النهائية (أسئلة/إجابات/ملفات/سجلات/OTP/جلسات) | القيم الحالية بلا تنفيذ | 30-90 يومًا للمقارنات، 7-30 يومًا للملفات، 14 يومًا للجلسات، OTP 5 دقائق |
| D5 | تنفيذ حذف/تصدير حقيقي ومسار طلب | حق قانوني + ادعاءات الصفحات | مسار «حذف حسابي» + تصدير JSON/SQLite للمستخدم |
| D6 | قائمة المعالجين/المزودين + DPAs + تقييم نقل | مطلوب للإفصاح والامتثال | OpenRouter، Anthropic، Google، Cloudflare، مزود SMS + DPAs |
| D7 | الموافقة على الشروط/الخصوصية (checkbox) وسجل الموافقات | إثبات الموافقة | إصدار Terms + حفظ `terms_version`/`accepted_at` |
| D8 | سياسة القُصّر (18+ أو موافقة ولي) | مخاطر children data | 18+ في البيتا، وإضافة تحقق لاحقًا |
| D9 | تشفير في الراحة/النسخ + مفاتيح | Art.32/PDPL | LUKS للقرص + GPG/age للنسخ الاحتياطية |
| D10 | ترخيص الكود | لا ترخيص اليوم | «كل الحقوق محفوظة» للـSaaS أو MIT/Apache إن أُريد نشر المصدر |
| D11 | نموذج الدفع/الاسترداد/الضريبة (إن أُطلق دفع) | لا شيء موجود | تسعير واضح + فوترة + VAT + سياسة استرداد |
| D12 | إفصاح AI/حدود الخدمة + إخلاء مسؤولية | يقلل مخاطر الاستخدام | فقرة «مخرجات آلية قد تكون خاطئة، ليست نصيحة مهنية» |

## 7. توصية قصيرة المدى / Immediate recommendation

1. **قبل البيتا:** صحّح `privacy`/`account`/`history` لتطابق الواقع (لا حفظ ملفات، لا حذف آلي)؛ أضف هوية اتصال وبريد دعم؛ أضف إشعار «بيتا، قد تُعاد البيانات، اطلب الحذف عبر البريد».
2. أضف صفحة شروط إصدار أولية + checkbox موافقة عند أول دخول (تغيير كود صغير — للـLead).
3. نفّذ حذف/تصدير + مهمة احتفاظ (B4/B10) قبل أي إطلاق عام.
4. كلّف مستشارًا قانونيًا بمراجعة PDPL وكتابة ToS/DPA قبل الإطلاق المدفوع؛ هذه الوثيقة مدخلات للمراجعة لا بديل عنها.
