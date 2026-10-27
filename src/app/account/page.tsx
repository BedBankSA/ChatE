import { GoogleIntentButton } from "@/components/google-intent";
import { readGoogleSession } from "@/server/google-session";

export default async function AccountPage() {
  const session = await readGoogleSession();
  return (
    <section className="shell reading">
      <article className="card">
        <h1>الحساب</h1>
        <p>الاسم والبريد من Google للقراءة فقط. الجوال مطلوب ويُوحَّد إلى E.164 ولا يُعلَّم متحققًا قبل نجاح الرمز. العمر والمدينة اختياريان ولا يُستنتجان.</p>
        <p>حذف الحساب يزيل الملف والجلسات والمقارنات والملفات الخاصة عند اتصال قاعدة البيانات.</p>
        {session ? null : <GoogleIntentButton />}
      </article>
    </section>
  );
}
