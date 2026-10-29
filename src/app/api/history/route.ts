import { getDatabase } from "@/server/db/runtime";
import { HISTORY_PAGE_SIZE, listComparisons } from "@/server/comparisons/history";
import { readComparisonSession } from "@/server/google-session";
import { jsonError, jsonOk } from "@/server/http";

const ANONYMOUS_MESSAGE = "يلزم تسجيل الدخول لعرض سجل المقارنات";
const STORE_MESSAGE = "تعذر قراءة سجل المقارنات.";

function queryValue(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  return value && value.trim() ? value.trim() : null;
}

function limitValue(raw: string | null): number {
  if (!raw) return HISTORY_PAGE_SIZE;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : HISTORY_PAGE_SIZE;
}

/**
 * Read-only log of the signed-in user's comparisons, newest first. The same
 * page size and opaque `before` cursor are used by the /history server page, so
 * the API cannot expose another account's rows: the user id comes from the
 * verified session cookie, never from the query string.
 */
export async function GET(request: Request) {
  const session = await readComparisonSession(request);
  if (!session) return jsonError(ANONYMOUS_MESSAGE, "anonymous", 401);
  let db;
  try {
    db = getDatabase();
  } catch {
    return jsonError(STORE_MESSAGE, "store", 500);
  }
  try {
    const url = new URL(request.url);
    const before = queryValue(url, "before");
    const comparisons = listComparisons(db, session.userId, {
      limit: limitValue(queryValue(url, "limit")),
      ...(before ? { before } : {}),
    });
    const response = jsonOk({ comparisons });
    response.headers.set("cache-control", "no-store");
    return response;
  } catch {
    return jsonError(STORE_MESSAGE, "store", 500);
  }
}
