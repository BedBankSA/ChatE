export const SERVICE_IDS = ["openrouter", "turnstile", "google", "otp", "storage"] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

export function servicePurpose(service: ServiceId): string {
  if (service === "openrouter") return "استدلال النماذج المجانية عبر مفتاح الخادم";
  if (service === "turnstile") return "تحقق الودجت الحالي قبل الدخول والرفع والمقارنة";
  if (service === "google") return "دخول الويب بمعرف Google Identity Services";
  if (service === "otp") return "إرسال رمز الجوال عندما يُضبط مزود HTTP";
  return "حفظ الملفات الخاصة على القرص";
}
