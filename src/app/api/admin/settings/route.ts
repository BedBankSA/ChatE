import { NextResponse } from "next/server";
import { adminDecision, adminDenialMessage, adminMutationAllowed } from "@/domain/admin/gate";
import { applySettingChange } from "@/server/admin/settings-actions";
import { testSystemSetting } from "@/server/admin/settings-test";
import { isSettingKey } from "@/server/db/settings";
import { storedGoogleAccount } from "@/server/admin/identity";
import { getDatabase } from "@/server/db/runtime";
import { runtimeEnv } from "@/server/db/settings";
import { readComparisonSession } from "@/server/google-session";
import { jsonError } from "@/server/http";

export const dynamic = "force-dynamic";

function forbidden(request: Request): Response {
  return NextResponse.redirect(new URL("/?forbidden=admin", request.url), 303);
}

function backToSettings(
  request: Request,
  notice: "saved" | "cleared" | "rejected",
  extra: { test?: "ok" | "fail"; key?: string; reason?: string } = {},
): Response {
  const target = new URL("/admin/settings", request.url);
  target.searchParams.set("notice", notice);
  if (extra.test) target.searchParams.set("test", extra.test);
  if (extra.key) target.searchParams.set("key", extra.key);
  if (extra.reason) target.searchParams.set("reason", extra.reason.slice(0, 240));
  return NextResponse.redirect(target, 303);
}

export async function POST(request: Request) {
  const session = await readComparisonSession(request);
  let db;
  try {
    db = getDatabase();
  } catch {
    return jsonError("تعذر فتح قاعدة الإعدادات.", "store", 500);
  }
  if (!session) return forbidden(request);
  const decision = adminDecision(session, storedGoogleAccount(db, session), runtimeEnv());
  if (!decision.ok) return forbidden(request);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return backToSettings(request, "rejected");
  }
  const csrf = typeof form.get("csrf") === "string" ? String(form.get("csrf")) : "";
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (!adminMutationAllowed({ origin: request.headers.get("origin"), host, csrf, sessionCsrf: session.csrf })) {
    return jsonError(adminDenialMessage("not_admin"), "origin", 403);
  }
  const rawKey = form.get("key");
  if (!isSettingKey(rawKey)) return backToSettings(request, "rejected");
  const key = rawKey;
  const wantsTest = form.get("action") === "test";
  try {
    if (wantsTest) {
      const tested = await testSystemSetting(db, key, { env: runtimeEnv() });
      return backToSettings(request, "saved", {
        test: tested.ok ? "ok" : "fail",
        key,
        reason: tested.message,
      });
    }
    const rawValue = form.get("clear") ? "" : form.get("value");
    const result = applySettingChange(db, decision.userId, key, rawValue, new Date());
    if (!result.ok) return backToSettings(request, "rejected", { key });
    // Auto-test immediately after a save, as requested, and surface the result.
    const tested = await testSystemSetting(db, key, { env: runtimeEnv() });
    return backToSettings(request, result.notice, {
      test: tested.ok ? "ok" : "fail",
      key,
      reason: tested.message,
    });
  } catch {
    return backToSettings(request, "rejected", { key });
  }
}
