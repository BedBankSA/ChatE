import { NextResponse } from "next/server";
import { sessionCookie } from "@/domain/auth/session";

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host")?.split(",")[0]?.trim().toLowerCase() ?? "";
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

/** Logout is POST-only and same-origin so a cross-site <img>/link cannot force it. */
export async function POST(request: Request) {
  const target = new URL("/", request.url);
  if (!sameOrigin(request)) {
    return NextResponse.redirect(target, 303);
  }
  const response = NextResponse.redirect(target, 303);
  const https = (process.env.APP_URL ?? "").startsWith("https:") || process.env.NODE_ENV === "production";
  const flags = sessionCookie(https);
  response.cookies.set("chate_session", "", { ...flags, maxAge: 0 });
  response.cookies.set("chate_google_nonce", "", { ...flags, maxAge: 0 });
  return response;
}
