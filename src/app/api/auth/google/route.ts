import { NextResponse } from "next/server";
import { profileFromVerifiedClaims } from "@/domain/auth/google";
import { newNonce, sessionCookie, signSession } from "@/domain/auth/session";
import { gateTurnstile, readJson } from "@/server/guard";
import { acceptGoogleIdentity, verifyGoogleIdToken } from "@/server/google-identity";
import { readStoredProfile, upsertGoogleUser } from "@/server/db/profiles";
import { verifyPhoneHref } from "@/domain/auth/phone-history";
import { suspensionActive } from "@/domain/admin/suspension";
import { readSessionStanding } from "@/server/account-access";
import { getDatabase } from "@/server/db/runtime";
import { runtimeEnv } from "@/server/db/settings";
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
  const runtime = runtimeEnv();
  const audience = runtime.GOOGLE_CLIENT_ID;
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
  // A suspended account must be told so explicitly. Issuing a cookie here would
  // bounce the customer between "/" and "/workspace" with no message, because
  // every session read fails closed (src/domain/auth/session.ts storedSessionAllows).
  try {
    const standing = readSessionStanding(getDatabase(), profile.googleSub);
    if (standing && suspensionActive(standing.status, standing.suspendedUntil, Date.now())) {
      return jsonError("حسابك موقوف. تواصل مع الدعم لمعرفة سبب الإيقاف.", "suspended", 403);
    }
  } catch {
    // The upsert above already succeeded; a failed standing read must not mint a
    // session that skips the suspension check, so fail closed as a store error.
    return jsonError("تعذر التحقق من حالة الحساب. أعد المحاولة لاحقًا.", "account_store", 500);
  }
  // Seamless onboarding: a brand-new (or still-unverified) account goes straight
  // to the phone gate instead of landing on a workspace it cannot use.
  let next = "/workspace";
  try {
    const stored = readStoredProfile(getDatabase(), profile.googleSub);
    if (!stored?.phoneVerifiedAt) next = verifyPhoneHref("/workspace");
  } catch {
    next = "/workspace";
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
    data: { name: profile.name, email: profile.email, next },
    error: null,
  });
  const https = new URL(runtime.APP_URL ?? "http://localhost:3000").protocol === "https:";
  response.cookies.set("chate_session", token, { ...sessionCookie(https), maxAge: 60 * 60 * 24 * 14 });
  response.cookies.set("chate_google_nonce", "", { ...sessionCookie(https), maxAge: 0 });
  return response;
}
