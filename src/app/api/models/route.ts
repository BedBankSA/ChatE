import { listPublicModels } from "@/domain/models/catalog";
import { runtimeEnv } from "@/server/db/settings";
import { jsonOk } from "@/server/http";

export const dynamic = "force-dynamic";

export function GET() {
  // The runtime resolver layers SQLite-managed keys over process.env, so the
  // public model list reflects an Anthropic key saved from /admin/settings.
  return jsonOk(listPublicModels(runtimeEnv()));
}
