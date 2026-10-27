import { gateTurnstile, readJson } from "@/server/guard";
import { jsonError } from "@/server/http";

export async function POST(request: Request) {
  const body = await readJson(request);
  const blocked = await gateTurnstile(request, body, "otp");
  if (blocked) return blocked;
  if (process.env.OTP_PROVIDER !== "http" || !process.env.OTP_HTTP_URL) {
    return jsonError("التحقق بالرسائل ينتظر إعداد مزود الإرسال. لم يُرسل رمز ولم يُوثق الجوال.", "OTP_UNCONFIGURED", 503);
  }
  return jsonError("مزود الرسائل مهيأ، وإرسال الرمز الحقيقي لم يُفعّل في هذا المسار بعد.", "OTP_NOT_SENT", 503);
}
