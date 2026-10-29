import Link from "next/link";
import { GoogleIntentButton } from "@/components/google-intent";
import { PhoneVerification } from "@/components/phone-verification";
import {
  formatPhoneEventTime,
  phoneActionLabel,
  phoneActorLabel,
  phoneStatusLabel,
} from "@/domain/auth/phone-history";
import { otpProviderConfigured } from "@/domain/auth/model-gate";
import { readStoredProfile } from "@/server/db/profiles";
import { getDatabase } from "@/server/db/runtime";
import { runtimeEnv } from "@/server/db/settings";
import { readGoogleSession } from "@/server/google-session";
import { readPhoneHistoryForUser, type PhoneHistoryRow } from "@/server/phone/audit";
import { readPhoneState } from "@/server/phone/state";
import type { Profile } from "@/domain/auth/profile";
import type { PhoneState } from "@/domain/auth/phone-history";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذر قراءة بيانات الحساب الآن. أعد المحاولة لاحقًا.";
const ANONYMOUS_TEXT = "سجّل الدخول بحساب Google لعرض بياناتك وتعديل رقم جوالك.";

/**
 * Customer profile dashboard: identity, current phone + verification state, a
 * verified-only phone change form (OTP gated), and the permanent phone history.
 */
export default async function AccountPage() {
  const session = await readGoogleSession();
  if (!session) {
    return (
      <section className="shell reading">
        <article className="card">
          <h1>لوحة بيانات العميل</h1>
          <p>{ANONYMOUS_TEXT}</p>
          <GoogleIntentButton />
        </article>
      </section>
    );
  }
  let profile: Profile | null = null;
  let phoneState: PhoneState | null = null;
  let history: PhoneHistoryRow[] = [];
  let loadError = false;
  try {
    const db = getDatabase();
    profile = readStoredProfile(db, session.userId);
    phoneState = readPhoneState(db, session.userId);
    history = readPhoneHistoryForUser(db, session.userId, 20);
    if (!profile) loadError = true;
  } catch {
    loadError = true;
  }
  const smsConfigured = otpProviderConfigured(runtimeEnv());
  const verified = Boolean(phoneState?.phoneVerifiedAt);
  return (
    <section className="shell reading account-page">
      <h1>لوحة بيانات العميل</h1>
      {loadError ? (
        <article className="card">
          <p role="status">{LOAD_ERROR}</p>
        </article>
      ) : (
        <>
          <article className="card">
            <h2>بيانات الحساب</h2>
            <dl className="account-grid">
              <div>
                <dt>الاسم</dt>
                <dd>{profile?.name ?? "—"}</dd>
              </div>
              <div>
                <dt>البريد الإلكتروني</dt>
                <dd className="ltr">{profile?.email ?? "—"}</dd>
              </div>
              <div>
                <dt>حالة الحساب</dt>
                <dd>{profile?.status === "suspended" ? "موقوف" : "نشط"}</dd>
              </div>
              <div>
                <dt>حالة الجوال</dt>
                <dd>
                  <span className={verified ? "phone-badge is-verified" : "phone-badge is-pending"}>
                    {phoneStatusLabel(phoneState)}
                  </span>
                </dd>
              </div>
            </dl>
            <p className="meta">الاسم والبريد يأتيان من حساب Google للقراءة فقط.</p>
          </article>

          <article className="card">
            <h2>رقم الجوال</h2>
            <p className="phone-value ltr" dir="ltr">
              {phoneState?.phoneE164 ?? "لا يوجد رقم بعد"}
            </p>
            {phoneState?.phoneVerifiedAt ? (
              <p className="meta">موثّق بتاريخ {formatPhoneEventTime(phoneState.phoneVerifiedAt)}</p>
            ) : (
              <p className="meta">
                رقمك غير موثّق بعد. لا تُفتح النماذج والرفع حتى تنجح عملية التحقق برمز SMS.
              </p>
            )}
            <PhoneVerification
              mode={verified ? "change" : "initial"}
              initialPhone={phoneState?.phoneE164 ?? null}
              nextPath="/workspace"
              smsConfigured={smsConfigured}
            />
            <p className="meta">
              لا يُستبدل الرقم إلا بعد تأكيد رمز التحقق، ولا يمكن استخدام رقم موثّق في حساب آخر.
            </p>
          </article>

          <article className="card">
            <h2>سجل الأرقام والتفعيل</h2>
            {history.length === 0 ? (
              <p>لا توجد حركات مسجلة بعد.</p>
            ) : (
              <div className="table-wrap" role="region" aria-label="سجل حركات أرقام الجوال" tabIndex={0}>
                <table className="admin-table phone-history">
                  <caption className="sr-only">سجل كامل لكل أرقام الجوال وحركات التفعيل</caption>
                  <thead>
                    <tr>
                      <th>الحركة</th>
                      <th>من</th>
                      <th>إلى</th>
                      <th>حالة التوثيق</th>
                      <th>المنفّذ</th>
                      <th>التاريخ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((row) => (
                      <tr key={row.id}>
                        <td>{phoneActionLabel(row.action)}</td>
                        <td className="ltr">{row.oldPhone ?? "—"}</td>
                        <td className="ltr">{row.newPhone}</td>
                        <td>{row.phoneVerified ? "موثّق" : "غير موثّق"}</td>
                        <td>{phoneActorLabel(row.actorType)}</td>
                        <td>{formatPhoneEventTime(row.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="meta">هذا السجل دائم ولا يمكن تعديله أو حذفه، ويُحفظ لكل حركة على رقمك.</p>
          </article>

          <p className="meta">
            <Link href="/workspace">مساحة العمل</Link> · <Link href="/history">سجل المقارنات</Link> ·{" "}
            <Link href="/privacy">الخصوصية</Link>
          </p>
        </>
      )}
    </section>
  );
}
