import { getComparison } from "@/server/comparisons/handle";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return getComparison(request, id);
}
