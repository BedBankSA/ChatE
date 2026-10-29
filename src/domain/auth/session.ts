import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sessionStillValid, suspensionActive } from "@/domain/admin/suspension";

export type SessionPayload = {
  userId: string;
  googleSub: string;
  exp: number;
  csrf: string;
  iat?: number;
};

/** The mutable server-side facts a signed token is checked against per request. */
export type StoredSessionStanding = {
  status: string;
  suspendedUntil: string | null;
  sessionValidAfter: string | null;
};

const MAX_TOKEN_LENGTH = 4096;
const MAX_ID_LENGTH = 200;
const MAX_ABSOLUTE_TTL_SECONDS = 400 * 24 * 60 * 60;

export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function readCookieSession(
  token: string | undefined,
  secret: string | undefined,
  nowSec: number,
): SessionPayload | null {
  if (!token || !secret) return null;
  return readSession(token, secret, nowSec);
}

export function readSession(token: string, secret: string, nowSec: number): SessionPayload | null {
  if (typeof token !== "string" || typeof secret !== "string" || !secret) return null;
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = createHmac("sha256", secret).update(parts[0]).digest("base64url");
  const actual = Buffer.from(parts[1]);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return normalizePayload(decoded, nowSec);
}

export function sessionCookie(https: boolean): {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  priority: "high";
} {
  // Fail closed in production: never emit a non-Secure session cookie even when
  // APP_URL is missing or misconfigured, because the login route derives the
  // "https" hint from APP_URL instead of from the request.
  const secure = https || process.env.NODE_ENV === "production";
  return { httpOnly: true, secure, sameSite: "lax", path: "/", priority: "high" };
}

/**
 * A valid HMAC proves the payload was issued by this server, not that the
 * account is still allowed to use it. Every API/page session read passes the
 * stored account through this check so that an admin suspension and the
 * users.session_valid_after revocation marker take effect immediately.
 *
 * Unknown or malformed standing data is handled by the caller as "no session"
 * (fail closed); this function only answers for a concrete stored row.
 */
export function storedSessionAllows(
  session: SessionPayload,
  standing: StoredSessionStanding,
  nowSec: number,
): boolean {
  if (suspensionActive(standing.status, standing.suspendedUntil, nowSec * 1000)) return false;
  if (standing.sessionValidAfter != null) {
    // A token minted before the revocation timestamp, or a legacy token with no
    // issued-at claim, can no longer be trusted.
    if (session.iat == null) return false;
    if (!sessionStillValid(session.iat, standing.sessionValidAfter, nowSec * 1000)) return false;
  }
  return true;
}

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

/** A signed token is only trusted when every field has the expected runtime type. */
function normalizePayload(value: unknown, nowSec: number): SessionPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const userId = boundedString(record.userId);
  const googleSub = boundedString(record.googleSub);
  const csrf = boundedString(record.csrf);
  if (!userId || !googleSub || !csrf) return null;
  const exp = record.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  if (exp <= nowSec || exp - nowSec > MAX_ABSOLUTE_TTL_SECONDS) return null;
  const iat = record.iat;
  if (iat != null) {
    if (typeof iat !== "number" || !Number.isFinite(iat) || iat <= 0) return null;
    if (iat > nowSec + 60) return null;
  }
  return typeof iat === "number"
    ? { userId, googleSub, exp, csrf, iat }
    : { userId, googleSub, exp, csrf };
}

function boundedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_ID_LENGTH) return null;
  return value;
}
