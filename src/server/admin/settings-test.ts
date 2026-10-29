import type { DatabaseSync } from "node:sqlite";
import { SETTING_META, type SettingKey } from "@/domain/admin/settings";
import { getSystemKey } from "@/server/db/settings";

export type SettingsTestResult = { ok: boolean; message: string };

const ok = (message: string): SettingsTestResult => ({ ok: true, message });
const fail = (message: string): SettingsTestResult => ({ ok: false, message });

/**
 * Read-only connectivity checks for the admin settings screen. Every check uses
 * the resolved effective value (SQLite first, env fallback), never logs or
 * returns a secret, and aborts after 12s so the form cannot hang.
 */
export async function testSystemSetting(
  db: DatabaseSync,
  key: SettingKey,
  options: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch } = {},
): Promise<SettingsTestResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const value = getSystemKey(key, { db, env });
  const timeout = () => AbortSignal.timeout(12_000);
  const meta = SETTING_META[key];

  if (key === "HAIKU_LIVE_CALLS") {
    if (value === "0") return ok("Haiku الحي متوقف حاليًا (0).");
    const anthropic = getSystemKey("ANTHROPIC_API_KEY", { db, env });
    return anthropic ? ok("Haiku الحي مفعّل ومفتاح Anthropic موجود.") : fail("لم يُضبط مفتاح Anthropic بعد.");
  }
  if (!value.trim()) return fail("لا توجد قيمة محفوظة أو في البيئة لاختبارها.");
  const format = validateFormat(meta.pattern, value);
  if (!format.ok) return format;

  try {
    if (key === "ANTHROPIC_API_KEY") {
      // Use the same Messages endpoint the comparison adapter calls, with the
      // smallest possible request, so the test proves the exact live path.
      const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": value,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-5-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "test" }],
        }),
        signal: timeout(),
      });
      if (response.ok) return ok("اتصل Anthropic بنجاح والمفتاح صالح.");
      if (response.status === 429) return ok("المفتاح صالح لكن المزود مزدحم الآن (429).");
      return fail(`رفض Anthropic المفتاح (HTTP ${response.status}).`);
    }
    if (key === "OPENROUTER_API_KEY") {
      const response = await fetchImpl("https://openrouter.ai/api/v1/key", {
        headers: { authorization: `Bearer ${value}` },
        signal: timeout(),
      });
      return response.ok ? ok("اتصل OpenRouter بنجاح والمفتاح صالح.") : fail(`رفض OpenRouter المفتاح (HTTP ${response.status}).`);
    }
    if (key === "TURNSTILE_SITE_KEY") {
      return ok("صيغة مفتاح موقع Turnstile صحيحة.");
    }
    if (key === "TURNSTILE_SECRET_KEY") {
      const body = new URLSearchParams({ secret: value, response: "chate-settings-test" });
      const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: timeout(),
      });
      const payload = (await response.json().catch(() => null)) as { "error-codes"?: unknown } | null;
      const codes = Array.isArray(payload?.["error-codes"]) ? payload?.["error-codes"].map(String) : [];
      if (codes.includes("invalid-input-secret")) return fail("رفض Cloudflare السر؛ تحقق من المفتاح السري.");
      return ok("سر Turnstile صالح (رفض الرمز التجريبي كما هو متوقع).");
    }
    if (key === "GOOGLE_CLIENT_ID") {
      return ok("صيغة معرّف عميل Google صحيحة.");
    }
    if (key === "GOOGLE_CLIENT_SECRET") {
      const clientId = getSystemKey("GOOGLE_CLIENT_ID", { db, env });
      if (!clientId) return fail("أضف معرّف عميل Google أولًا لاختبار السر.");
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: value,
        grant_type: "authorization_code",
        code: "chate-settings-test",
        redirect_uri: "http://localhost/",
      });
      const response = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: timeout(),
      });
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const error = typeof payload?.error === "string" ? payload.error : "";
      if (error === "invalid_client") return fail("رفض Google العميل أو السر (invalid_client).");
      return ok("قبل Google بيانات العميل (رفض رمز الاختبار فقط).");
    }
    if (key === "SMS_API_KEY" || key === "SMS_API_SECRET" || key === "SMS_SENDER_ID") {
      // Sending a test SMS is intentionally avoided: there is no documented
      // read-only endpoint for every gateway. Credential validity is proven by
      // the first real OTP send, so the test here verifies presence + format.
      const apiKey = getSystemKey("SMS_API_KEY", { db, env });
      const secret = getSystemKey("SMS_API_SECRET", { db, env });
      const sender = getSystemKey("SMS_SENDER_ID", { db, env });
      if (!apiKey || !sender) return fail("أكمل مفتاح المزود واسم المرسل أولًا.");
      if (!secret && (env.SMS_PROVIDER ?? "").trim().toLowerCase() !== "taqnyat" && (env.SMS_PROVIDER ?? "").trim().toLowerCase() !== "unifonic") {
        return fail("4jawaly يتطلب المفتاح والسر معًا.");
      }
      return ok("بيانات اعتماد SMS مكتملة الصيغة. تُثبت صحتها عند أول إرسال رمز فعلي.");
    }
    return ok("لا يوجد فحص شبكي لهذا الإعداد.");
  } catch {
    return fail("تعذر الوصول إلى المزود. تحقق من الشبكة ثم أعد المحاولة.");
  }
}

function validateFormat(pattern: RegExp | null, value: string): SettingsTestResult {
  if (pattern && !pattern.test(value)) return fail("الصيغة غير صحيحة.");
  return ok("الصيغة صحيحة.");
}
