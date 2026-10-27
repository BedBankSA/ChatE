import { readTurnstileToken } from "@/domain/auth/turnstile";
import { publicError } from "@/domain/errors";
import { jsonError } from "@/server/http";
import { requireTurnstile } from "@/server/turnstile";

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
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
    });
    return null;
  } catch (error) {
    const pub = publicError(error);
    return jsonError(pub.message, pub.code, pub.status);
  }
}
