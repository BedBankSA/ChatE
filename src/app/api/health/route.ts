import { getDatabase } from "@/server/db/runtime";
import { jsonOk, jsonError } from "@/server/http";

// Liveness + readiness probe for the deployment runbook (systemd/Docker/Caddy
// and external uptime checks). It is intentionally unauthenticated, returns no
// configuration or user data, and never opens the database unless it is already
// initialized by normal traffic.
export const dynamic = "force-dynamic";

export function GET() {
  let database: "ok" | "unavailable" = "ok";
  try {
    const db = getDatabase();
    db.prepare("SELECT 1 AS ok").get();
  } catch {
    database = "unavailable";
  }
  if (database !== "ok") {
    const response = jsonError("قاعدة البيانات غير متاحة.", "not_ready", 503);
    response.headers.set("cache-control", "no-store");
    return response;
  }
  const response = jsonOk({ status: "ok", database, time: new Date().toISOString() });
  response.headers.set("cache-control", "no-store");
  return response;
}
