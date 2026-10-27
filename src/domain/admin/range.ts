export const RIYADH = "Asia/Riyadh";
export const PROVIDER_WINDOW_NOTE = "نافذة المزود بالتوقيت العالمي ولا تتبع مرشح تقرير الموقع";
export const UTC_RIYADH_LABEL = "00:00 UTC تقابل 03:00 في Asia/Riyadh";

export type RangeKey = "today" | "7d" | "30d" | "custom";

export type TimeRange = {
  key: RangeKey;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
};

const DAY_MS = 86_400_000;

export function riyadhDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: RIYADH,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function resolveRange(input: {
  key: string | null;
  from: string | null;
  to: string | null;
  now: Date;
}): { ok: true; range: TimeRange } | { ok: false; message: string } {
  const key = input.key ?? "7d";
  if (key !== "today" && key !== "7d" && key !== "30d" && key !== "custom") {
    return { ok: false, message: "المدى الزمني غير مسموح" };
  }
  const to = input.now.toISOString();
  if (key === "today") return { ok: true, range: windowRange("today", riyadhStart(riyadhDate(input.now)), to) };
  if (key === "7d") return { ok: true, range: windowRange("7d", new Date(input.now.getTime() - 7 * DAY_MS).toISOString(), to) };
  if (key === "30d") return { ok: true, range: windowRange("30d", new Date(input.now.getTime() - 30 * DAY_MS).toISOString(), to) };
  return customRange(input.from, input.to);
}

export function providerDayWindow(now: Date): { from: string; to: string; resetUtc: string; resetLabel: string; note: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(from.getTime() + DAY_MS);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    resetUtc: to.toISOString(),
    resetLabel: UTC_RIYADH_LABEL,
    note: PROVIDER_WINDOW_NOTE,
  };
}

export function hourBucket(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error("TIME");
  return `${date.toISOString().slice(0, 13)}:00:00.000Z`;
}

function riyadhStart(day: string): string {
  return new Date(`${day}T00:00:00+03:00`).toISOString();
}

function windowRange(key: RangeKey, from: string, to: string): TimeRange {
  const length = Date.parse(to) - Date.parse(from);
  return {
    key,
    from,
    to,
    previousTo: from,
    previousFrom: new Date(Date.parse(from) - length).toISOString(),
  };
}

function customRange(from: string | null, to: string | null): { ok: true; range: TimeRange } | { ok: false; message: string } {
  if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return { ok: false, message: "المدى المخصص يحتاج بداية ونهاية صالحتين" };
  }
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (end <= start) return { ok: false, message: "نهاية المدى تسبق البداية" };
  if (end - start > 366 * DAY_MS) return { ok: false, message: "المدى المخصص أطول من سنة" };
  return { ok: true, range: windowRange("custom", new Date(start).toISOString(), new Date(end).toISOString()) };
}
