import { jsonError } from "@/server/http";

export function GET() {
  return jsonError("يلزم تسجيل الدخول", "anonymous", 401);
}
