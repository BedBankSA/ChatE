import Link from "next/link";
import { redirect } from "next/navigation";
import { PhoneVerification } from "@/components/phone-verification";
import { isPhoneVerified, safeNextPath } from "@/domain/auth/phone-history";
import { otpProviderConfigured } from "@/domain/auth/model-gate";
import { getDatabase } from "@/server/db/runtime";
import { runtimeEnv } from "@/server/db/settings";
import { readGoogleSession } from "@/server/google-session";
import { readPhoneState } from "@/server/phone/state";

export const dynamic = "force-dynamic";

type VerifySearch = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstValue(value[0]);
  return null;
}

/**
 * /verify-phone — the single activation gate for every signed-in customer.
 *
 * Old accounts that were left half-registered land here immediately (workspace
 * and history redirect here), and the page never dead-ends: the OTP step can
 * edit the number, resend after a live countdown, and the whole flow is Arabic
 * and RTL. "next" is validated to a same-origin path before any redirect.
 */
export default async function VerifyPhonePage({ searchParams }: { searchParams: Promise<VerifySearch> }) {
  const session = await readGoogleSession();
  if (!session) redirect("/");
  const query = await searchParams;
  const nextPath = safeNextPath(firstValue(query.next), "/workspace");
  let state = null;
  try {
    state = readPhoneState(getDatabase(), session.userId);
  } catch {
    // The form still renders; the API answers with its own Arabic store error.
    state = null;
  }
  if (isPhoneVerified(state)) redirect(nextPath);
  const smsConfigured = otpProviderConfigured(runtimeEnv());
  return (
    <section className="shell reading verify-page">
      <p className="ws-eyebrow">خطوة واحدة قبل الاستخدام</p>
      <h1>تفعيل رقم الجوال</h1>
      <p>
        نرسل رمزًا نصيًا لمرة واحدة إلى رقمك، ولا تُفتح النماذج والرفع والمقارنات إلا بعد إدخال الرمز.
        إن أخطأت في كتابة الرقم يمكنك تعديله من شاشة الرمز مباشرة دون بدء التسجيل من جديد.
      </p>
      {smsConfigured ? null : (
        <article className="card">
          <p role="status">
            مزود الرسائل غير مهيأ على هذا الخادم حاليًا، لذلك لا يمكن إرسال رمز SMS. تواصل مع الدعم لإكمال التفعيل.
          </p>
        </article>
      )}
      <article className="card">
        <PhoneVerification
          mode="initial"
          initialPhone={state?.phoneE164 ?? null}
          nextPath={nextPath}
          smsConfigured={smsConfigured}
        />
      </article>
      <p className="meta">
        إن تعذّر وصول الرمز أو كان رقمك مسجّلًا في حساب آخر، تواصل مع الدعم. يمكنك أيضًا تسجيل الخروج من أعلى الصفحة.
      </p>
      <p className="meta">
        <Link href="/account">لوحة بياناتي</Link> · <Link href="/privacy">الخصوصية</Link>
      </p>
    </section>
  );
}
