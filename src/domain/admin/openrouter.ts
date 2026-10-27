import { finiteNumber, measured, unavailable, type Reading } from "@/domain/admin/readings";
import { providerDayWindow, UTC_RIYADH_LABEL, PROVIDER_WINDOW_NOTE } from "@/domain/admin/range";

export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
export const SPEND_LIMIT_NOTE = "حد إنفاق المفتاح وليس رصيد المحفظة";

export type DailyQuota = { used: Reading; limit: Reading; remaining: Reading };

export type ProviderPicture = {
  window: ReturnType<typeof providerDayWindow>;
  freeDaily: DailyQuota;
  spendLimitRemaining: Reading;
  spendLimitNote: string;
  creditsTotal: Reading;
  creditsUsage: Reading;
  unattributed: Reading;
  stale: boolean;
  syncError: string | null;
};

export function allowlistKeyPayload(body: unknown): {
  limit: number | null;
  limitRemaining: number | null;
  limitReset: string | null;
  usageDaily: number | null;
  freeDaily: { used: number | null; limit: number | null; remaining: number | null } | null;
} | null {
  const root = record(body);
  const data = record(root?.data);
  if (!data) return null;
  const daily = record(data.free_model_daily_requests);
  return {
    limit: finiteNumber(data.limit),
    limitRemaining: finiteNumber(data.limit_remaining),
    limitReset: typeof data.limit_reset === "string" ? data.limit_reset : null,
    usageDaily: finiteNumber(data.usage_daily),
    freeDaily: daily
      ? { used: finiteNumber(daily.used), limit: finiteNumber(daily.limit), remaining: finiteNumber(daily.remaining) }
      : null,
  };
}

export function allowlistCreditsPayload(body: unknown): { totalCredits: number | null; totalUsage: number | null } | null {
  const data = record(record(body)?.data);
  if (!data) return null;
  return { totalCredits: finiteNumber(data.total_credits), totalUsage: finiteNumber(data.total_usage) };
}

export function pictureFromPayloads(input: {
  now: Date;
  key: ReturnType<typeof allowlistKeyPayload> | null;
  credits: ReturnType<typeof allowlistCreditsPayload> | null;
  creditsReason: string | null;
  localAttributedRequests: number | null;
  stale: boolean;
  syncError: string | null;
}): ProviderPicture {
  const freeDaily = dailyReadings(input.key);
  return {
    window: providerDayWindow(input.now),
    freeDaily,
    spendLimitRemaining: spendReading(input.key),
    spendLimitNote: SPEND_LIMIT_NOTE,
    creditsTotal: creditsReading(input.credits?.totalCredits ?? null, input.creditsReason, "total_credits"),
    creditsUsage: creditsReading(input.credits?.totalUsage ?? null, input.creditsReason, "total_usage"),
    unattributed: unattributedReading(input.key?.freeDaily?.used ?? null, input.localAttributedRequests),
    stale: input.stale,
    syncError: input.syncError,
  };
}

export function keysMatch(left: string | undefined, right: string | undefined): boolean {
  const a = left?.trim();
  const b = right?.trim();
  return Boolean(a && b && a === b);
}

function dailyReadings(key: ReturnType<typeof allowlistKeyPayload> | null): DailyQuota {
  if (!key) return missingDaily("تعذر قراءة رد المزود");
  if (!key.freeDaily) return missingDaily("المزود لم يُرجع free_model_daily_requests");
  const used = key.freeDaily.used == null
    ? unavailable("المزود لم يُرجع المستخدم من الطلبات اليومية المجانية")
    : measured(key.freeDaily.used, "provider-confirmed");
  const limit = key.freeDaily.limit == null
    ? unavailable("المزود لم يُرجع حد الطلبات اليومية المجانية")
    : measured(key.freeDaily.limit, "provider-confirmed");
  const remaining = remainingReading(key.freeDaily.remaining, key.freeDaily.used, key.freeDaily.limit);
  return { used, limit, remaining };
}

function missingDaily(reason: string): DailyQuota {
  return { used: unavailable(reason), limit: unavailable(reason), remaining: unavailable(reason) };
}

function remainingReading(remaining: number | null, used: number | null, limit: number | null): Reading {
  if (remaining != null) return measured(remaining, "provider-confirmed");
  if (used != null && limit != null) return measured(Math.max(0, limit - used), "local");
  return unavailable("المزود لم يُرجع المتبقي من الطلبات اليومية المجانية");
}

function spendReading(key: ReturnType<typeof allowlistKeyPayload> | null): Reading {
  if (!key) return unavailable("تعذر قراءة حد إنفاق المفتاح");
  if (key.limitRemaining == null) return unavailable("المزود لم يُرجع limit_remaining. هذا حد إنفاق المفتاح وليس رصيد المحفظة");
  return measured(key.limitRemaining, "provider-confirmed");
}

function creditsReading(value: number | null, reason: string | null, field: string): Reading {
  if (reason) return unavailable(reason);
  if (value == null) return unavailable(`المزود لم يُرجع ${field}`);
  return measured(value, "provider-confirmed");
}

function unattributedReading(providerUsed: number | null, localUsed: number | null): Reading {
  if (providerUsed == null) return unavailable("لا يُحسب استخدام غير منسوب بلا رقم يومي من المزود");
  if (localUsed == null) return unavailable("لا يُحسب استخدام غير منسوب بلا عداد محلي لنافذة المزود");
  if (localUsed > providerUsed) return unavailable("الاستخدام المحلي يتجاوز رقم المزود، ولا يُحسب فرق سالب");
  return measured(providerUsed - localUsed, "estimated");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export { UTC_RIYADH_LABEL, PROVIDER_WINDOW_NOTE };
