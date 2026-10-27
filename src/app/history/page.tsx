import { GoogleIntentButton } from "@/components/google-intent";
import { readGoogleSession } from "@/server/google-session";

export default async function HistoryPage() {
  const session = await readGoogleSession();
  return (
    <section className="shell reading">
      <article className="card">
        <h1>سجل المقارنات</h1>
        <p>يظهر هنا سجل حسابك بعد تسجيل الدخول.</p>
        {session ? null : <GoogleIntentButton />}
      </article>
    </section>
  );
}
