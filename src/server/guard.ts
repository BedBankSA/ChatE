import { readTurnstileToken } from "@/domain/auth/turnstile";
import { publicError } from "@/domain/errors";
import { getDatabase } from "@/server/db/runtime";
import { jsonError } from "@/server/http";
import { requireTurnstile } from "@/server/turnstile";

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    // A truncated or aborted body is treated like an empty JSON object so the
    // route can answer with a validation error instead of a 500.
    return {};
  }
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function gateTurnstile(
  request: Request,
  body: Record<string, unknown>,
  expectedAction: string,
): Promise<Response | null> {
  try {
    await requireTurnstile({
      request,
      token: readTurnstileToken(body),
      expectedAction,
      // Resolved lazily: a request without a token never opens the database,
      // and a store failure degrades to the bounded in-process replay guard.
      database: optionalDatabase,
    });
    return null;
  } catch (error) {
    const pub = publicError(error);
    return jsonError(pub.message, pub.code, pub.status);
  }
}

function optionalDatabase() {
  try {
    return getDatabase();
  } catch {
    return undefined;
  }
}
