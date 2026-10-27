import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentSecurityPolicy } from "@/domain/security/headers";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(`${root}/${path}`, "utf8");
}

describe("official Google sign-in button", () => {
  const button = source("src/components/google-intent.tsx");
  const page = source("src/app/page.tsx");
  const turnstile = source("src/components/turnstile.ts");
  const intent = source("src/app/api/auth/google/intent/route.ts");
  const complete = source("src/app/api/auth/google/route.ts");

  it("removes the custom continue button from the homepage", () => {
    expect(button).not.toContain("متابعة الدخول");
    expect(page).not.toContain("متابعة الدخول");
    expect(source("src/app/history/page.tsx")).not.toContain("متابعة الدخول");
    expect(source("src/app/account/page.tsx")).not.toContain("متابعة الدخول");
    expect(page).toContain("GoogleIntentButton");
  });

  it("renders the official GIS button before Turnstile can fail", () => {
    expect(button).toContain("https://accounts.google.com/gsi/client");
    expect(button).toContain("renderButton");
    expect(button).toContain('dir="ltr"');
    expect(button).not.toContain("localStorage");
    expect(button).not.toContain("GOOGLE_CLIENT_SECRET");
    const mount = button.slice(button.indexOf("async function mountOfficialButton"), button.indexOf("void mountOfficialButton"));
    expect(mount).toContain("renderButton");
    expect(mount).not.toContain("issueTurnstileToken");
    expect(button).not.toMatch(/await issueTurnstileToken[\s\S]{0,1200}renderButton/);
  });

  it("initializes one official button and does not intercept Google popups", () => {
    expect(button).toContain('ux_mode: "popup"');
    expect(button).not.toMatch(/\.prompt\s*\(/);
    expect(button).not.toContain("googlePopupUrlToSkip");
    expect(button).not.toContain("installSingleGooglePopup");
    expect(button).not.toContain("window.open");
    expect(button).not.toContain("/gsi/select");
    expect(button).toContain("mountedHost");
    const mount = button.slice(button.indexOf("async function mountOfficialButton"), button.indexOf("void mountOfficialButton"));
    expect(mount.indexOf("mountedHost")).toBeLessThan(mount.indexOf("initialize"));
    expect(mount).not.toContain("replaceChildren");
    const effect = button.slice(button.indexOf("useEffect(() => {"), button.indexOf("async function finish"));
    expect(effect).not.toContain("warmLoginTurnstile");
    expect(button).toContain("takeLoginTurnstile");
    expect(source("src/app/layout.tsx")).not.toContain("GoogleIntentButton");
    expect(source("src/app/page.tsx").split("<GoogleIntentButton").length - 1).toBe(1);
    expect(source("src/app/history/page.tsx").split("<GoogleIntentButton").length - 1).toBe(1);
    expect(source("src/app/account/page.tsx").split("<GoogleIntentButton").length - 1).toBe(1);
  });

  it("loads Turnstile from api.js without turnstile.ready on an async or defer script", () => {
    expect(turnstile).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js");
    expect(turnstile).not.toMatch(/\.ready\s*\(/);
    expect(turnstile).not.toMatch(/\.async\s*=\s*true/);
    expect(turnstile).not.toMatch(/\.defer\s*=\s*true/);
    expect(turnstile).toContain('appearance: "interaction-only"');
    expect(turnstile).toContain('execution: "execute"');
  });

  it("checks Turnstile on login completion and still verifies the Google ID token", () => {
    expect(intent).not.toContain("gateTurnstile");
    expect(complete).toContain("gateTurnstile");
    expect(complete).toContain('"login"');
    expect(complete).toContain("verifyGoogleIdToken");
    expect(complete).toContain("acceptGoogleIdentity");
    expect(complete).toContain("chate_google_nonce");
    expect(complete).not.toContain("GOOGLE_CLIENT_SECRET");
    expect(complete).not.toContain("localStorage");
    expect(source("src/domain/auth/session.ts")).toContain("httpOnly: true");
  });
});

describe("development CSP", () => {
  it("keeps production free of unsafe-eval and allows it only for the dev server", () => {
    const production = contentSecurityPolicy();
    const development = contentSecurityPolicy(true);
    expect(production).not.toContain("unsafe-eval");
    expect(production).toContain("https://accounts.google.com");
    expect(production).toContain("https://challenges.cloudflare.com");
    expect(development).toContain("'unsafe-eval'");
    expect(development).toContain("https://accounts.google.com");
    expect(source("next.config.ts")).toContain("NODE_ENV");
  });
});

describe("google login routes", () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "test-google-client";
    process.env.SESSION_SECRET = "test-session-secret";
    process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret";
    process.env.TURNSTILE_EXPECTED_HOSTNAMES = "localhost";
    process.env.NODE_ENV = "test";
    process.env.APP_URL = "http://localhost:3211";
    vi.restoreAllMocks();
  });

  it("issues an HttpOnly nonce without a Turnstile token", async () => {
    const { POST } = await import("@/app/api/auth/google/intent/route");
    const response = await POST();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data?: { nonce?: string } };
    expect(body.data?.nonce).toEqual(expect.any(String));
    expect(body.data?.nonce?.length).toBeGreaterThan(10);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie).toContain("chate_google_nonce");
  });

  it("rejects login completion when Turnstile is missing", async () => {
    const { POST } = await import("@/app/api/auth/google/route");
    const response = await POST(
      new Request("http://localhost/api/auth/google", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "chate_google_nonce=nonce-1",
        },
        body: JSON.stringify({ credential: "a".repeat(40) }),
      }),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: { message?: string; code?: string } };
    expect(body.error?.message).toBe("تعذر التحقق الأمني. أعد المحاولة.");
    expect(body.error?.code).toBe("missing");
  });
});
