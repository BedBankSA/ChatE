export type PublicRun = {
  modelId: string;
  displayName: string;
  provider: "anthropic" | "openrouter";
  status: string;
  message: string | null;
  outputText: string;
  effort: string | null;
  labels: string[];
  completionMs: number | null;
};

export type PublicAttachment = {
  id: string;
  name: string;
  detectedType: string;
};

export type PublicComparison = {
  id: string;
  question: string;
  status: string;
  runs: PublicRun[];
  /** Files attached to the comparison; empty when none were sent. */
  attachments?: PublicAttachment[];
};

const STATUS_TEXT: Record<string, string> = {
  queued: "في الانتظار",
  running: "يعمل الآن",
  completed: "اكتمل",
  incomplete: "النتيجة ناقصة",
  failed: "تعذر",
  policy_blocked: "موقوف حسب شروط المزود",
  unfit: "غير مناسب لهذا الطلب",
  context_exceeded: "يتجاوز السياق",
  live_disabled: "الاستدعاء الحي متوقف",
  cancelled: "أُوقف العرض",
};

export function runStatusText(status: string): string {
  return STATUS_TEXT[status] ?? status;
}

export function runsSettled(runs: readonly { status: string }[]): boolean {
  return runs.length > 0 && runs.every((run) => run.status !== "queued" && run.status !== "running");
}

/**
 * Which runs may appear in the results grid. Failed / blocked / timed-out /
 * incomplete runs are suppressed entirely ("الزبدة فقط"); only completed
 * answers and still-running placeholders are rendered.
 */
export function visibleComparisonRuns(runs: readonly PublicRun[]): PublicRun[] {
  return runs.filter(
    (run) => run.status === "completed" || run.status === "queued" || run.status === "running",
  );
}

export function successfulComparisonRuns(runs: readonly PublicRun[]): PublicRun[] {
  return runs.filter((run) => run.status === "completed");
}

/** Positive-only copy for the results header; never tallies failures. */
export function successSummaryText(count: number): string {
  if (count <= 0) return "لم تصل إجابات ناجحة بعد.";
  if (count === 1) return "تم استلام إجابة واحدة بنجاح.";
  if (count === 2) return "تم استلام إجابتين بنجاح.";
  return `تم استلام ${count} إجابات بنجاح.`;
}
