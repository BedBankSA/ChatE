import { AdminDashboard } from "@/components/admin-dashboard";
import { AdminDenied } from "@/components/admin-denied";
import { emptyDashboard, noticeText, toSearchParams, type AdminDashboardData } from "@/domain/admin/dashboard";
import { currentAdmin } from "@/server/admin/current";
import { buildAdminOverview } from "@/server/admin/overview";
import { getDatabase } from "@/server/db/runtime";

export const dynamic = "force-dynamic";

type AdminSearch = Record<string, string | string[] | undefined>;

const LOAD_ERROR = "تعذر قراءة قاعدة الإدارة. المؤشرات والجدول غير متاحين.";

export default async function AdminPage({ searchParams }: { searchParams: Promise<AdminSearch> }) {
  const admin = await currentAdmin();
  if (!admin) return <AdminDenied />;
  const query = await searchParams;
  const notice = noticeText(query.notice);
  // Build the view model before returning JSX: React does not render inside
  // try/catch, so a component built in the try block would escape the guard.
  let data: AdminDashboardData;
  try {
    data = buildAdminOverview(getDatabase(), {
      now: new Date(),
      params: toSearchParams(query),
      email: admin.email,
      actorId: admin.userId,
      notice,
      env: process.env,
    });
  } catch {
    data = emptyDashboard({
      email: admin.email,
      actorId: admin.userId,
      notice,
      loadError: LOAD_ERROR,
    });
  }
  return <AdminDashboard data={data} csrf={admin.csrf} />;
}
