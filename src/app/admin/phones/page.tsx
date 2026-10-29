import { redirect } from "next/navigation";
import { AdminPhones } from "@/components/admin-phones";
import { emptyAdminPhones } from "@/domain/admin/phones";
import { noticeText, toSearchParams } from "@/domain/admin/dashboard";
import { currentAdmin } from "@/server/admin/current";
import { buildAdminPhones } from "@/server/admin/phones";
import { getDatabase } from "@/server/db/runtime";

export const dynamic = "force-dynamic";

type PhonesSearch = Record<string, string | string[] | undefined>;

export default async function AdminPhonesPage({ searchParams }: { searchParams: Promise<PhonesSearch> }) {
  const admin = await currentAdmin();
  // Strict server-side gate: non-admins never see the dashboard, not even a shell.
  if (!admin) redirect("/?forbidden=admin");
  const query = await searchParams;
  const notice = noticeText(query.notice);
  let data;
  try {
    data = buildAdminPhones(getDatabase(), {
      params: toSearchParams(query),
      notice,
      email: admin.email,
      actorId: admin.userId,
    });
  } catch {
    data = emptyAdminPhones({
      email: admin.email,
      actorId: admin.userId,
      notice,
      loadError: "تعذر قراءة قاعدة سجل الأرقام. المؤشرات والجداول غير متاحة مؤقتًا.",
    });
  }
  return <AdminPhones data={data} csrf={admin.csrf} />;
}
