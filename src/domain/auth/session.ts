import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type SessionPayload = {
  userId: string;
  googleSub: string;
  exp: number;
  csrf: string;
};

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
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = createHmac("sha256", secret).update(parts[0]).digest("base64url");
  const actual = Buffer.from(parts[1]);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as SessionPayload;
    if (!payload.userId || !payload.googleSub || !payload.csrf || payload.exp <= nowSec) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionCookie(https: boolean): {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
} {
  return { httpOnly: true, secure: https, sameSite: "lax", path: "/" };
}

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function assertSameOrigin(origin: string | null, appUrl: string): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(appUrl).host;
  } catch {
    return false;
  }
}

export function assertProductionWeb(nodeEnv: string, appUrl: string): void {
  if (nodeEnv === "production" && !appUrl.startsWith("https://")) {
    throw new Error("APP_URL must be https in production");
  }
}
