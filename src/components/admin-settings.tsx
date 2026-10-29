"use client";

import { useState } from "react";
import {
  SETTING_GROUPS,
  SETTINGS_NOTICES,
  type AdminSettingsData,
  type SettingKey,
  type SettingView,
} from "@/domain/admin/settings";

/**
 * The browser never receives a stored secret. The masked hint comes from the
 * server (prefix + bullets + last four); the editable field is always empty and
 * the reveal toggle only reveals what the admin is typing right now.
 */
export function AdminSettings({ data, csrf }: { data: AdminSettingsData; csrf: string }) {
  const [revealed, setRevealed] = useState<SettingKey | null>(null);
  return (
    <section className="admin-settings" aria-label="إعدادات المفاتيح والمزودات">
      {data.notice ? <p className="ws-notice ws-notice-success" role="status">{data.notice}</p> : null}
      {data.testResult ? (
        <p
          className={data.testResult.ok ? "ws-notice ws-notice-success" : "ws-notice ws-notice-error"}
          role="status"
        >
          {data.testResult.ok ? "نجح اختبار " : "فشل اختبار "}
          {data.testResult.label}
          {data.testResult.reason ? ": " + data.testResult.reason : ""}
        </p>
      ) : null}
      <p className="meta">
        القيم المخزنة في قاعدة البيانات تُطبَّق فورًا على الطلبات التالية دون إعادة تشغيل.
        عند ترك الحقل فارغًا واختيار «مسح التجاوز» تعود القيمة إلى متغيرات البيئة.
      </p>
      {SETTING_GROUPS.map((group) => {
        const items = data.settings.filter((setting) => setting.group === group.id);
        if (items.length === 0) return null;
        return (
          <section className="card settings-group" key={group.id}>
            <header className="settings-group-head">
              <h2>{group.label}</h2>
              <p className="meta">{group.note}</p>
            </header>
            {items.map((setting) => (
              <SettingRow
                key={setting.key}
                setting={setting}
                csrf={csrf}
                revealed={revealed === setting.key}
                onToggle={() => setRevealed((current) => (current === setting.key ? null : setting.key))}
              />
            ))}
          </section>
        );
      })}
    </section>
  );
}

function SettingRow({
  setting,
  csrf,
  revealed,
  onToggle,
}: {
  setting: SettingView;
  csrf: string;
  revealed: boolean;
  onToggle: () => void;
}) {
  const inputId = "setting-" + setting.key.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return (
    <form className="settings-row" method="post" action="/api/admin/settings">
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="key" value={setting.key} />
      <div className="settings-copy">
        <label className="field-label" htmlFor={inputId}>{setting.label}</label>
        <p className="meta">{setting.hint}</p>
        <p className="settings-state">
          {setting.configured ? (
            <>
              <span className="ltr">{setting.masked}</span>
              <span className={"settings-badge is-" + setting.source}>
                {setting.source === "db" ? "من قاعدة البيانات" : "من متغيرات البيئة"}
              </span>
              {setting.updatedAt ? <span className="meta">آخر تحديث: {setting.updatedAt}</span> : null}
            </>
          ) : (
            <span className="settings-badge is-none">غير مهيّأ</span>
          )}
        </p>
      </div>
      <div className="settings-input">
        <input
          id={inputId}
          className="field ltr"
          name="value"
          type={revealed ? "text" : "password"}
          defaultValue=""
          autoComplete="new-password"
          spellCheck={false}
          placeholder="أدخل قيمة جديدة (اتركه فارغًا للإبقاء على الحالية)"
        />
        <div className="row-actions">
          <button className="btn" type="submit">حفظ</button>
          <button className="btn secondary" type="submit" name="action" value="test">اختبار</button>
          <button className="btn secondary" type="button" onClick={onToggle} aria-pressed={revealed}>
            {revealed ? "إخفاء" : "إظهار"}
          </button>
          {setting.source === "db" ? (
            <button className="btn secondary" type="submit" name="clear" value="1">مسح التجاوز</button>
          ) : null}
        </div>
      </div>
    </form>
  );
}

export function settingsNoticeText(notice: string | null): string | null {
  return notice ? SETTINGS_NOTICES[notice] ?? null : null;
}
