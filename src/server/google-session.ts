import { cookies } from "next/headers";
import type { DatabaseSync } from "node:sqlite";
import { readCookieSession, storedSessionAllows, type SessionPayload } from "@/domain/auth/session";
import { readSessionStanding } from "@/server/account-access";
import { getDatabase } from "@/server/db/runtime";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Validates a signed token against the stored account: the user row must still
 * exist, must not be suspended, and must not have been revoked through
 * users.session_valid_after. Any store failure fails closed (no session).
 * The optional database parameter exists so tests can pass an isolated store.
 */
function verifiedSession(
  token: string | undefined,
  nowSec: number,
  database?: DatabaseSync,
): SessionPayload | null {
  const payload = readCookieSession(token, process.env.SESSION_SECRET, nowSec);
  if (!payload) return null;
  try {
    const db = database ?? getDatabase();
    const standing = readSessionStanding(db, payload.userId);
    if (!standing) return null;
    return storedSessionAllows(payload, standing, nowSec) ? payload : null;
  } catch {
    // A database failure must log the caller out, not skip the standing check.
    return null;
  }
}

export async function readGoogleSession(
  nowSec = nowSeconds(),
  database?: DatabaseSync,
): Promise<SessionPayload | null> {
  let token: string | undefined;
  try {
    token = (await cookies()).get("chate_session")?.value;
  } catch {
    return null;
  }
  return verifiedSession(token, nowSec, database);
}

export function sessionFromRequest(
  request: Request,
  nowSec = nowSeconds(),
  database?: DatabaseSync,
): SessionPayload | null {
  return verifiedSession(cookieValue(request, "chate_session"), nowSec, database);
}

export async function readComparisonSession(
  request: Request,
  nowSec = nowSeconds(),
  database?: DatabaseSync,
): Promise<SessionPayload | null> {
  const fromRequest = sessionFromRequest(request, nowSec, database);
  if (fromRequest) return fromRequest;
  try {
    return await readGoogleSession(nowSec, database);
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
