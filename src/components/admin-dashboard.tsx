import {
  accountStatusLabel,
  adminHref,
  auditActionLabel,
  countText,
  formatWhen,
  metricText,
  type AdminDashboardData,
  type AdminMetric,
  type AdminSecretVersion,
  type AdminUserView,
} from "@/domain/admin/dashboard";

const RANGES = [
  ["today", "اليوم"],
  ["7d", "٧ أيام"],
  ["30d", "٣٠ يومًا"],
] as const;

export function AdminDashboard({ data, csrf }: { data: AdminDashboardData; csrf: string }) {
  return (
    <section className="shell admin-board">
      <header>
        <h1>الإدارة</h1>
        <p className="meta">الجلسة الموثقة من Google: <span className="ltr">{data.email}</span></p>
        {data.notice ? <p>{data.notice}</p> : null}
        {data.loadError ? <p>{data.loadError}</p> : null}
      </header>
      <RangeNav data={data} />
      <MetricGrid metrics={data.metrics} note={data.presenceNote} />
      <UserSection data={data} csrf={csrf} />
      <AuditList items={data.audit} />
      <AlertList data={data} />
      <ServiceList services={data.services} />
      <HonestGaps data={data} />
    </section>
  );
}

function RangeNav({ data }: { data: AdminDashboardData }) {
  return (
    <nav className="admin-toolbar" aria-label="مدى التقرير">
      {RANGES.map(([key, label]) => (
        <a
          key={key}
          className={data.rangeKey === key ? "btn secondary is-selected" : "btn secondary"}
          href={adminHref({ rangeKey: key, query: data.query })}
          aria-current={data.rangeKey === key ? "page" : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

function MetricGrid({ metrics, note }: { metrics: AdminMetric[]; note: string }) {
  return (
    <section>
      <h2>المؤشرات</h2>
      <div className="metric-grid">
        {metrics.map((metric) => (
          <article className="card" key={metric.id}>
            <h3>{metric.label}</h3>
            <p className="metric-value">{metricText(metric)}</p>
            <p className="meta">{metric.detail}</p>
          </article>
        ))}
      </div>
      <p className="meta">{note}</p>
    </section>
  );
}

function UserSection({ data, csrf }: { data: AdminDashboardData; csrf: string }) {
  return (
    <section className="card">
      <h2>المستخدمون</h2>
      <form className="stack-form" action="/admin" method="get">
        <input type="hidden" name="range" value={data.rangeKey} />
        <label className="field-label" htmlFor="admin-q">بحث في الاسم أو البريد أو المدينة أو الجوال أو المعرف</label>
        <input id="admin-q" className="field" name="q" defaultValue={data.query} />
        <button className="btn" type="submit">بحث</button>
      </form>
      {data.users.length ? <UserTable data={data} csrf={csrf} /> : <p>لا حسابات مطابقة لهذا المرشح.</p>}
      <Pager data={data} />
    </section>
  );
}

function UserTable({ data, csrf }: { data: AdminDashboardData; csrf: string }) {
  return (
    <div className="table-wrap">
      <table className="admin-table">
        <caption className="sr-only">حسابات المستخدمين بلا نص المحادثة</caption>
        <thead>
          <tr>
            <th>الاسم</th>
            <th>البريد</th>
            <th>الجوال</th>
            <th>التحقق</th>
            <th>المدينة</th>
            <th>الحالة</th>
            <th>الأسئلة</th>
            <th>الاستدعاءات</th>
            <th>الرموز</th>
            <th>الحصة المتبقية</th>
            <th>إجراءات</th>
          </tr>
        </thead>
        <tbody>
          {data.users.map((user) => (
            <tr key={user.id}>
              <td className="wrap">{user.name}</td>
              <td className="ltr">{user.email}</td>
              <td className="ltr">{user.phone ?? "—"}</td>
              <td>{user.phoneVerified ? "موثّق" : "غير موثّق"}</td>
              <td>{user.city ?? "—"}</td>
              <td>{accountStatusLabel(user.status)}</td>
              <td>{countText(user.questionsInRange)}</td>
              <td>{countText(user.apiCalls)}</td>
              <td>{countText(user.tokens)}</td>
              <td>{countText(user.quotaRemaining)}</td>
              <td><UserActions user={user} csrf={csrf} actorId={data.actorId} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserActions({ user, csrf, actorId }: { user: AdminUserView; csrf: string; actorId: string }) {
  return (
    <div className="row-actions">
      {user.id === actorId ? <span className="meta">حسابك</span> : <StatusActions user={user} csrf={csrf} />}
      <QuotaAction user={user} csrf={csrf} />
    </div>
  );
}

function StatusActions({ user, csrf }: { user: AdminUserView; csrf: string }) {
  if (user.status !== "active") return <ActionForm userId={user.id} csrf={csrf} action="restore" label="تفعيل" />;
  return (
    <>
      <ActionForm userId={user.id} csrf={csrf} action="suspend" mode="indefinite" label="إيقاف" />
      <ActionForm userId={user.id} csrf={csrf} action="suspend" mode="7d" label="إيقاف ٧ أيام" />
    </>
  );
}

function ActionForm({ userId, csrf, action, mode, label }: { userId: string; csrf: string; action: string; mode?: string; label: string }) {
  return (
    <form method="post" action="/api/admin/users">
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="action" value={action} />
      {mode ? <input type="hidden" name="mode" value={mode} /> : null}
      <button className="btn secondary" type="submit">{label}</button>
    </form>
  );
}

function QuotaAction({ user, csrf }: { user: AdminUserView; csrf: string }) {
  const fieldId = `quota-${user.id.replace(/[^\w-]/g, "")}`;
  return (
    <form method="post" action="/api/admin/users" className="row-actions">
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="userId" value={user.id} />
      <input type="hidden" name="action" value="quota" />
      <label className="sr-only" htmlFor={fieldId}>حد الحصة لـ {user.name}</label>
      <input id={fieldId} className="field quota-field" name="limit" inputMode="numeric" defaultValue={user.quotaLimit ?? ""} />
      <button className="btn secondary" type="submit">تحديث الحصة</button>
    </form>
  );
}

function Pager({ data }: { data: AdminDashboardData }) {
  const pages = Math.ceil(data.userTotal / data.pageSize);
  if (pages <= 1) return null;
  return (
    <nav className="admin-toolbar" aria-label="صفحات المستخدمين">
      {data.page > 1 ? <a className="btn secondary" href={adminHref({ rangeKey: data.rangeKey, query: data.query, page: data.page - 1 })}>السابق</a> : null}
      {data.page < pages ? <a className="btn secondary" href={adminHref({ rangeKey: data.rangeKey, query: data.query, page: data.page + 1 })}>التالي</a> : null}
    </nav>
  );
}

function AuditList({ items }: { items: AdminDashboardData["audit"] }) {
  return (
    <section className="card">
      <h2>سجل التدقيق</h2>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item.id}>{auditActionLabel(item.action)} — <span className="ltr">{item.target}</span> — {formatWhen(item.at)}</li>
          ))}
        </ul>
      ) : <p>لا أحداث تدقيق بعد.</p>}
    </section>
  );
}

function AlertList({ data }: { data: AdminDashboardData }) {
  return (
    <section className="card">
      <h2>التنبيهات</h2>
      {data.alerts.length ? (
        <ul>{data.alerts.map((alert) => <li key={alert.kind}>{alert.message}</li>)}</ul>
      ) : <p>لا تنبيهات محلية في هذه الفترة.</p>}
    </section>
  );
}

function ServiceList({ services }: { services: AdminDashboardData["services"] }) {
  return (
    <section className="card">
      <h2>الخدمات</h2>
      {services.length ? (
        <ul>
          {services.map((service) => (
            <li key={service.service}>{service.purpose}: {service.configured ? "مهيأ" : "غير مهيأ"}</li>
          ))}
        </ul>
      ) : <p>لا حالة خدمات في هذا الرد.</p>}
    </section>
  );
}

function HonestGaps({ data }: { data: AdminDashboardData }) {
  return (
    <section className="card">
      <h2>أقسام غير موصولة</h2>
      <p>رصيد المزود: غير متاح. {data.providerReason}</p>
      <p>{data.secretsNote}</p>
      {data.secretVersions.length ? <SecretTable versions={data.secretVersions} /> : null}
      <p>{data.externalAlertReason}</p>
      <p>لا أزرار لتدوير الأسرار أو إرسال تنبيه خارجي من هذه الصفحة.</p>
    </section>
  );
}

function SecretTable({ versions }: { versions: AdminSecretVersion[] }) {
  return (
    <div className="table-wrap">
      <table className="admin-table">
        <caption>آخر أربعة أحرف فقط</caption>
        <thead>
          <tr>
            <th>الخدمة</th>
            <th>البيئة</th>
            <th>الإصدار</th>
            <th>الحالة</th>
            <th>آخر أربعة</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((version) => (
            <tr key={`${version.service}-${version.environment}-${version.version}`}>
              <td>{version.service}</td>
              <td>{version.environment}</td>
              <td>{version.version}</td>
              <td>{version.state}</td>
              <td className="ltr">{version.lastFour ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
