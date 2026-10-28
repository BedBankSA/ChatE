import { handleAdminUsers } from "@/server/admin/http";
import { getDatabase } from "@/server/db/runtime";
import { readComparisonSession } from "@/server/google-session";
import { jsonError } from "@/server/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await readComparisonSession(request);
  if (!session) return jsonError("يلزم تسجيل الدخول", "anonymous", 401);
  try {
    return await handleAdminUsers(request, { session, db: getDatabase(), env: process.env });
  } catch {
    return jsonError("تعذر تنفيذ الإجراء.", "store", 500);
  }
}
