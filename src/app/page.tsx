import Link from "next/link";
import { GoogleIntentButton } from "@/components/google-intent";
import { readGoogleSession } from "@/server/google-session";

export default async function HomePage() {
  const session = await readGoogleSession();
  return (
    <section className="shell hero">
      <div className="hero-copy">
        <h1 className="hero-title">
          سؤال واحد.
          <br />
          إجابات متعددة...
        </h1>
        <p>تكتب سؤالك، وترفق ملفاتك إن شئت، وتختار النماذج.</p>
        <div className="hero-actions">
          <GoogleIntentButton />
          {session ? <Link className="btn secondary" href="/workspace">ابدأ من مساحة العمل</Link> : null}
          <Link className="btn secondary" href="/privacy">الخصوصية</Link>
        </div>
      </div>
    </section>
  );
}
