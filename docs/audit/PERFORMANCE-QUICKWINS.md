# أسرع 10 تحسينات منخفضة التكلفة — ChatE

مرتبة بالأثر/الجهد. كل بند يذكر المكسب المتوقع (مقيس أو تقديري بصراحة) وطريقة تحقّق قابلة للتشغيل. القياسات المرجعية في \`docs/audit/PERFORMANCE-RESOURCES.md\`.

## 1) حذف 11 حزمة runtime غير مستوردة
- **الوفر:** ≈ 13.4 MB تثبيت + وقت تثبيت/CI (صفر بايت من حزمة المتصفح؛ وليست سببًا في البطء الحالي).
- **التنفيذ:** احذف من \`package.json\`: \`@tremor/react\`, \`@tanstack/react-table\`, \`jszip\`, \`mammoth\`, \`word-extractor\`, \`unpdf\`, \`zod\`, \`tailwind-merge\`, \`@radix-ui/react-slot\`, \`class-variance-authority\`, \`clsx\` (تأكد أولًا أن \`src/\` لا يستوردها: \`node scripts/bench/build-stats.mjs\` يطبع \`DEAD RUNTIME DEPENDENCIES\`). أزل أيضًا \`serverExternalPackages\` غير المستخدم من \`next.config.ts:8-15\`.
- **التحقق:** \`node scripts/bench/build-stats.mjs\` ⇒ \`deadRuntime = []\`؛ \`npm ls --depth=0\` نظيف؛ \`npm run build\` ثم مقارنة أحجام \`.next/static\` (يجب ألا يتغير).

## 2) ضغط ردود JSON (خاصة \`/api/models\`)
- **المشكلة المقيسة:** \`/api/models\` = 13,456 بايت على السلك باسم \`content-encoding: identity\`؛ صفحات HTML تُضغط gzip إلى 3,311 بايت. \`/api/models\` يُطلب عند كل فتح لمساحة العمل (\`src/components/workspace.tsx:47-52\`).
- **التنفيذ:** غلاف صغير في \`jsonOk\` بإعادة استخدام \`node:zlib.gzipSync\` عند وجود \`accept-encoding: gzip\`، و\`Vary: Accept-Encoding\`. (مقترح كامل في \`scripts/bench/proposals/PROPOSALS.md\`.)
- **الوفر:** 13.4 KB ⇒ ~2.4 KB gzip (~82%) لكل تحميل مساحة عمل؛ أخف على 3G/جوال.
- **التحقق:** \`curl -s -D - -o NUL -H 'Accept-Encoding: gzip' http://127.0.0.1:3213/api/models\` يجب أن يعرض \`content-encoding: gzip\` وحجمًا أصغر؛ \`measure-pages.mjs --only=api-models\` يعرض \`bytes\` الجديد.

## 3) استبدال polling كل 1.2s بـ SSE/Streaming
- **المشكلة:** \`src/components/workspace.tsx:101-121\` يستطلع \`GET /api/comparisons/[id]\` كل 1.2 ثانية؛ كل استطلاع = استعلامان مفهران + JSON. عند 8 مقارنات نشطة ≈ 6.6 req/s إضافية، مع زمن p50 ≈ 2–3 ms للطلب.
- **الحل:** \`GET /api/comparisons/[id]/events\` يعيد \`text/event-stream\` ويدفع عند تغيّر حالة كل run (يُبنى على \`markRunRunning/saveRunResult\` في \`src/server/comparisons/store.ts\`)؛ إبقاء polling كـfallback.
- **الوفر التقديري:** 80–90% من طلبات الاستطلاع؛ CPU أقل وتجربة فورية. (تقدير، لم يُنفَّذ/يُقَس.)
- **التحقق:** عدّ الطلبات في \`logs\`/middleware لعدّاد قبل/بعد، وزمن ظهور أول إجابة؛ \`measure-pages --only=workspace-authed\` يبقى ثابتًا.

## 4) تقليص الخطوط من أول تحميل
- **المشكلة المقيسة:** 4 ملفات woff2 = **96.1 KB** من أصل 237.9 KB gzip لأول تحميل (40%).
- **التنفيذ:** في \`src/app/layout.tsx:9-15\`: إبقاء \`subsets: ["arabic"]\` فقط إن كان النص اللاتيني نادرًا، والوزنين 400/600 إن لزم؛ أو استخدام \`preload: false\` للمجموعة اللاتينية. الملفان العربي 32.7+35.0 KB مقابل اللاتيني 13.6+14.7 KB.
- **الوفر:** ~28 KB إن حُذف اللاتيني بالكامل، أو ~48 KB إن بقي وزن واحد عربي فقط، لكل أول تحميل (12–20%).
- **التحقق:** \`node scripts/bench/build-stats.mjs\` ⇒ عدد/حجم \`FONTS\`؛ \`next-font-manifest.json\` بعد البناء؛ فحص بصري عربي/LTR.

## 5) PRAGMAs لـSQLite
- **الحالة المقيسة:** \`cache_size=-2000\` (2 MB فقط)، \`mmap_size=0\`، \`temp_store=0\`، \`synchronous=NORMAL\`، WAL.
- **التنفيذ** في \`src/server/db/connection.ts:16-19\`:
  \`\`\`ts
  db.exec("PRAGMA cache_size = -16000");        // 16 MB page cache
  db.exec("PRAGMA mmap_size = 268435456");      // 256 MB address space map
  db.exec("PRAGMA temp_store = MEMORY");
  \`\`\`
- **الوفر:** قراءات فهرس أسرع مع نمو القاعدة (لا تغيير ملموس اليوم لأن DB 408 KB)؛ يمنع انحدارًا عند 100k+ صف. الاستهلاك +16 MB RSS تقريبًا.
- **التحقق:** \`node scripts/bench/inspect-db.mjs\` يطبع PRAGMAs الجديدة؛ \`measure-pages --only=...\` قبل/بعد؛ \`explain\` يبقى كما هو.

## 6) مشغّل احتفاظ (Retention runner)
- **المشكلة المؤكدة:** \`retention_settings\` (90/30 يومًا) مكتوب ولا يُقرأ؛ لا حذف لأي جدول أعمال. النمو المقيس **19.1 KB/مقارنة ⇒ 19.1 MB/1,000**، بلا سقف.
- **التنفيذ:** دالة \`pruneRetention(db, now)\` تُشغَّل من \`scripts/worker.ts\` كل ساعة/يوم: حذف \`comparisons\` الأقدم من 90 يومًا (CASCADE يحذف \`model_runs/evidence_snapshots\`)، \`operation_stats\`/\`operation_buckets\`/\`latency_histogram\` الأقدم من 90، \`jobs\` المكتملة >7 أيام، \`sessions\` المنتهية، \`turnstile_tokens\` المنتهية، ثم \`PRAGMA incremental_vacuum\` إن فُعّل \`auto_vacuum\`. SQL مقترح في \`scripts/bench/proposals/PROPOSALS.md\`.
- **الوفر:** يحوّل النمو الخطي إلى نافذة ثابتة (≈1.7 GB لكل 1k/يوم × 90 يومًا)؛ يقلل النسخ الاحتياطي وزمن checkpoint.
- **التحقق:** على نسخة: \`inspect-db.mjs\` بعد إدخال صفوف قديمة يظهر نقصان \`rows/oldest\`؛ \`PRAGMA integrity_check\`؛ قياس حجم الملف قبل/بعد 30 يومًا محاكاة.

## 7) تجميع كتابات الإحصاء في معاملة واحدة
- **المشكلة:** كل \`recordOperation\` = 4 كتابات مستقلة بلا معاملة جامعة (\`src/server/admin/operations.ts:38-71\`): \`operation_stats\` + \`operation_buckets\` + \`latency_histogram\` ×2؛ مقارنة 4 نماذج ≈ 24 كتابة إحصاء. \`synchronous=NORMAL\` يخفف fsync لكن الكتابة لا تزال WAL append + B-tree.
- **التنفيذ:** لفّ \`recordOperation\` (أو نداءات \`recordAcceptedComparison\`+\`recordModelInvocation\` لمقارنة) داخل \`immediateTransaction\` واحدة؛ يمكن أيضًا دمج إدراج السجل والـbucket في استعلام واحد عبر CTE? المستحسن: معاملة + إعادة استخدام prepared statements.
- **الوفر التقديري:** 3–5× أقل كتابات/التزامات لكل مقارنة؛ CPU كتابة أقل عند التزامن.
- **التحقق:** \`inspect-db.mjs\` لا يقيس WAL/ثانية؛ استخدم \`measure-resources --duration\` تحت حمل مقارنات مزيفة (بدون مزوّد) أو عدّاد WAL عبر \`PRAGMA wal_checkpoint(PASSIVE)\` قبل/بعد.

## 8) تجنب التحقق المكرر من الجلسة في كل تصيير
- **المشكلة:** \`src/app/layout.tsx:24-25\` يتحقق من الجلسة ثم \`currentAdmin()\` (\`src/server/admin/current.ts:8\`) يتحقق مرة أخرى ويستعلم \`users\`، ثم الصفحة (\`src/app/page.tsx:6\`, \`workspace/page.tsx:6\`) تتحقق ثالثة. HMAC ثلاث مرات + استعلام DB للمسجل.
- **الحل:** لفّ \`readGoogleSession\` بـ\`cache()\` من React داخل وحدة مشتركة، وتمرير نتيجة \`currentAdmin\` من التخطيط عبر context/بروب بدل الاستدعاء المكرر.
- **الوفر المقيس تقريبًا:** HMAC-SHA256 على ≤2 KB (أجزاء من مللي ثانية) + استعلام DB مفهرس واحد لكل تحميل لمسجل. تحسين صغير لكنه رخيص.
- **التحقق:** عدّاد استعلامات في بيئة التطوير أو \`EXPLAIN\`/log؛ قياس \`/workspace\` بجلسة قبل/بعد (يحتاج مفتاح جلسة صحيحًا).

## 9) فهرس \`admin_audit_events(created_at DESC)\`
- **المشكلة المقيسة:** \`EXPLAIN\` يظهر \`SCAN admin_audit_events + TEMP B-TREE\` (\`src/server/admin/overview.ts:204\`)؛ \`005_indexes.sql\` أضاف فهرسًا على \`(target, created_at)\` فقط.
- **التنفيذ (هجرة 006):** \`CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit_events (created_at DESC);\`
- **الوفر:** قائمة آخر 20 حدثًا O(log n) بدل مسح كامل؛ يظهر عند آلاف الأحداث.
- **التحقق:** \`inspect-db.mjs\` (خطط) يعرض \`SEARCH ... USING INDEX admin_audit_created_idx\` بلا TEMP B-TREE.

## 10) نقل ضغط gzip إلى reverse proxy أو ردود مضغوطة مسبقًا
- **المشكلة:** عند c=10 قفز زمن الصفحة من 7–9 ms إلى 66–68 ms، وعند c=50 إلى ~310 ms مع p95 ≈ 328 ms وسقف إنتاجية 190–216 req/s. ضغط HTML يتم داخل حلقة Next الواحدة (gzip 3.3 KB/page).
- **التنفيذ:** Caddy/nginx يضغط الاستجابات (gzip/brotli) ويمرر HTTP/2، مع \`Accept-Encoding\`؛ أو تخزين صفحات ديناميكية مضغوطة مسبقًا غير ممكن بأمان مع الكوكيز، فالأفضل proxy. يحتاج نشرًا.
- **الوفر التقديري:** توفير CPU لنواة Next ورفع السقف أو خفض p95 عند التزامن؛ يحتاج قياسًا بعد النشر.
- **التحقق:** \`measure-pages.mjs --concurrency=10,50\` قبل/بعد (نفس الجهاز)؛ \`measure-resources\` لـCPU؛ تأكد \`content-encoding: br/gzip\`.

---

### تحقّق شامل بعد أي دفعة تغييرات
\`\`\`powershell
node scripts/bench/build-stats.mjs --json
node scripts/bench/measure-pages.mjs --base=http://127.0.0.1:3213 --concurrency=1,10,50 --requests=100
node scripts/bench/measure-resources.mjs --port=3213 --duration=20
node scripts/bench/inspect-db.mjs --simulate=200
node scripts/bench/check-client-bundle.ts   # npm run check:bundle (فحص أسرار الحزمة)
\`\`\`
