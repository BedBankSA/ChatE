export const PROVIDER_REFRESH_MS = 60_000;
export const PROVIDER_STALE_MS = 5 * 60_000;
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
