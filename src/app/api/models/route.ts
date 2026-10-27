import { listPublicModels } from "@/domain/models/catalog";
import { jsonOk } from "@/server/http";

export function GET() {
  return jsonOk(listPublicModels());
}
