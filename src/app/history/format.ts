// Presentation helpers for the read-only comparison log. Kept beside the
// /history pages so the data module stays free of UI formatting.
const HISTORY_TIME_ZONE = "Asia/Riyadh";
const DEFAULT_MAX_QUESTION_LENGTH = 140;

export function formatHistoryDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ar", {
    timeZone: HISTORY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    numberingSystem: "latn",
  }).format(date);
}

/** The list page shortens long questions; the API and detail page keep the full text. */
export function truncateQuestion(question: string, maxLength = DEFAULT_MAX_QUESTION_LENGTH): string {
  const text = question.trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}…`;
}
