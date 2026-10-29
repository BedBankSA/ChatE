export function contentSecurityPolicy(development = false): string {
  const scriptSrc = development
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://challenges.cloudflare.com"
    : "script-src 'self' 'unsafe-inline' https://accounts.google.com https://challenges.cloudflare.com";
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self' https://accounts.google.com https://challenges.cloudflare.com",
    "frame-src https://accounts.google.com https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

export function securityHeaders(https: boolean, development = false): { key: string; value: string }[] {
  const headers = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    // Google Identity Services opens a popup, so the cross-window relationship
    // must be allowed to popups while every other window reference is severed.
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    { key: "Content-Security-Policy", value: contentSecurityPolicy(development) },
  ];
  if (https) {
    return [
      ...headers,
      { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
    ];
  }
  return headers;
}
