import { cookies } from "next/headers";
import { readCookieSession, type SessionPayload } from "@/domain/auth/session";

export async function readGoogleSession(nowSec = Math.floor(Date.now() / 1000)): Promise<SessionPayload | null> {
  const token = (await cookies()).get("chate_session")?.value;
  return readCookieSession(token, process.env.SESSION_SECRET, nowSec);
}

export function sessionFromRequest(request: Request, nowSec = Math.floor(Date.now() / 1000)): SessionPayload | null {
  return readCookieSession(cookieValue(request, "chate_session"), process.env.SESSION_SECRET, nowSec);
}

export async function readComparisonSession(request: Request): Promise<SessionPayload | null> {
  const fromRequest = sessionFromRequest(request);
  if (fromRequest) return fromRequest;
  try {
    return await readGoogleSession();
  } catch {
    return null;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    const raw = rest.join("=");
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}
