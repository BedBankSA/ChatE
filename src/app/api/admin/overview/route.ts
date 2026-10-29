import { handleAdminOverview } from "@/server/admin/http";
import { getDatabase } from "@/server/db/runtime";
import { runtimeEnv } from "@/server/db/settings";
import { readComparisonSession } from "@/server/google-session";
import { jsonError } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await readComparisonSession(request);
  if (!session) return jsonError("يلزم تسجيل الدخول", "anonymous", 401);
  try {
    return handleAdminOverview(request, { session, db: getDatabase(), env: runtimeEnv() });
  } catch {
    return jsonError("تعذر فتح لوحة الإدارة.", "store", 500);
  }
}
