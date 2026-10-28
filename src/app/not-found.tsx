import Link from "next/link";

export default function NotFound() {
  return (
    <section className="shell reading">
      <h1>الصفحة غير موجودة</h1>
      <p>الرابط الذي طلبته غير موجود أو تغيّر. يمكنك العودة إلى الصفحة الرئيسية أو فتح مساحة العمل.</p>
      <p style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
        <Link className="btn" href="/">العودة إلى الرئيسية</Link>
        <Link className="btn secondary" href="/workspace">مساحة العمل</Link>
      </p>
    </section>
  );
}
