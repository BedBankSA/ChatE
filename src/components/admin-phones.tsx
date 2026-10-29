import Link from "next/link";
import { AdminTabs } from "@/components/admin-tabs";
import { PHONE_ACTION_OPTIONS, phonesHref, type AdminPhonesView, type AdminPhoneCustomer } from "@/domain/admin/phones";
import { accountStatusLabel, formatWhen } from "@/domain/admin/dashboard";
import {
  PHONE_ACTION_LABELS,
  phoneActionLabel,
  phoneActorLabel,
  formatPhoneEventTime,
} from "@/domain/auth/phone-history";

/**
 * Admin screen for the permanent phone trail and the stuck-customer list.
 * Server-rendered: every action is a plain form POST to /api/admin/users with
 * the session CSRF token, so no client JavaScript is needed for admin changes.
 */
export function AdminPhones({ data, csrf }: { data: AdminPhonesView; csrf: string }) {
  return (
    <section className="shell admin-board">
      <AdminTabs active="phones" />
      <header>
        <h1>سجل الجوالات والعملاء العالقون</h1>
        <p className="meta">الجلسة الموثقة من Google: <span className="ltr">{data.email}</span></p>
        {data.notice ? <p role="status">{data.notice}</p> : null}
        {data.loadError ? <p role="status">{data.loadError}</p> : null}
      </header>

      <section className="admin-counts" aria-label="عدادات توثيق الجوال">
        <article className="card">
          <h2>كل الحسابات</h2>
          <strong>{data.counts.total}</strong>
        </article>
        <article className="card">
          <h2>جوالات موثقة</h2>
          <strong>{data.counts.verified}</strong>
        </article>
        <article className="card">
          <h2>عملاء عالقون (غير موثقين)</h2>
          <strong>{data.counts.unverified}</strong>
          <Link className="btn secondary" href={phonesHref({ status: "unverified" })}>
            حصر العالقين
          </Link>
        </article>
      </section>
      {data.counts.duplicatePhones > 0 ? (
        <article className="card">
          <p role="status">
            تنبيه: يوجد {data.counts.duplicatePhones} رقم موثّق مرتبط بأكثر من حساب (بيانات قديمة قبل تفعيل قيد
            التفرد). لن يُسمح بتكرارات جديدة، ويظهر الرقم في السجل لكل حساب؛ راجع العملاء وحدّد الرقم الصحيح لكل منهم.
          </p>
        </article>
      ) : null}

      <section className="card">
        <h2>المرشحات</h2>
        <form className="admin-filter-bar" action="/admin/phones" method="get">
          <label className="field-label" htmlFor="phones-q">
            بحث في الاسم أو البريد أو الجوال
          </label>
          <input id="phones-q" className="field" name="q" defaultValue={data.q} />
          <label htmlFor="phones-status">
            حالة التوثيق
            <select id="phones-status" className="field" name="status" defaultValue={data.status}>
              <option value="all">الكل</option>
              <option value="unverified">غير موثق (عالق)</option>
              <option value="verified">موثق</option>
            </select>
          </label>
          <label htmlFor="phones-event">
            نوع الحركة
            <select id="phones-event" className="field" name="event" defaultValue={data.action ?? ""}>
              <option value="">كل الحركات</option>
              {PHONE_ACTION_OPTIONS.map((action) => (
                <option key={action} value={action}>
                  {PHONE_ACTION_LABELS[action]}
                </option>
              ))}
            </select>
          </label>
          {data.userId ? <input type="hidden" name="userId" value={data.userId} /> : null}
          <button className="btn" type="submit">تطبيق</button>
          <Link className="btn secondary" href="/admin/phones">إعادة ضبط</Link>
        </form>
      </section>

      <section className="card">
        <h2>العملاء ({data.customerTotal})</h2>
        {data.customers.length ? (
          <div className="table-wrap" role="region" aria-label="جدول العملاء وأرقام الجوال" tabIndex={0}>
            <table className="admin-table">
              <caption className="sr-only">حسابات مع رقم الجوال وحالة التوثيق</caption>
              <thead>
                <tr>
                  <th>الاسم</th>
                  <th>البريد</th>
                  <th>رقم الجوال الحالي</th>
                  <th>حالة التوثيق</th>
                  <th>حالة الحساب</th>
                  <th>التسجيل</th>
                  <th>آخر نشاط</th>
                  <th>سجل الأرقام</th>
                  <th>إجراءات المشرف</th>
                </tr>
              </thead>
              <tbody>
                {data.customers.map((customer) => (
                  <tr key={customer.id}>
                    <td className="wrap">{customer.name}</td>
                    <td className="ltr">{customer.email}</td>
                    <td className="ltr">{customer.phone ?? "—"}</td>
                    <td>
                      <span className={customer.phoneVerifiedAt ? "phone-badge is-verified" : "phone-badge is-pending"}>
                        {customer.phoneVerifiedAt ? "موثق" : "غير موثق"}
                      </span>
                      {customer.phoneVerifiedAt ? (
                        <div className="meta">{formatWhen(customer.phoneVerifiedAt)}</div>
                      ) : null}
                    </td>
                    <td>{accountStatusLabel(customer.accountStatus)}</td>
                    <td>{formatWhen(customer.registeredAt)}</td>
                    <td>{formatWhen(customer.lastActivityAt)}</td>
                    <td>
                      <Link className="btn secondary" href={phonesHref({ userId: customer.id })}>
                        عرض السجل
                      </Link>
                    </td>
                    <td>
                      <AdminPhoneActions customer={customer} csrf={csrf} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>لا حسابات مطابقة لهذا المرشح.</p>
        )}
        <Pager data={data} />
      </section>

      <section className="card">
        <h2>سجل الحركات {data.userId ? "لعميل محدد" : "(أحدث ٥٠ حركة)"}</h2>
        <p className="meta">
          سجل دائم غير قابل للتعديل أو الحذف. يتضمن كل رقم قديم وكل حركة تفعيل ومنفذها.
        </p>
        {data.events.length ? (
          <div className="table-wrap" role="region" aria-label="سجل حركات أرقام الجوال" tabIndex={0}>
            <table className="admin-table phone-history">
              <caption className="sr-only">سجل حركات أرقام الجوال والتفعيل</caption>
              <thead>
                <tr>
                  <th>التاريخ</th>
                  <th>العميل</th>
                  <th>الحركة</th>
                  <th>الرقم القديم</th>
                  <th>الرقم الجديد</th>
                  <th>التوثيق</th>
                  <th>المنفّذ</th>
                  <th>الشبكة (IP)</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((event) => (
                  <tr key={event.id}>
                    <td>{formatPhoneEventTime(event.createdAt)}</td>
                    <td>
                      <span className="wrap">{event.userName ?? "—"}</span>
                      <div className="meta ltr">{event.userEmail ?? event.userId}</div>
                    </td>
                    <td>{phoneActionLabel(event.action)}</td>
                    <td className="ltr">{event.oldPhone ?? "—"}</td>
                    <td className="ltr">{event.newPhone}</td>
                    <td>{event.phoneVerified ? "موثق" : "غير موثق"}</td>
                    <td className="event-actor">
                      {phoneActorLabel(event.actorType)}
                      {event.actorUserId ? <div className="meta ltr">{event.actorUserId}</div> : null}
                    </td>
                    <td className="ltr">{event.ip ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>لا حركات مطابقة لهذا المرشح.</p>
        )}
        {data.userId ? (
          <Link className="btn secondary" href={phonesHref({ status: data.status })}>
            عرض سجل كل العملاء
          </Link>
        ) : null}
      </section>
    </section>
  );
}

function AdminPhoneActions({ customer, csrf }: { customer: AdminPhoneCustomer; csrf: string }) {
  return (
    <div className="admin-phone-actions">
      <form method="post" action="/api/admin/users">
        <input type="hidden" name="csrf" value={csrf} />
        <input type="hidden" name="userId" value={customer.id} />
        <input type="hidden" name="action" value="phone" />
        <input type="hidden" name="returnTo" value="phones" />
        <label className="sr-only" htmlFor={`admin-phone-${customer.id.replace(/[^\w-]/g, "")}`}>
          رقم الجوال الجديد لـ {customer.name}
        </label>
        <input
          id={`admin-phone-${customer.id.replace(/[^\w-]/g, "")}`}
          className="field"
          name="phone"
          inputMode="tel"
          placeholder="05xxxxxxxx"
          defaultValue={customer.phone ?? ""}
          dir="ltr"
        />
        <button className="btn secondary" type="submit">تعيين الرقم (يلغي التوثيق)</button>
      </form>
      {customer.phoneVerifiedAt ? (
        <form method="post" action="/api/admin/users">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="userId" value={customer.id} />
          <input type="hidden" name="action" value="unverify" />
          <input type="hidden" name="returnTo" value="phones" />
          <button className="btn secondary" type="submit">إلغاء التوثيق</button>
        </form>
      ) : null}
    </div>
  );
}

function Pager({ data }: { data: AdminPhonesView }) {
  const pages = Math.ceil(data.customerTotal / data.pageSize);
  if (pages <= 1) return null;
  return (
    <nav className="admin-toolbar" aria-label="صفحات العملاء">
      {data.page > 1 ? (
        <Link
          className="btn secondary"
          href={phonesHref({ q: data.q, status: data.status, action: data.action, userId: data.userId, page: data.page - 1 })}
        >
          السابق
        </Link>
      ) : null}
      {data.page < pages ? (
        <Link
          className="btn secondary"
          href={phonesHref({ q: data.q, status: data.status, action: data.action, userId: data.userId, page: data.page + 1 })}
        >
          التالي
        </Link>
      ) : null}
    </nav>
  );
}
