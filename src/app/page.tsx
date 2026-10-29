import Link from "next/link";
import { redirect } from "next/navigation";
import { GoogleIntentButton } from "@/components/google-intent";
import { readGoogleSession } from "@/server/google-session";

type HomeSearch = Record<string, string | string[] | undefined>;

export default async function HomePage({ searchParams }: { searchParams: Promise<HomeSearch> }) {
  const session = await readGoogleSession();
  const query = await searchParams;
  const forbidden = (Array.isArray(query.forbidden) ? query.forbidden[0] : query.forbidden) === "admin";
  if (session && !forbidden) redirect("/workspace");
  return (
    <section className="shell hero">
      <div className="hero-copy">
        <h1 className="hero-title">
          سؤال واحد.
          <br />
          إجابات متعددة...
        </h1>
        <p>تكتب سؤالك، وترفق ملفاتك إن شئت، وتختار النماذج.</p>
        {forbidden ? (
          <p className="ws-notice ws-notice-error" role="status">
            هذه الصفحة مخصصة للمشرف فقط. سجّل الدخول بحساب مصرّح له للإدارة.
          </p>
        ) : null}
        <div className="hero-actions">
          <GoogleIntentButton />
          {session ? <Link className="btn secondary" href="/workspace">ابدأ من مساحة العمل</Link> : null}
          <Link className="btn secondary" href="/privacy">الخصوصية</Link>
        </div>
      </div>
    </section>
  );
}
