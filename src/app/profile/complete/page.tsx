import Link from "next/link";
import { redirect } from "next/navigation";
import { OtpRequestForm } from "@/components/otp-request";
import { otpProviderConfigured } from "@/domain/auth/model-gate";
import { getDatabase } from "@/server/db/runtime";
import { readGoogleSession } from "@/server/google-session";
import { hasVerifiedPhone } from "@/server/otp/service";

export default async function ProfilePage() {
  const session = await readGoogleSession();
  if (!session) redirect("/");
  let verified = false;
  try {
    verified = hasVerifiedPhone(getDatabase(), session.userId);
  } catch {
    // A store failure must not hide the form; the API answers with its own
    // Arabic error if the database is still unavailable at submit time.
    verified = false;
  }
  if (verified) {
    return (
      <section className="shell reading">
        <h1>إكمال الملف</h1>
        <article className="card">
          <p role="status">تم توثيق جوالك.</p>
          <p>يمكنك الآن استخدام النماذج وإرسال المقارنات من مساحة العمل.</p>
          <Link className="btn" href="/workspace">الانتقال إلى مساحة العمل</Link>
        </article>
      </section>
    );
  }
  const smsConfigured = otpProviderConfigured(process.env);
  return (
    <section className="shell reading">
      <h1>إكمال الملف</h1>
      <p>
        بعد دخول Google يُطلب رقم الجوال؛ يمكنك إدخاله بأي صيغة تختارها، ويُحفظ موحّداً بصيغة +9665XXXXXXXX.
        إدخال الرقم وحده لا يوثّقه؛ تبقى النماذج والرفع مغلقين حتى ينجح رمز التحقق.
      </p>
      {smsConfigured ? null : (
        <article className="card">
          <p role="status">
            مزود الرسائل غير مهيأ على هذا الخادم. لن يصل رمز SMS حتى يضبط المشغّل مزود إرسال الرسائل،
            ولا يمكن توثيق الجوال قبل ذلك.
          </p>
        </article>
      )}
      <OtpRequestForm />
    </section>
  );
}
