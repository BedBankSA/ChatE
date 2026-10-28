export const MANAGER_TIME_ZONE = "Asia/Riyadh";

export const LATENCY_EDGES = [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 30000, 120000, 600000];

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
