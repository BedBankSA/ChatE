import { OtpRequestForm } from "@/components/otp-request";

export default function ProfilePage() {
  return (
    <section className="shell reading">
      <h1>إكمال الملف</h1>
      <p>بعد دخول Google يُطلب رقم الجوال مع مفتاح الدولة. النماذج والرفع يبقيان مغلقين حتى يكتمل التحقق. إدخال الرقم وحده لا يوثّقه.</p>
      <OtpRequestForm />
    </section>
  );
}
