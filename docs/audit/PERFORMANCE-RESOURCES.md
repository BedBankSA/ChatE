# أداء ChatE واستهلاك الموارد — قياسات فعلية وتوصيف النشر الأصغر

**تاريخ القياس:** 2026-10-28 (توقيت الجهاز، UTC+3)
**الخادم المقاس:** بناء إنتاجي عبر \`next start -p 3213\`، PID 15744، \`NODE_ENV=production\`، \`BUILD_ID=715U5ex5ZXWxfiA4JHapA\` (بُني 16:39:30 محليًا).
**الجهاز:** 12 نواة منطقية، 15.7 GB RAM، Windows، Node v24.22.1 على \`C:\Pak\node.exe\`.
**القياس لا يعدّل مصدر التطبيق.** كل الأدوات في \`scripts/bench/\`، وملفات المخرجات في \`scripts/bench/tmp/\`.

> **حدود الأمانة:** كل رقم في هذا التقرير مقيس على هذا الجهاز في هذا اليوم ما لم يُنص على أنه «افتراض» أو «تقدير». لم يُجرَ أي استدعاء مزوّد حي، ولم تُقرأ أي أسرار أو تُطبع. قياسات التحميل تُطلق طلبات GET فقط، والمسارات المستخدمة لا تشغّل مزوّدًا.

## Executive summary (English)

ChatE's production server is fast on the happy path (page p50 ≈ 7–9 ms at concurrency 1, /api/models ≈ 2.3 ms) but saturates a single event loop at ≈ 190–216 req/s mixed traffic, where page p95 grows to ≈ 330–550 ms. First-load weight is dominated by JavaScript (134.5 KB gzip shared, 136.5 KB gzip per page) and 96.1 KB of IBM Plex Sans Arabic woff2 files; CSS is only 5.3 KB gzip. Eleven declared runtime dependencies (~13.4 MB installed) are never imported and ship zero bytes. The idle production process uses ≈ 113 MB RSS / 113 MB PSS; after ≈ 9,000 mixed requests RSS peaked at 358.8 MB (it fell back to 138.1 MB when idle), which makes a 512 MB container unsafe at peak and a 1 vCPU / 1 GB profile the cheapest safe target. SQLite planning is healthy (all hot reads use indexes) but the database grows ≈ 19.1 KB per comparison (≈ 19 MB per 1,000) and **no retention runner exists**, although \`retention_settings\` defaults to 90 days. Cheapest wins: delete 11 dead dependencies, gzip the JSON APIs (13.4 KB API response is served uncompressed), subset fonts (up to ~28–40 KB per first load), add SQLite \`cache_size\`/\`mmap_size\` pragmas, and implement the retention job. Provider spend, not infrastructure, dominates cost per 1,000 comparisons.

---

## 1) الحِمل على المتصفح (Client payload)

**الطريقة:** \`node scripts/bench/build-stats.mjs\` يقرأ \`.next/\` الإنتاجي فقط (\`route-bundle-stats.json\`، \`next-font-manifest.json\`، \`build-manifest.json\`، ومخططات \`*.nft.json\`)، ويحسب gzip بمستوى 9 وbrotli بجودة 11 من بايتات الملفات. لا يشغّل بناءً.

### 1.1 الأصول المشتركة (تُحمَّل في أول زيارة لكل صفحة)

| العنصر | عدد الملفات | خام | gzip | brotli |
|---|---:|---:|---:|---:|
| JS مشترك (Next + React + runtime) | 6 | 452.9 KB | **134.5 KB** | 115.4 KB |
| CSS (Tailwind، ملف واحد) | 1 | 20.6 KB | **5.3 KB** | 4.6 KB |
| خطوط IBM Plex Sans Arabic (woff2) | 4 | **96.1 KB** | 96.2 KB* | 96.1 KB* |

\* woff2 مضغوط أصلًا، لذا gzip/brotli لا يوفّران شيئًا. الخطوط = **40% من وزن أول تحميل تقريبًا**.

أكبر حزم JS المشتركة: \`3wbm-994r45kr.js\` 224.4 KB خام (70.1 KB gzip) و\`34goyxc2anvlg.js\` 159.2 KB خام (44.0 KB gzip). الملفات المشتركة هي Next/React نفسها، وليست كود التطبيق.

### 1.2 الوزن لكل مسار (أول تحميل، إنتاجي)

| المسار | JS gzip | CSS gzip | خطوط gzip | الإجمالي gzip | الإجمالي brotli | حزمة المسار الإضافية (خام) |
|---|---:|---:|---:|---:|---:|---|
| \`/\` | 136.5 KB | 5.3 KB | 96.2 KB | **237.9 KB** | 217.9 KB | \`1iykzx_e0eoh5.js\` 4.3 KB |
| \`/workspace\` | 138.2 KB | 5.3 KB | 96.2 KB | **239.6 KB** | 219.3 KB | \`0j1d2kf_wnd1m.js\` 9.2 KB |
| \`/profile/complete\` | 136.7 KB | 5.3 KB | 96.2 KB | 238.1 KB | 218.0 KB | \`2kk3kn-4z7y0r.js\` 4.9 KB |
| \`/history\` \`/account\` | 136.5 KB | 5.3 KB | 96.2 KB | 237.9 KB | 217.9 KB | 4.3 KB |
| \`/privacy\` \`/terms\` \`/admin\` \`/_not-found\` | 134.5 KB | 5.3 KB | 96.2 KB | 235.9 KB | 216.2 KB | — |

ملاحظات مقيسة:
- حزم المسار الإضافية صغيرة (2.6–9.2 KB خام)، أي أن التقسيم الحالي جيد ولا فائدة كبيرة من تقسيم إضافي.
- \`libphonenumber-js\` (9.97 MB تثبيت) مستورد من الخادم فقط (\`src/domain/auth/profile.ts:1\`) ولا يظهر في حِمل المتصفح. \`google-auth-library\` كذلك خادمي فقط (\`src/server/google-identity.ts:1\`).
- \`.next/dev/static\` (للمقارنة فقط): 64 ملف js/css، 22.0 MB خام / 5.06 MB gzip — أي أن خادم التطوير يقدّم ~21× وزن الإنتاج. لا تقاس الأرقام على خادم dev.

### 1.3 طرف ثالث (Google GIS وTurnstile)

| السكربت | يُحمَّل متى | على السلك (مضغوط) | بعد فك الضغط |
|---|---|---:|---:|
| \`https://accounts.google.com/gsi/client\` | الصفحة الرئيسية بعد التركيب (\`src/components/google-intent.tsx:8,53-79\`) | **102,186 B** | 278,203 B |
| \`https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit\` | أول عملية محمية فقط (مقارنة/رفع/دخول) (\`src/components/turnstile.ts:4,26-52\`) | **27,494 B** | 86,732 B |

كلاهما يُحمَّل ديناميكيًا بـ\`createElement("script")\` وليس في HTML الأولي. يوجد \`preconnect\` لـ\`challenges.cloudflare.com\` فقط (\`src/app/layout.tsx:30\`)، ولا يوجد \`preconnect\` لـ\`accounts.google.com\`. GIS يُحمَّل عند فتح الرئيسية، أي أنه يضيف ~100 KB مضغوطة لمسار غير مسجّل الدخول. القياس عبر \`curl --compressed\` اليوم (شبكة خارجية؛ قد يتغير).

### 1.4 حزم معلنة وغير مستوردة (Dead dependencies)

\`build-stats\` يفحص الاستيراد في \`src/\` و\`scripts/\` و\`next.config.ts\`، ثم يتحقق من مخططات \`*.nft.json\` (2,894 ملف تتبع) ومن نصوص حزم المتصفح. النتيجة: **11 حزمة runtime لا تُستورد ولا تدخل أي حزمة**، مجموعها ≈ **13.4 MB** تثبيت:

\`@tremor/react\` 1,179.5 KB، \`@tanstack/react-table\` 744.0 KB، \`jszip\` 812.5 KB، \`mammoth\` 1,632.2 KB، \`unpdf\` 2,122.7 KB، \`word-extractor\` 72.5 KB، \`zod\` 6,004.8 KB، \`tailwind-merge\` 1,028.0 KB، \`@radix-ui/react-slot\` 48.5 KB، \`class-variance-authority\` 21.6 KB، \`clsx\` 8.4 KB.
(الأثر على حزمة المتصفح = **صفر بايت**، لأنها غير مستوردة؛ الفائدة حذفها تقليل زمن التثبيت/CI ومساحة الصورة وسطح الهجوم. \`next.config.ts:8-15\` يسرد \`mammoth/word-extractor/unpdf/jszip\` في \`serverExternalPackages\` بلا فائدة لأنها غير مستوردة أصلًا.)

> \`react-aria\` المذكورة في المهمة ليست في \`package.json\` ولا مستوردة؛ لا أثر لها. عبء التبعيات الحقيقي هو ما سبق.

## 2) الخادم (Server)

**الطريقة:** \`node scripts/bench/measure-resources.mjs --port=3213\` (Get-Process/RSS + QueryWorkingSetEx لـPSS عبر C# مضمّن + Win32_PerfFormattedData للـCPU + Win32_Process لـI/O). PID محدد من المنفذ المستمع.

| المقياس | القيمة المقيسة |
|---|---|
| زمن الإقلاع حتى \`Ready\` | **461 ms** (\`logs/prod.out.log\`) + 113 ms لتحميل \`next.config.ts\` |
| عمليات الخادم | عملية node واحدة PID 15744 (لا عمال أبناء؛ فقط conhost) |
| RSS خامل | p50 **113.65 MB** / max 113.65 MB |
| PSS خامل | p50 **113.38 MB** (الفرق عن RSS ضئيل ⇒ معظمها خاص) |
| Private Bytes خامل | p50 111.64 MB |
| CPU خامل | **0%** خلال 17 ثانية |
| Handles / Threads خامل | 273 / 24 |
| I/O تراكمي خامل | قراءة 5.0 MB، كتابة 0 MB |
| RSS بعد 6,000 طلب (c=50) | **213.08 MB** (PSS 212.81) |
| RSS بعد +3,000 طلب (c=20) | p50 334.3 MB، **max 358.75 MB**، نمو +53.6 MB أثناء العينة، لا هضبة أثناء الحمل |
| RSS بعد عودة الخمول (~10 دقائق) | **138.1 MB** (يعود جزئيًا لا كاملًا؛ خط الأساس 113.65 MB) |
| CPU تحت حمل | p50 غير موثوق (عدّاد Windows يعيد 0 متقطعًا)؛ p95 مُطبَّع على الآلة ≈ 116% ⇒ **إشباع نواة واحدة على الأقل** أثناء 135–216 req/s. العدّاد غير موثوق ويُذكر كتقدير لا كرقم دقيق |

**الخلاصة العملية:** القاعدة الخاملة خفيفة جدًا (113 MB)، لكن القمة تحت حمل 9,000 طلب بلغت 358.8 MB، ثم عادت بعد الخمول إلى 138.1 MB (لا تعود إلى 113). على حاوية 512 MB يتبقى ≈ 153 MB فقط عند أسوأ نقطة مقيسة؛ أي دفعة إضافية أو نمو heap قد تقتل العملية. **1 GB هو الحد الأدنى الآمن**، مع \`--max-old-space-size≈768\` ومراقبة PSS.

### سلوك حلقة الأحداث (Event loop)

لا يمكن قياس تأخير حلقة أحداث خادم قائم من الخارج دون أدوات داخلية أو إعادة تشغيل. الدليل غير المباشر: عند c=10 يرتفع زمن الصفحة من 7–9 ms إلى 66–68 ms، وعند c=50 إلى 309–318 ms مع p95 ≈ 328 ms، ويتوقف معدل النجاح عند 190–216 req/s مهما زاد التوازي (c=50 قدّم 216 rps فقط بينما c=20 قدّم 135.6 rps مع منافسة مولّد الحمل على نفس الجهاز). هذا نمط خادم أحادي الحلقة مشبع بضغط gzip والتصيير. **التوصية:** نقل الضغط إلى reverse proxy (Caddy/nginx) أو تخزين صفحات/ردود مضغوطة مسبقًا.

## 3) الكمون والإنتاجية (Latency)

**الطريقة:** \`node scripts/bench/measure-pages.mjs --base=http://127.0.0.1:3213\` — عميل \`node:http\` مع \`keep-alive\`، \`Accept-Encoding: gzip\`، 40 طلبًا متتاليًا لكل مسار عند c=1 ثم 200 طلب مختلط عند c=10 وc=50. كل الأرقام بالمللي ثانية (total).

### c=1 (متتالي، p50 / p95)

| المسار | الحالة | p50 | p95 | بايت (مضغوط) |
|---|---|---:|---:|---:|
| \`/\` | 200 | 8.1 | 11.5 | 3,311 |
| \`/workspace\` (بلا جلسة) | 307 | 9.3 | 12.4 | 2,623 |
| \`/history\` | 200 | 7.4 | 8.8 | 3,289 |
| \`/privacy\` | 200 | 7.2 | 9.0 | 4,290 |
| \`/admin\` (زائر) | 200 | 7.4 | 8.7 | 3,295 |
| \`/api/models\` | 200 | **2.3** | 2.7 | **13,456 (بلا ضغط)** |
| \`/api/admin/overview\` | **401** | 2.2 | 2.7 | 98 |
| \`GET /api/comparisons\` | **405** | 1.8 | 2.2 | 0 |
| صفحة غير موجودة | 404 | 6.8 | 7.8 | 3,311 |

### c=10 و c=50 (مختلط: 9 مسارات)

| التوازي | n | أخطاء | p50 | p95 | p99 | TTFB p50 | TTFB p95 | الإنتاجية |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 200 | 0 | 62.8 | 86.5 | 90.2 | 27.7 | 59.2 | **198.2 req/s** |
| 50 | 200 | 0 | 195.9 | 327.3 | 328.4 | 172.1 | 300.1 | **216.2 req/s** |
| 50 (حمل مستمر، 6,000 طلب) | 6,000 | 0 | 297.0 | 519.1 | 664.7 | 135.7 | — | **190 req/s** (31.6 ث) |
| 20 (3,000 طلب) | 3,000 | 0 | 158.0 | 283.5 | — | — | — | 135.6 req/s* |

\* أقل من c=50 لأن مولّد الحمل نفسه ينافس الخادم على 12 نواة؛ الرقم المحايد هو 190–216 rps.

عند c=10: الصفحات p50 ≈ 66.7–68.3 ms، وواجهات API p50 ≈ 6.5–11.1 ms. عند c=50: الصفحات p50 ≈ 308.8–317.7 ms وp95 ≈ 327–328 ms (سقف واضح)، وAPI p50 ≈ 65.8–71.1 ms.

**القياس المصادق غير مكتمل (متعمَّد النطاق):** `--session` يوقّع كوكي `chate_session` محليًا من `SESSION_SECRET` في `.env.local`، لكن فحص الجلسة في هذا البناء يتطلب أيضًا **صف مستخدم موجودًا في SQLite** (إضافة إلى `iat`)؛ الكوكي الموقّع لمستخدم غير موجود يُرَدّ إلى `null`، لذلك بقي `/workspace` 307 و`/api/admin/overview` 401 بدل 200/403. لم أنشئ مستخدمًا في القاعدة الحية (خارج نطاق الكتابة)، لذا **صفحات الجلسة الحقيقية غير مقيسة** وتُترك موسومة كغير مقيسة.

## 4) قاعدة البيانات (SQLite)

**الطريقة:** \`node scripts/bench/inspect-db.mjs --simulate=200\` على **نسخة** من \`data/chate.sqlite\` داخل \`scripts/bench/tmp/\`؛ فتح للقراءة فقط، ثم محاكاة نمو على نسخة منفصلة. لا كتابة على القاعدة الحية.

### 4.1 الحجم والحالة (مقيس اليوم)

| العنصر | القيمة |
|---|---|
| حجم الملف | 408.0 KB = 102 صفحة × 4,096 B |
| WAL أثناء النشاط | 96.6 KB (كان 0 قبل النشاط؛ \`wal_autocheckpoint=1000\` صفحة ⇒ سقف ~4 MB قبل checkpoint) |
| SHM | 32 KB |
| مساحة حرة | 0 صفحات حرة؛ \`VACUUM INTO\` = 408.0 KB (نسخة احتياطية) |
| \`integrity_check\` | ok |
| الصفوف الآن | users=4، profiles=4، retention_settings=1، alert_thresholds=7، schema_migrations=5، وبقية الجداول فارغة |
| الفهارس | 59 (19 صريح + autoindexes)، كل فهرس صفحة واحدة 4 KB ⇒ ~236 KB من الـ408 KB مخطط لا بيانات |

PRAGMAs الفعلية (\`src/server/db/connection.ts:16-19\`): \`journal_mode=wal\`، \`synchronous=NORMAL(2)\`، \`busy_timeout=5000\`، \`cache_size=-2000\` (**2 MB فقط**)، \`mmap_size=0\`، \`temp_store=0\`، \`foreign_keys=ON\`، \`wal_autocheckpoint=1000\`.

### 4.2 خطط الاستعلام (\`EXPLAIN QUERY PLAN\` على النسخة)

| الاستعلام (المصدر) | الخطة | تقييم |
|---|---|---|
| قراءة الملف الشخصي (\`src/server/db/profiles.ts:24\`) | SEARCH users by id + SEARCH profiles by user_id | جيد |
| هوية الأدمن (\`src/server/admin/identity.ts:8\`) | SEARCH users by google_sub | جيد |
| مقارنة بمفتاح idempotency (\`store.ts:257\`) | SEARCH comparisons on (user_id, idempotency_key) | جيد |
| قراءة مقارنة (\`store.ts:94\`) | SEARCH comparisons by id | جيد |
| قراءة التشغيلات (\`store.ts:342\`) | SEARCH model_runs by comparison_id + TEMP B-TREE للترتيب | مقبول (4–8 صفوف فقط) |
| بيانات المقارنة الوصفية (\`store.ts:126\`) | SEARCH c by id + SEARCH j by unique key | جيد |
| حصة/حجوزات/مهام idempotency | SEARCH بالـUNIQUE/covering indexes | جيد |
| سحب مهمة (\`src/server/db/jobs.ts:7\`) | SCAN jobs USING jobs_queued_idx (فهرس جزئي) | جيد؛ لا يمس الجدول كله عمليًا |
| إعادة المهام القديمة (\`jobs.ts:68\`) | **SCAN jobs** | فقط عند إقلاع العامل؛ مقبول اليوم |
| قائمة تدقيق الأدمن (\`overview.ts:204\`) | **SCAN admin_audit_events + TEMP B-TREE** | ينمو خطيًا؛ ناقص فهرس \`created_at\` |
| مجموع الملفات (\`overview.ts:199\`) | **SCAN files** | مقبول (تجميع) |
| عدّ الأسئلة/الأخطاء في لوحة الإدارة | covering index على \`operation_stats_latency_idx\` | جيد |
| صفحة مستخدمي الإدارة (\`users.ts:97\`) | SCAN users + 3 استعلامات مرتبطة لكل صف (≈25 صفًا ⇒ 75 بحثًا مفهرسًا) | N+1 منطقي داخل SQL؛ مقبول لصفحة إدارية، وليس في مسار المستخدم |

لا يوجد N+1 في مسار المستخدم: قراءة المقارنة = استعلامان مفهران، والتشغيلات استعلام واحد لكل مقارنة. الكتابة الأثقل: كل \`recordOperation\` تنفّذ **4 كتابات** (\`operation_stats\` + \`operation_buckets\` + \`latency_histogram\` ×2) بلا معاملة جامعة (\`src/server/admin/operations.ts:38-71\`) ⇒ مقارنة بـ4 نماذج ≈ 24 كتابة إحصاء + 9 كتابات للحجز/الاعتماد + 4 تحديثات نتائج + 1 تحديث نشاط ≈ **~38 عملية كتابة لكل مقارنة** (بعضها داخل معاملات، والإحصاءات خارجه).

### 4.3 النمو والتخزين (محاكاة مقيسة)

محاكاة 200 مقارنة على نسخة معزولة (افتراضات مطبوعة في المخرجات: 3 OpenRouter + Haiku، سؤال 120 حرفًا، إجابة 1,200 حرف/نموذج، لقطة 196 B، 6 صفوف إحصاء/مقارنة):

| المقياس | القيمة |
|---|---|
| النمو الكلي | +3,816 KB لـ200 مقارنة |
| لكل مقارنة | **19.1 KB** |
| لكل 1,000 مقارنة | **19.1 MB** |
| أكبر المساهمين | \`model_runs\` 3,212 KB (84%)، \`operation_stats\` 116 KB، \`evidence_snapshots\` 80 KB، \`comparisons\` 72 KB، فهارس ~228 KB |

**الإسقاط:** 1,000 مقارنة/يوم ⇒ ~19 MB/يوم ≈ 0.58 GB/شهر؛ 10,000/يوم ⇒ 5.8 GB/شهر. مع بقاء البيانات افتراضيًا 90 يومًا (\`retention_settings\`) يصبح الحد المتوقع 1.7 GB لكل 1,000/يوم؛ لكن **لا يوجد أي مشغّل حذف**، فالنمو غير محدود فعليًا.

### 4.4 فجوة الاحتفاظ (مؤكدة بالكود)

\`retention_settings\` يُكتب في \`001_init.sql\` (comparison_days=90، file_days=30) لكن **لا يوجد قارئ له**. \`grep DELETE FROM\` في \`src/\` لا يجد سوى \`turnstile_tokens\` و\`presence\` و\`sessions\` عند إيقاف مستخدم. لا حذف لـ: comparisons، model_runs، evidence_snapshots، operation_stats/buckets/histogram، files، jobs المكتملة، sessions المنتهية. \`scripts/worker.ts\` لا ينفّذ أي تنظيف دوري.

## 5) ملف الموارد وأصغر نشر آمن

### 5.1 الأرقام المرجعية

| البند | القيمة |
|---|---|
| ذاكرة خاملة (PSS) | ≈ 113 MB |
| ذاكرة تحت حمل (مقيسة) | 213–359 MB RSS قمة، تعود إلى 138 MB بعد الخمول |
| زمن إقلاع | 0.46 s + 0.11 s إعداد |
| إنتاجية سقف (صفحات 3–4 KB مضغوطة) | 190–216 req/s على 12 نواة؛ حلقة واحدة ⇒ على 1 vCPU توقّع 100–200 req/s |
| حد التوازي للمقارنات | \`MAX_GLOBAL_CONCURRENCY=8\` (افتراضي، \`src/server/db/quota.ts:46\`) |
| كتابات SQLite/مقارنة | ≈ 38 عملية منطقية (بعضها معاملات) |
| نمو القرص/1k مقارنة | 19.1 MB |
| نسخة احتياطية الآن | 408 KB (VACUUM INTO) |

### 5.2 الأدنى الآمن

**التوصية: 1 vCPU / 1 GB RAM / 20 GB SSD محلي / عملية Next واحدة (+ العامل اختياريًا).**

- 512 MB: **غير آمن** بناءً على 359 MB RSS تحت حمل لم يعد فيه هضبة؛ يتبقى ≈153 MB فقط. مسموح فقط لـstaging/كاناري مع \`MAX_GLOBAL_CONCURRENCY≤2\` و\`--max-old-space-size=384\` ومراقبة PSS.
- 1 GB: آمن مع \`NODE_OPTIONS=--max-old-space-size≈768\`؛ الحد الأقصى المقيس 359 MB يترك ~650 MB.
- vCPU: 1 كافية لـ8 مقارنات متزامنة لأن انتظار المزوّد غير متزامن (I/O)، لكن ضغط gzip/التصيير يشبع النواة عند ~200 req/s. سِجلات أعلى تحتاج 2 vCPU أو نقل الضغط إلى proxy.
- القرص: SSD محلي (لا NFS/SMB — \`data/chate.sqlite\` يحتاج WAL/fsync محليين). 20 GB تكفي: 90 يومًا من 1,000 مقارنة/يوم ≈ 1.7 GB + مساحة للنمو والنسخ.
- الشبكة: مزوّدات LLM صادرة فقط؛ لا Redis ولا Postgres ولا Docker.
- Worker: عملية منفصلة خفيفة (~50–70 MB متوقعة كتقدير، لم تُقَس لأن تشغيله يعدّل القاعدة).

### 5.3 الرياضيات الاستيعابية

- المقارنة الواحدة تُبقي 8 مهام قصوى؛ زمن نموذجي **افتراض** 20–30 ثانية ⇒ سقف نظري 8/25 ≈ **0.32 مقارنة/ث** ≈ 19/دقيقة ≈ 27,600/يوم.
- الاستطلاع الحالي (polling) يضيف ~0.83 طلب/ث لكل مقارنة نشطة (\`src/components/workspace.tsx:101-121\` كل 1.2 ث) ⇒ عند 8 نشطة ≈ 6.6 req/s، أي <4% من سقف 190 req/s. الاستطلاع ليس خطرًا على الإنتاجية الحالية، لكنه يستهلك CPU/بطارية على العميل.
- مستخدمون متزامنون: صفحة خفيفة تكلّف 7–9 ms على c=1. سقف ~190–216 req/s يعني ~190 جلسة/ث في أسوأ الحالات لو كل جلسة طلب/ث؛ عمليًا عنق الزجاجة هو مقارنات المزوّد (8) وليس الصفحات.

### 5.4 التكلفة لكل 1,000 مقارنة

- **البنية التحتية:** VPS 1 vCPU/1GB ≈ \$5–7/شهر. الوحدة الحاسوبية لـ1,000 مقارنة ضئيلة: ~38 كتابة + ~5–10 ms عمل DB لكل مقارنة ⇒ ثوانٍ معدودة ⇒ أقل من **\$0.001** حوسبة.
- **التخزين:** 19.1 MB/1,000 مقارنة. بتكلفة تقديرية \$0.05–0.10/GB-شهر ⇒ **\$0.001–0.002** شهريًا لكل 1,000 (تتراكم مع الاحتفاظ).
- **الخروج (egress):** لا تُنقل إجابات النماذج للعميل إلا عند الطلب؛ ليست بنودًا كبيرة.
- **المزوّدون:** النماذج المجانية \$0، وClaude Haiku محاسبة منفصلة لا تُقاس هنا (لا استدعاء حي). **تكلفة المزوّد هي المسيطر الحقيقي** — يجب حسابها من أسعار Anthropic الفعلية، لا من هذا التقرير.
- **الإجمالي المقيس/المُقدّر للبنية التحتية: أقل من \$0.01 لكل 1,000 مقارنة** (تقدير؛ مصدره أسعار VPS افتراضية وليس فاتورة).

## 6) التحسينات المرتبة (بالتأثير/الجهد/الخطر)

التفاصيل والمقترحات القابلة للتطبيق في \`docs/audit/PERFORMANCE-QUICKWINS.md\` و\`scripts/bench/proposals/PROPOSALS.md\`.

| # | التحسين | التأثير المقدر | الجهد | الخطر |
|---|---|---|---|---|
| 1 | حذف 11 حزمة غير مستوردة | -13.4 MB تثبيت، تثبيت/CI أسرع | منخفض | منخفض |
| 2 | ضغط JSON (\`/api/models\` 13.4 KB ⇒ ~2.5 KB gz) | -80% على كل تحميل مساحة عمل | منخفض | منخفض |
| 3 | فهارس/واجهات SSE بدل polling (1.2s) | -80–90% طلبات أثناء المقارنة | متوسط | متوسط |
| 4 | تقليص الخطوط/الأوزان/المجموعات | -28–40 KB من أول تحميل (12–17%) | منخفض | منخفض |
| 5 | PRAGMAs: cache_size 16MB، mmap 64–256MB | قراءات أسرع مع نمو DB | منخفض جدًا | منخفض |
| 6 | مشغّل احتفاظ يومي | يوقف النمو غير المحدود (19 MB/1k) | متوسط | متوسط |
| 7 | تجميع كتابات الإحصاء في معاملة واحدة | -كتابة WAL/fsync، CPU أقل | منخفض | منخفض |
| 8 | \`cache()\` لجلسة React (تجنب تحقق مكرر) | -1 استعلام DB/تحميل لمسجل | منخفض | منخفض |
| 9 | فهرس \`admin_audit_events(created_at DESC)\` | قائمة تدقيق O(log n) بدل SCAN | منخفض جدًا | منخفض |
| 10 | نقل gzip إلى reverse proxy / ردود مضغوطة مسبقًا | يقلل إشباع النواة عند c≥10 | متوسط | منخفض |
| 11 | تفعيل Bundle Analyzer في CI | حماية من انحدار الحزم | منخفض | منخفض |

## 7) ملاحق المنهجية

- كل الأوامر قابلة لإعادة التشغيل من \`scripts/bench/README.md\`. المخرجات الخام: \`scripts/bench/tmp/build-stats.json\` و\`pages-anon-*.json\` و\`pages-session-*.json\` و\`rss-*.json\` و\`db.json\`.
- لم يُشغّل \`npm run build\` ولا \`next dev/start\` من هذا التقرير (الLead يملك دورة الخادم). القياس كان على خادم إنتاجي جاهز على 3213.
- لم تُقرأ/تُطبع أي أسرار؛ محاولة الجلسة الموقعة استخدمت HMAC محليًا لكن الخادم يتطلب صف مستخدم موجودًا، فلم تُستخدم نتائجها. صفحات الجلسة الديناميكية **غير مقيسة** وليست ضمن أي رقم في التقرير.
- \`pss\` يُحسب بـ\`QueryWorkingSetEx\`؛ لو فشل جمع C# يسقط السكربت إلى RSS فقط.
- قياسات الشبكة الخارجية (سكربتات GIS/Turnstile) تعتمد على CDN وقت القياس وليست ثابتة.
