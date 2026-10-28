import { NextResponse } from "next/server";
import { profileFromVerifiedClaims } from "@/domain/auth/google";
import { newNonce, sessionCookie, signSession } from "@/domain/auth/session";
import { gateTurnstile, readJson } from "@/server/guard";
import { acceptGoogleIdentity, verifyGoogleIdToken } from "@/server/google-identity";
import { upsertGoogleUser } from "@/server/db/profiles";
import { getDatabase } from "@/server/db/runtime";
import { jsonError } from "@/server/http";

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
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
  return null;
}

export async function POST(request: Request) {
  const audience = process.env.GOOGLE_CLIENT_ID;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!audience || !sessionSecret) {
    return jsonError("دخول Google غير مكتمل الإعداد.", "GOOGLE_UNCONFIGURED", 503);
  }
  const body = await readJson(request);
  const credential = body.credential;
  if (typeof credential !== "string" || credential.length < 20 || credential.length > 8192) {
    return jsonError("رمز Google غير صالح.", "GOOGLE_TOKEN", 401);
  }
  const blocked = await gateTurnstile(request, body, "login");
  if (blocked) return blocked;
  const nonce = readCookie(request, "chate_google_nonce");
  if (!nonce) return jsonError("ابدأ الدخول من جديد.", "GOOGLE_NONCE", 401);
  let claims;
  try {
    claims = await verifyGoogleIdToken(credential, audience);
  } catch {
    return jsonError("تعذر التحقق من رمز Google.", "GOOGLE_TOKEN", 401);
  }
  let identity;
  try {
    identity = acceptGoogleIdentity(claims, audience, nonce, Math.floor(Date.now() / 1000));
  } catch {
    return jsonError("رمز Google مرفوض.", "GOOGLE_TOKEN", 401);
  }
  const profile = profileFromVerifiedClaims(identity, {});
  try {
    upsertGoogleUser(getDatabase(), {
      id: profile.googleSub,
      googleSub: profile.googleSub,
      email: profile.email,
      name: profile.name,
    });
  } catch {
    return jsonError("تعذر حفظ الحساب.", "account_store", 500);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signSession(
    {
      userId: profile.googleSub,
      googleSub: profile.googleSub,
      exp: nowSec + 60 * 60 * 24 * 14,
      iat: nowSec,
      csrf: newNonce(),
    },
    sessionSecret,
  );
  const response = NextResponse.json({
    ok: true,
    data: { name: profile.name, email: profile.email },
    error: null,
  });
  const https = new URL(process.env.APP_URL ?? "http://localhost:3000").protocol === "https:";
  response.cookies.set("chate_session", token, { ...sessionCookie(https), maxAge: 60 * 60 * 24 * 14 });
  response.cookies.set("chate_google_nonce", "", { ...sessionCookie(https), maxAge: 0 });
  return response;
}
