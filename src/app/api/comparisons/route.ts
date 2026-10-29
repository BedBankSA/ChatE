import { postComparison } from "@/server/comparisons/handle";

export async function POST(request: Request) {
  return postComparison(request);
}
