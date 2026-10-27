import { NextResponse } from "next/server";
import { newNonce } from "@/domain/auth/session";
import { jsonError } from "@/server/http";

export async function POST() {
  if (!process.env.GOOGLE_CLIENT_ID) {
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
