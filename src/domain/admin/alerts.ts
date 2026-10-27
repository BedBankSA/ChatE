export const ALERT_KINDS = [
  "quota_low",
  "quota_exhausted",
  "rate_limit_spike",
  "api_key_failure",
  "service_down",
  "request_spike",
  "stats_sync_failure",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

export type AlertThreshold = {
  kind: AlertKind;
  enabled: boolean;
  threshold: number | null;
  notifyExternal: boolean;
};

export type AlertItem = { kind: AlertKind; message: string; externalSent: false };

export type AlertInput = {
  quotaRemainingRatio: number | null;
  rateLimitCount: number;
  keyFailed: boolean;
  serviceDown: boolean;
  currentRequests: number;
  previousRequests: number;
  syncFailed: boolean;
};

export function evaluateAlerts(input: AlertInput, thresholds: AlertThreshold[]): AlertItem[] {
  const alerts: AlertItem[] = [];
  for (const threshold of thresholds) {
    if (!threshold.enabled) continue;
    const message = alertMessage(threshold, input);
    if (message) alerts.push({ kind: threshold.kind, message, externalSent: false });
  }
  return alerts;
}

export function externalAlertResult(): { sent: false; reason: string } {
  return { sent: false, reason: "التنبيهات الخارجية غير موصولة. لا بريد ولا رسالة." };
}

function alertMessage(threshold: AlertThreshold, input: AlertInput): string | null {
  if (threshold.kind === "quota_exhausted" && input.quotaRemainingRatio === 0) return "الحصة المحلية نفدت";
  if (threshold.kind === "quota_low" && input.quotaRemainingRatio != null && threshold.threshold != null && input.quotaRemainingRatio > 0 && input.quotaRemainingRatio <= threshold.threshold) {
    return "الحصة المحلية قاربت النفاد";
  }
  if (threshold.kind === "rate_limit_spike" && threshold.threshold != null && input.rateLimitCount >= threshold.threshold) {
    return "ارتفع عدد ردود 429";
  }
  if (threshold.kind === "api_key_failure" && input.keyFailed) return "فشل فحص مفتاح المزود";
  if (threshold.kind === "service_down" && input.serviceDown) return "آخر فحص لخدمة انتهى بالفشل";
  if (threshold.kind === "request_spike" && threshold.threshold != null && input.previousRequests > 0 && input.currentRequests >= input.previousRequests * threshold.threshold) {
    return "ارتفاع غير معتاد في الطلبات مقارنة بالفترة السابقة";
  }
  if (threshold.kind === "stats_sync_failure" && input.syncFailed) return "تعذر مزامنة إحصاء المزود";
  return null;
}

export function isAlertKind(value: string): value is AlertKind {
  return ALERT_KINDS.includes(value as AlertKind);
}
