import { NextResponse } from "next/server";
import { newNonce } from "@/domain/auth/session";
import { rateLimitResponse, sameOriginRequest } from "@/server/guard";
import { runtimeEnv } from "@/server/db/settings";
import { jsonError } from "@/server/http";

export async function POST(request?: Request) {
  // Unauthenticated nonce minting: throttle per client before doing any work.
  // Next always supplies the Request; the optional parameter keeps the direct
  // unit-test call POST() working without inventing a fake request.
  if (request) {
    if (!sameOriginRequest(request)) return jsonError("الطلب مرفوض.", "origin", 403);
    const limited = rateLimitResponse(request, "auth:intent");
    if (limited) return limited;
  }
  if (!runtimeEnv().GOOGLE_CLIENT_ID) {
    return jsonError("دخول Google ينتظر معرّف العميل. لم تُنشأ جلسة.", "GOOGLE_UNCONFIGURED", 503);
  }
  const nonce = newNonce();
  const response = NextResponse.json({ ok: true, data: { nonce }, error: null });
  response.cookies.set("chate_google_nonce", nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 10 * 60,
  });
  return response;
}
