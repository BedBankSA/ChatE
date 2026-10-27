import type { Metadata } from "next";
import { IBM_Plex_Sans_Arabic } from "next/font/google";
import { cookies } from "next/headers";
import Link from "next/link";
import { readGoogleSession } from "@/server/google-session";
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
  const nextThemeLabel = theme === "dark" ? "التبديل إلى المظهر الفاتح" : "التبديل إلى المظهر الداكن";
  return (
    <html lang="ar" dir="rtl" data-theme={theme} className={`${plexArabic.variable} ${plexArabic.className}`}>
      <head>
        <link rel="preconnect" href="https://challenges.cloudflare.com" />
      </head>
      <body>
        <a className="sr-only" href="#content">تخطى إلى المحتوى</a>
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
            <Link href="/history">السجل</Link>
            <Link href="/privacy">الخصوصية</Link>
          </nav>
        </header>
        <main id="content">{children}</main>
      </body>
    </html>
  );
}
