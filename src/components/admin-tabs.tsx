import Link from "next/link";

const TABS = [
  { id: "dashboard", href: "/admin", label: "إدارة العملاء" },
  { id: "settings", href: "/admin/settings", label: "المفاتيح والمزودات" },
] as const;

export function AdminTabs({ active }: { active: "dashboard" | "settings" }) {
  return (
    <nav className="admin-tabs" aria-label="أقسام الإدارة">
      {TABS.map((tab) => (
        <Link
          key={tab.id}
          className={tab.id === active ? "btn secondary is-selected" : "btn secondary"}
          href={tab.href}
          aria-current={tab.id === active ? "page" : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
