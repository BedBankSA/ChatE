export const PRESENCE_TTL_MS = 90_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const PROVIDER_REFRESH_MS = 60_000;
export const PROVIDER_STALE_MS = 5 * 60_000;
export const FRESH_SESSION_SECONDS = 15 * 60;
export const UNAVAILABLE_LABEL = "غير متاح";
export const MANAGER_TIME_ZONE = "Asia/Riyadh";

export const LATENCY_EDGES = [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 30000, 120000, 600000];

export type QuantitySource = "provider-confirmed" | "local" | "estimated" | "local-config";

export type Quantity =
  | { state: "value"; value: number; source: QuantitySource; unit?: string }
  | { state: "unavailable"; label: typeof UNAVAILABLE_LABEL; reason: string };

export function quantity(value: number, source: QuantitySource, unit?: string): Quantity {
  return unit ? { state: "value", value, source, unit } : { state: "value", value, source };
}

export function unavailable(reason: string): Quantity {
  return { state: "unavailable", label: UNAVAILABLE_LABEL, reason };
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function quantityFromNumber(value: unknown, reason: string, source: QuantitySource, unit?: string): Quantity {
  const parsed = finiteNumber(value);
  if (parsed == null) return unavailable(reason);
  return quantity(parsed, source, unit);
}

export function changeRatio(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

export function hourBucket(iso: string): string {
  if (iso.length < 13) return iso;
  return `${iso.slice(0, 13)}:00:00.000Z`;
}

export function latencyEdge(ms: number): number {
  for (const edge of LATENCY_EDGES) {
    if (ms <= edge) return edge;
  }
  return LATENCY_EDGES[LATENCY_EDGES.length - 1] ?? 600000;
}

export function percentileFromHistogram(
  rows: { leMs: number; events: number }[],
  percentile: number,
  minSamples: number,
): number | null {
  const total = rows.reduce((sum, row) => sum + row.events, 0);
  if (total < minSamples) return null;
  const target = Math.ceil((percentile / 100) * total);
  let seen = 0;
  const sorted = [...rows].sort((left, right) => left.leMs - right.leMs);
  for (const row of sorted) {
    seen += row.events;
    if (seen >= target) return row.leMs;
  }
  return sorted[sorted.length - 1]?.leMs ?? null;
}

export function reportedOutputTokens(
  outputTokens: number | null,
  reasoningTokens: number | null,
  reasoningIncludedInOutput: boolean,
): number | null {
  if (outputTokens == null && reasoningTokens == null) return null;
  if (reasoningIncludedInOutput || reasoningTokens == null) return outputTokens;
  return (outputTokens ?? 0) + reasoningTokens;
}

export function tokenSplit(usage: Record<string, unknown> | null): {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  reasoningIncludedInOutput: boolean;
} {
  if (!usage) {
    return { inputTokens: null, outputTokens: null, reasoningTokens: null, reasoningIncludedInOutput: false };
  }
  const details = asRecord(usage.completion_tokens_details) ?? asRecord(usage.output_tokens_details);
  const reasoning = finiteNumber(usage.reasoning_tokens) ?? finiteNumber(details?.reasoning_tokens);
  const explicit = usage.reasoning_included_in_output;
  const included = explicit === true || (explicit !== false && details != null && finiteNumber(details.reasoning_tokens) != null);
  return {
    inputTokens: finiteNumber(usage.prompt_tokens) ?? finiteNumber(usage.input_tokens),
    outputTokens: finiteNumber(usage.completion_tokens) ?? finiteNumber(usage.output_tokens),
    reasoningTokens: reasoning,
    reasoningIncludedInOutput: included,
  };
}

export type ReportKey = "today" | "7d" | "30d" | "custom";

export type ReportRange = { key: ReportKey; from: string; to: string };

export function resolveRange(
  input: { key?: string; from?: string; to?: string },
  now: Date,
  timeZone = MANAGER_TIME_ZONE,
): ReportRange {
  if (input.key === "custom" && input.from && input.to && Date.parse(input.from) < Date.parse(input.to)) {
    return { key: "custom", from: new Date(input.from).toISOString(), to: new Date(input.to).toISOString() };
  }
  if (input.key === "30d") return rolling(now, 30);
  if (input.key === "7d") return rolling(now, 7);
  const start = startOfZonedDay(now, timeZone);
  return { key: "today", from: start.toISOString(), to: now.toISOString() };
}

export function previousRange(range: ReportRange): ReportRange {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const span = Math.max(0, to - from);
  return { key: range.key, from: new Date(from - span).toISOString(), to: new Date(from).toISOString() };
}

export function utcDayWindow(now: Date): { from: string; to: string; resetUtc: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(from.getTime() + 86_400_000);
  return { from: from.toISOString(), to: to.toISOString(), resetUtc: to.toISOString() };
}

export function formatInstant(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ar", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    numberingSystem: "latn",
  }).format(new Date(iso));
}

function rolling(now: Date, days: number): ReportRange {
  return {
    key: days === 30 ? "30d" : "7d",
    from: new Date(now.getTime() - days * 86_400_000).toISOString(),
    to: now.toISOString(),
  };
}

function startOfZonedDay(now: Date, timeZone: string): Date {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const utcGuess = new Date(`${day}T00:00:00.000Z`);
  return new Date(utcGuess.getTime() - zoneOffsetMs(utcGuess, timeZone));
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const zoned = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));
  return zoned - instant.getTime();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
