import { NextResponse } from "next/server";
import { themeFromCookieHeader, themeReturnPath, toggledTheme } from "@/domain/theme-return";
import { sameOriginRequest } from "@/server/guard";
import { jsonError } from "@/server/http";

export async function POST(request: Request) {
  // A theme toggle is a state-changing form POST. Reject cross-site browser
  // requests before looking at the cookie or the referer.
  if (!sameOriginRequest(request)) return jsonError("الطلب مرفوض.", "origin", 403);
  const next = toggledTheme(themeFromCookieHeader(request.headers.get("cookie")));
  // Only a same-origin path is ever returned. The destination is emitted as a
  // relative Location so a spoofed Host header can never turn this route into
  // an open redirect.
  const location = themeReturnPath(request.headers.get("referer"), request.url, request.headers.get("host"));
  const response = new NextResponse(null, { status: 303, headers: { location } });
  response.cookies.set("chate_theme", next, { path: "/", sameSite: "lax", httpOnly: false });
  return response;
}
