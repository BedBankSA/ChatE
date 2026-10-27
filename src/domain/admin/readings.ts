export type ReadingSource = "provider-confirmed" | "local" | "estimated";

export type Reading =
  | { state: "value"; value: number; source: ReadingSource }
  | { state: "unavailable"; label: "غير متاح"; reason: string };

export function unavailable(reason: string): Reading {
  return { state: "unavailable", label: "غير متاح", reason };
}

export function measured(value: number, source: ReadingSource): Reading {
  if (!Number.isFinite(value)) return unavailable("القيمة ليست رقمًا صالحًا");
  return { state: "value", value, source };
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function growthRatio(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

export type Metric = {
  value: number;
  previous: number;
  change: number | null;
  source: "local";
};

export function metric(value: number, previous: number): Metric {
  return { value, previous, change: growthRatio(value, previous), source: "local" };
}
