/**
 * Public runtime configuration delivered by the server layout on every page.
 * These values are public by design (Google OAuth client id, Turnstile site
 * key), so an admin can change them in SQLite and users get the new values on
 * the next page load without a rebuild.
 */
export type RuntimeConfig = {
  googleClientId: string;
  turnstileSiteKey: string;
};

function fallback(): RuntimeConfig {
  return {
    googleClientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "",
    turnstileSiteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "",
  };
}

export function getRuntimeConfig(): RuntimeConfig {
  if (typeof document === "undefined") return fallback();
  const element = document.getElementById("chate-runtime-config");
  if (!element?.textContent) return fallback();
  try {
    const parsed = JSON.parse(element.textContent) as Partial<RuntimeConfig>;
    const base = fallback();
    return {
      googleClientId: typeof parsed.googleClientId === "string" && parsed.googleClientId ? parsed.googleClientId : base.googleClientId,
      turnstileSiteKey: typeof parsed.turnstileSiteKey === "string" && parsed.turnstileSiteKey ? parsed.turnstileSiteKey : base.turnstileSiteKey,
    };
  } catch {
    return fallback();
  }
}
