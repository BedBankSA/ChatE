# مقترحات تصحيحات (لا تُطبَّق من هذا التقرير) — ChatE perf

هذه مقاطع diff جاهزة للدمج في \`src/\`. لم تُطبَّق هنا احترامًا لنطاق الكتابة (\`scripts/bench/**\` + \`docs/audit/**\`). كل بند يشير إلى الملف والسطر والقياس المرتبط في \`docs/audit/PERFORMANCE-RESOURCES.md\`.

## P1 — PRAGMAs لـSQLite (\`src/server/db/connection.ts:16-19\`)

\`\`\`diff
   db.exec("PRAGMA foreign_keys = ON");
   db.exec("PRAGMA journal_mode = WAL");
   db.exec(\`PRAGMA busy_timeout = \${timeoutMs}\`);
   db.exec("PRAGMA synchronous = NORMAL");
+  // 2 MB page cache is the SQLite default; 16 MB keeps the hot indexes in
+  // memory as comparisons/operation_stats grow. mmap removes a copy per read.
+  db.exec("PRAGMA cache_size = -16000");
+  db.exec("PRAGMA mmap_size = 268435456");
+  db.exec("PRAGMA temp_store = MEMORY");
   return db;
\`\`\`

## P2 — ضغط ردود JSON (\`src/server/http.ts\`)

\`\`\`diff
+import { gzipSync } from "node:zlib";
+
+function acceptsGzip(request: Request | undefined): boolean {
+  return request != null && (request.headers.get("accept-encoding") ?? "").includes("gzip");
+}
+
+export function jsonOk(data: unknown, status = 200, request?: Request): Response {
+  const body = JSON.stringify({ ok: true, data, error: null });
+  if (status === 200 && acceptsGzip(request) && body.length >= 1024) {
+    const compressed = gzipSync(Buffer.from(body), { level: 6 });
+    return new Response(compressed, {
+      status,
+      headers: {
+        "content-type": "application/json",
+        "content-encoding": "gzip",
+        "vary": "Accept-Encoding",
+        "content-length": String(compressed.length),
+      },
+    });
+  }
+  return Response.json({ ok: true, data, error: null }, { status });
+}
\`\`\`

ويُمرَّر \`request\` من المسارات: \`src/app/api/models/route.ts\` (\`GET(request)\` و\`jsonOk(listPublicModels(), 200, request)\`)، والمسارات الأخرى التي تستخدم \`jsonOk\`. (لا تُضغط ردود 401/403/405 الصغيرة.)

## P3 — تحقق واحد من الجلسة لكل طلب (\`src/server/google-session.ts\` + \`src/app/layout.tsx:22-26\`)

\`\`\`diff
 import { cookies } from "next/headers";
+import { cache } from "react";
 import { readCookieSession, type SessionPayload } from "@/domain/auth/session";
 
-export async function readGoogleSession(nowSec = Math.floor(Date.now() / 1000)): Promise<SessionPayload | null> {
+export const readGoogleSession = cache(async (nowSec = Math.floor(Date.now() / 1000)): Promise<SessionPayload | null> => {
   const token = (await cookies()).get("chate_session")?.value;
   return readCookieSession(token, process.env.SESSION_SECRET, nowSec);
-}
+});
\`\`\`

و\`currentAdmin\` يستقبل الجلسة كوسيط اختياري (\`src/server/admin/current.ts:6-10\`) حتى لا يعيد التحقق. الجذر \`layout.tsx\` يستدعي \`readGoogleSession()\` مرة واحدة ويستخدمها للصفحة بدل الاستدعاء المكرر في \`page.tsx:6\`/\`workspace/page.tsx:6\`.

## P4 — مشغّل الاحتفاظ + فهرس التدقيق (هجرة 006 + عامل)

\`\`\`sql
-- migrations/006_retention.sql
CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS comparisons_created_idx ON comparisons (created_at);
CREATE INDEX IF NOT EXISTS operation_stats_occurred_idx ON operation_stats (occurred_at);
\`\`\`

\`\`\`ts
// src/server/db/retention.ts (جديد)
import type { DatabaseSync } from "node:sqlite";
import { immediateTransaction } from "@/server/db/transaction";

export function pruneRetention(db: DatabaseSync, now: Date): { comparisons: number; operations: number; jobs: number } {
  const nowIso = now.toISOString();
  const row = db.prepare("SELECT comparison_days, file_days FROM retention_settings WHERE id = 1").get();
  const comparisonDays = typeof row?.comparison_days === "number" ? row.comparison_days : 90;
  const cutoff = new Date(now.getTime() - comparisonDays * 86_400_000).toISOString();
  const jobCutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  return immediateTransaction(db, () => {
    // CASCADE removes evidence_snapshots / model_runs / usage rows for the comparison.
    const comparisons = db.prepare("DELETE FROM comparisons WHERE created_at < ?").run(cutoff).changes;
    const operations = db.prepare("DELETE FROM operation_stats WHERE occurred_at < ?").run(cutoff).changes;
    db.prepare("DELETE FROM operation_buckets WHERE bucket_start < ?").run(cutoff);
    db.prepare("DELETE FROM latency_histogram WHERE bucket_start < ?").run(cutoff);
    const jobs = db.prepare("DELETE FROM jobs WHERE status IN ('completed','failed') AND finished_at IS NOT NULL AND finished_at < ?").run(jobCutoff).changes;
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowIso);
    db.prepare("DELETE FROM turnstile_tokens WHERE expires_at <= ?").run(nowIso);
    db.prepare("DELETE FROM presence WHERE expires_at <= ?").run(nowIso);
    return { commit: true, value: { comparisons, operations, jobs } };
  });
}
\`\`\`

ثم في \`scripts/worker.ts\` حلقة كل 60 دقيقة:\`pruneRetention(opened.db, new Date())\`، مع تسجيل النتائج. **تحذير:** الحذف نهائي؛ يجب اختبار التاريخ على نسخة ومراجعة الـLead.

## P5 — تقليل خطوط أول تحميل (\`src/app/layout.tsx:9-15\`)

\`\`\`diff
 const plexArabic = IBM_Plex_Sans_Arabic({
-  subsets: ["arabic", "latin"],
+  // The product UI is Arabic-first; latin glyphs are only used by model ids
+  // inside LTR spans, which fall back to Segoe UI/Tahoma acceptably.
+  subsets: ["arabic"],
   weight: ["400", "600"],
   display: "swap",
   fallback: ["Segoe UI", "Tahoma", "sans-serif"],
   variable: "--font-plex",
 });
\`\`\`

\`display: "swap"\` مثبت بالفعل. البديل الأقل تطرفًا: \`preload: false\` للمجموعة اللاتينية فقط.

## P6 — تجميع كتابات الإحصاء في معاملة (\`src/server/admin/operations.ts:38-71\`)

\`\`\`diff
-export function recordOperation(db: DatabaseSync, draft: OperationDraft): boolean {
+export function recordOperation(db: DatabaseSync, draft: OperationDraft): boolean {
+  // One implicit transaction per call was costing 3 extra WAL appends and a
+  // commit per operation; two model runs can be recorded per dispatch.
+  return recordOperationBatch(db, [draft]);
+}
+
+export function recordOperationBatch(db: DatabaseSync, drafts: OperationDraft[]): boolean {
+  return immediateTransaction(db, () => {
+    let changed = 0;
+    for (const draft of drafts) changed += recordOne(db, draft) ? 1 : 0;
+    return { commit: changed > 0, value: changed > 0 };
+  });
+}
+
+function recordOne(db: DatabaseSync, draft: OperationDraft): boolean {
\`\`\`
(يُعاد استخدام \`recordOne\` لجسم الدالة الحالي بعد إزالة السطر الأول؛ نفس المنطق.)

## P7 — Bundle analyzer + ميزانية حزم في CI

\`next.config.ts\` (Next 16.1+ يدعم analyzer تجريبيًا؛ راجع \`node_modules/next/dist/docs\` قبل التفعيل):
\`\`\`ts
const nextConfig: NextConfig = {
  // experimental: { bundleAnalyzer: true },
  ...
};
\`\`\`
وبديلًا بلا مخاطرة: تشغيل \`node scripts/bench/build-stats.mjs --json\` في CI ومقارنة \`routes[].firstLoad\` بعتبة (مثلًا +5% يفشل). لا يحتاج بناءً إضافيًا إذا وُجد \`.next\` من خطوة البناء.

## P8 — SSE بدل polling (تغيير أكبر؛ لا يُطبَّق قبل P1–P7)

- مسار جديد \`src/app/api/comparisons/[id]/events/route.ts\` يعيد \`ReadableStream\` بـ\`text/event-stream\` ويرسل حدثًا عند تغيّر أي \`model_runs.status\`؛ يقرأ كل ~1 ثانية من SQLite (استعلام واحد) بدل استعلامين لكل طلب عميل، ويوقف الاتصال عند \`closed\`.
- في \`src/components/workspace.tsx:92-121\` يستبدل \`setInterval\` بـ\`EventSource\` مع fallback إلى polling عند فشل الاتصال.
- القياس المتوقع: من ~0.83 طلب/ث لكل مقارنة نشطة إلى اتصال واحد؛ يقلّل CPU بنسبة صغيرة لكنه يحسّن زمن الظهور ويقلل بطارية الجوال.
