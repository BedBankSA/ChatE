import type { Metadata } from "next";
import { IBM_Plex_Sans_Arabic } from "next/font/google";
import { cookies } from "next/headers";
import Link from "next/link";
import { VerifyPhoneBanner } from "@/components/verify-phone-banner";
import { currentAdmin } from "@/server/admin/current";
import { readGoogleSession } from "@/server/google-session";
import { appPhoneStateSafe } from "@/server/phone/state";
import { runtimeEnv } from "@/server/db/settings";
import "./globals.css";

const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ["arabic", "latin"],
  weight: ["400", "600"],
  display: "swap",
  fallback: ["Segoe UI", "Tahoma", "sans-serif"],
  variable: "--font-plex",
});

export const metadata: Metadata = {
  title: "ChatE",
  description: "سؤال واحد، عدة نماذج، إجابات متعددة...",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = (await cookies()).get("chate_theme")?.value === "dark" ? "dark" : "light";
  const session = await readGoogleSession();
  const admin = session ? await currentAdmin() : null;
  // Persistent activation banner: an old half-registered account keeps a visible
  // path to /verify-phone on every page until the phone is verified.
  const phoneState = session ? appPhoneStateSafe(session.userId) : null;
  const nextThemeLabel = theme === "dark" ? "التبديل إلى المظهر الفاتح" : "التبديل إلى المظهر الداكن";
  const runtime = runtimeEnv();
  const publicConfig = JSON.stringify({
    googleClientId: runtime.GOOGLE_CLIENT_ID ?? "",
    turnstileSiteKey: runtime.TURNSTILE_SITE_KEY ?? runtime.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "",
  }).replace(/</g, "\\u003c");
  return (
    <html lang="ar" dir="rtl" data-theme={theme} className={`${plexArabic.variable} ${plexArabic.className}`}>
      <head>
        <link rel="preconnect" href="https://challenges.cloudflare.com" />
      </head>
      <body>
        <a className="sr-only" href="#content">تخطى إلى المحتوى</a>
        <script id="chate-runtime-config" type="application/json" dangerouslySetInnerHTML={{ __html: publicConfig }} />
        <header className="shell site-header">
          <div className="site-header-top">
            <Link className="brand" href="/">ChatE</Link>
            <form className="theme-switch" action="/api/theme" method="post">
              <button className="btn secondary" type="submit" aria-label={nextThemeLabel}>
                {theme === "dark" ? "فاتح" : "داكن"}
              </button>
            </form>
          </div>
          <nav className="site-header-nav" aria-label="التنقل">
            {session ? <Link href="/workspace">مساحة العمل</Link> : null}
            {session ? <Link href="/account">حسابي</Link> : null}
            {session && phoneState && !phoneState.phoneVerifiedAt ? (
              <Link href="/verify-phone">تفعيل الجوال</Link>
            ) : null}
            {admin ? <Link href="/admin">الإدارة</Link> : null}
            <Link href="/history">السجل</Link>
            <Link href="/privacy">الخصوصية</Link>
            <Link href="/terms">الشروط</Link>
            {session ? (
              <form className="nav-form" action="/api/auth/logout" method="post">
                <button className="nav-button" type="submit">
                  تسجيل الخروج
                </button>
              </form>
            ) : null}
          </nav>
        </header>
        <main id="content">
          {session && phoneState && !phoneState.phoneVerifiedAt ? (
            <div className="shell">
              <VerifyPhoneBanner />
            </div>
          ) : null}
          {children}
        </main>
      </body>
    </html>
  );
}
