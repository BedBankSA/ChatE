const UNSAFE_PATH = /[\u0000-\u001F\\]/;
const SAFE_HOST = /^[A-Za-z0-9.\-:[\]]+$/;

export function requestOrigins(requestUrl: string, hostHeader: string | null = null): string[] {
  let request: URL;
  try {
    request = new URL(requestUrl);
  } catch {
    return [];
  }
  const origins = [request.origin];
  if (hostHeader && SAFE_HOST.test(hostHeader)) {
    const hostOrigin = `${request.protocol}//${hostHeader}`;
    if (!origins.includes(hostOrigin)) origins.push(hostOrigin);
  }
  return origins;
}

export function themeReturnPath(referer: string | null, requestUrl: string, hostHeader: string | null = null): string {
  if (!referer || referer.includes("\\")) return "/";
  let refererUrl: URL;
  try {
    refererUrl = new URL(referer);
  } catch {
    return "/";
  }
  if (!requestOrigins(requestUrl, hostHeader).includes(refererUrl.origin)) return "/";
  const path = `${refererUrl.pathname}${refererUrl.search}`;
  if (!path.startsWith("/") || path.startsWith("//") || UNSAFE_PATH.test(path)) return "/";
  return path;
}

export function themeRedirectTarget(referer: string | null, requestUrl: string, hostHeader: string | null = null): string {
  const path = themeReturnPath(referer, requestUrl, hostHeader);
  try {
    const request = new URL(requestUrl);
    if (referer && !referer.includes("\\")) {
      const refererUrl = new URL(referer);
      if (requestOrigins(requestUrl, hostHeader).includes(refererUrl.origin)) {
        return new URL(path, refererUrl).toString();
      }
    }
    return new URL(path, request).toString();
  } catch {
    return path.startsWith("/") ? path : "/";
  }
}

export function themeFromCookieHeader(cookieHeader: string | null): "light" | "dark" {
  if (!cookieHeader) return "light";
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey !== "chate_theme") continue;
    try {
      return decodeURIComponent(rest.join("=")) === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  }
  return "light";
}

export function toggledTheme(current: "light" | "dark"): "light" | "dark" {
  return current === "dark" ? "light" : "dark";
}
