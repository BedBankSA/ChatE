import { redirect } from "next/navigation";
import { AdminSettings } from "@/components/admin-settings";
import { AdminTabs } from "@/components/admin-tabs";
import { SETTING_GROUPS, SETTING_META, settingsNotice, type AdminSettingsData, type SettingKey } from "@/domain/admin/settings";
import { currentAdmin } from "@/server/admin/current";
import { getDatabase } from "@/server/db/runtime";
import { readSettingsView } from "@/server/db/settings";

export const dynamic = "force-dynamic";

type SettingsSearch = Record<string, string | string[] | undefined>;

const LOAD_ERROR = "تعذر قراءة الإعدادات الآن. أعد المحاولة لاحقًا.";

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function testResultFrom(query: SettingsSearch): AdminSettingsData["testResult"] {
  const status = first(query.test);
  if (status !== "ok" && status !== "fail") return null;
  const rawKey = first(query.key) as SettingKey;
  const label = rawKey in SETTING_META ? SETTING_META[rawKey].label : "الإعداد";
  const reason = first(query.reason).slice(0, 240) || null;
  return { ok: status === "ok", label, reason };
}

export default async function AdminSettingsPage({ searchParams }: { searchParams: Promise<SettingsSearch> }) {
  const admin = await currentAdmin();
  if (!admin) redirect("/?forbidden=admin");
  const query = await searchParams;
  let data: AdminSettingsData;
  try {
    data = {
      email: admin.email,
      groups: SETTING_GROUPS,
      settings: readSettingsView(getDatabase(), process.env),
      notice: settingsNotice(query.notice),
      testResult: testResultFrom(query),
    };
  } catch {
    data = { email: admin.email, groups: [], settings: [], notice: LOAD_ERROR, testResult: null };
  }
  return (
    <section className="shell admin-board">
      <AdminTabs active="settings" />
      <header>
        <h1>المفاتيح والمزودات</h1>
        <p className="meta">الجلسة الموثقة من Google: <span className="ltr">{data.email}</span></p>
      </header>
      <AdminSettings data={data} csrf={admin.csrf} />
    </section>
  );
}
