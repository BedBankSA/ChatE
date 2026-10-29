import Link from "next/link";
import { GoogleIntentButton } from "@/components/google-intent";
import { runStatusText } from "@/domain/comparison/view";
import {
  encodeHistoryCursor,
  HISTORY_PAGE_SIZE,
  listComparisons,
  type HistoryItem,
} from "@/server/comparisons/history";
import { getDatabase } from "@/server/db/runtime";
import { readGoogleSession } from "@/server/google-session";
import { redirectUnverifiedToVerifyPhone } from "@/server/phone/gate";
import { formatHistoryDate, truncateQuestion } from "@/app/history/format";

export const dynamic = "force-dynamic";

type HistorySearch = Record<string, string | string[] | undefined>;

const ANONYMOUS_TEXT = "يظهر هنا سجل حسابك بعد تسجيل الدخول.";
const LOAD_ERROR = "تعذر قراءة سجل المقارنات الآن. أعد المحاولة لاحقًا.";
const EMPTY_TEXT = "لا توجد مقارنات محفوظة بعد. ابدأ مقارنة من مساحة العمل ليظهر سجلها هنا.";
const EMPTY_OLDER_TEXT = "لا توجد مقارنات أقدم من هذه الصفحة.";
const OLDER_LABEL = "مقارنات أقدم";
const NEWEST_LABEL = "أحدث المقارنات";

function firstValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return firstValue(value[0]);
  return null;
}

export default async function HistoryPage({ searchParams }: { searchParams: Promise<HistorySearch> }) {
  const session = await readGoogleSession();
  if (!session) {
    return (
      <section className="shell reading">
        <article className="card">
          <h1>سجل المقارنات</h1>
          <p>{ANONYMOUS_TEXT}</p>
          <GoogleIntentButton />
        </article>
      </section>
    );
  }

  // Product surfaces are gated: an unverified account verifies first, then
  // returns to the same history URL.
  await redirectUnverifiedToVerifyPhone("/history");
  const query = await searchParams;
  const before = firstValue(query.before);
  let rows: HistoryItem[] = [];
  let hasMore = false;
  let loadError = false;
  try {
    // One extra row only tells the page whether an older page exists; the
    // contract still shows at most 20 rows per page.
    const page = listComparisons(getDatabase(), session.userId, {
      limit: HISTORY_PAGE_SIZE + 1,
      ...(before ? { before } : {}),
    });
    rows = page.slice(0, HISTORY_PAGE_SIZE);
    hasMore = page.length > HISTORY_PAGE_SIZE;
  } catch {
    loadError = true;
  }
  const last = rows[rows.length - 1];
  const olderHref = last ? `/history?before=${encodeURIComponent(encodeHistoryCursor(last))}` : null;

  return (
    <section className="shell reading">
      <h1>سجل المقارنات</h1>
      {!loadError && rows.length > 0 ? (
        <p className="meta">أحدث {rows.length} مقارنة محفوظة لحسابك، من الأحدث إلى الأقدم.</p>
      ) : null}
      {loadError ? (
        <article className="card">
          <p>{LOAD_ERROR}</p>
        </article>
      ) : null}
      {!loadError && rows.length === 0 ? (
        <article className="card">
          <p>{before ? EMPTY_OLDER_TEXT : EMPTY_TEXT}</p>
          {before ? <Link className="btn secondary" href="/history">{NEWEST_LABEL}</Link> : <Link className="btn" href="/workspace">ابدأ مقارنة</Link>}
        </article>
      ) : null}
      {rows.map((row) => (
        <article className="card" key={row.id}>
          <h2>
            <Link href={`/history/${row.id}`}>{truncateQuestion(row.question)}</Link>
          </h2>
          <p className="meta">
            {formatHistoryDate(row.createdAt)} · {runStatusText(row.status)}
          </p>
          <p className="meta">
            النتائج: {row.runCount} · اكتمل: {row.completedCount}
          </p>
          {row.modelIds.length > 0 ? <p className="meta ltr">{row.modelIds.join(" · ")}</p> : null}
          <Link className="btn secondary" href={`/history/${row.id}`}>التفاصيل</Link>
        </article>
      ))}
      {!loadError && (before || (hasMore && olderHref)) ? (
        <nav className="file-actions" aria-label="التنقل بين صفحات السجل">
          {before ? <Link className="btn secondary" href="/history">{NEWEST_LABEL}</Link> : null}
          {hasMore && olderHref ? <Link className="btn secondary" href={olderHref}>{OLDER_LABEL}</Link> : null}
        </nav>
      ) : null}
    </section>
  );
}
