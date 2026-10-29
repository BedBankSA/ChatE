import Link from "next/link";
import { notFound } from "next/navigation";
import { GoogleIntentButton } from "@/components/google-intent";
import { runStatusText } from "@/domain/comparison/view";
import { formatHistoryDate } from "@/app/history/format";
import { readComparisonForUser, type HistoryComparison } from "@/server/comparisons/history";
import { getDatabase } from "@/server/db/runtime";
import { readGoogleSession } from "@/server/google-session";
import { redirectUnverifiedToVerifyPhone } from "@/server/phone/gate";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذر قراءة تفاصيل المقارنة الآن. أعد المحاولة لاحقًا.";

type HistoryDetailParams = Promise<{ id: string }>;

export default async function HistoryDetailPage({ params }: { params: HistoryDetailParams }) {
  const { id } = await params;
  const session = await readGoogleSession();
  if (!session) {
    return (
      <section className="shell reading">
        <article className="card">
          <h1>تفاصيل المقارنة</h1>
          <p>سجّل الدخول لعرض تفاصيل المقارنة.</p>
          <GoogleIntentButton />
        </article>
      </section>
    );
  }

  await redirectUnverifiedToVerifyPhone(`/history/${encodeURIComponent(id)}`);
  let comparison: HistoryComparison | null = null;
  let loadError = false;
  try {
    comparison = readComparisonForUser(getDatabase(), session.userId, id);
  } catch {
    loadError = true;
  }
  if (loadError) {
    return (
      <section className="shell reading">
        <article className="card">
          <h1>تفاصيل المقارنة</h1>
          <p>{LOAD_ERROR}</p>
          <Link className="btn secondary" href="/history">العودة إلى السجل</Link>
        </article>
      </section>
    );
  }
  // Malformed ids, another user's id, and ids that no longer exist all answer
  // with the same not-found page so the route never confirms foreign rows.
  if (!comparison) notFound();

  return (
    <section className="shell reading">
      <article className="card">
        <h1>تفاصيل المقارنة</h1>
        <h2>{comparison.question}</h2>
        <p className="meta">
          {formatHistoryDate(comparison.createdAt)} · {runStatusText(comparison.status)}
        </p>
        <p className="meta ltr">{comparison.id}</p>
      </article>
      {comparison.attachments.length > 0 ? (
        <article className="card">
          <h2>المرفقات</h2>
          <ul className="file-list">
            {comparison.attachments.map((attachment) => (
              <li key={attachment.id}>
                {attachment.name}
                {attachment.detectedType ? ` — ${attachment.detectedType}` : ""}
              </li>
            ))}
          </ul>
        </article>
      ) : null}
      {comparison.runs.map((run) => (
        <article className="card answer-card" key={run.modelId}>
          <h2 className="model-name">{run.displayName}</h2>
          <p className="ltr meta">{run.modelId}</p>
          <p className="meta">
            {run.provider === "anthropic" ? "Anthropic" : "OpenRouter"} · {runStatusText(run.status)}
          </p>
          {run.outputText.trim() ? (
            <pre style={{ whiteSpace: "pre-wrap" }}>{run.outputText}</pre>
          ) : (
            <p className="meta">لا يوجد نص محفوظ لهذه النتيجة.</p>
          )}
          {run.message ? <p>{run.message}</p> : null}
          {run.completionMs != null ? <p>زمن النموذج: {run.completionMs} مللي ثانية</p> : null}
        </article>
      ))}
      {comparison.runs.length === 0 ? (
        <article className="card">
          <p className="meta">لا توجد نتائج محفوظة لهذه المقارنة.</p>
        </article>
      ) : null}
      <Link className="btn secondary" href="/history">العودة إلى السجل</Link>
    </section>
  );
}
