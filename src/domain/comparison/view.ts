export type PublicRun = {
  modelId: string;
  displayName: string;
  provider: "anthropic" | "openrouter";
  status: string;
  message: string | null;
  outputText: string;
  effort: string | null;
  labels: string[];
  costUsd: number | null;
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
