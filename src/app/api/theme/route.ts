import { NextResponse } from "next/server";
import { themeFromCookieHeader, themeRedirectTarget, toggledTheme } from "@/domain/theme-return";

export async function POST(request: Request) {
  const next = toggledTheme(themeFromCookieHeader(request.headers.get("cookie")));
  const location = themeRedirectTarget(request.headers.get("referer"), request.url, request.headers.get("host"));
  const response = NextResponse.redirect(location, 303);
  response.cookies.set("chate_theme", next, { path: "/", sameSite: "lax", httpOnly: false });
  return response;
}
