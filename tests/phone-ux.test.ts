import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(`${root}/${path}`, "utf8");
}

describe("activation gate wiring (stuck + new customers)", () => {
  it("ships a canonical /verify-phone page with a safe return path", () => {
    expect(existsSync(`${root}/src/app/verify-phone/page.tsx`)).toBe(true);
    const page = source("src/app/verify-phone/page.tsx");
    expect(page).toContain("تفعيل رقم الجوال");
    expect(page).toContain("safeNextPath");
    expect(page).toContain("PhoneVerification");
    expect(page).toContain("isPhoneVerified");
    expect(page).toContain("redirect");
  });

  it("keeps the old activation URL working as an alias", () => {
    const alias = source("src/app/profile/complete/page.tsx");
    expect(alias).toContain('redirect("/verify-phone")');
  });

  it("redirects unverified sessions away from workspace and history", () => {
    const workspace = source("src/app/workspace/page.tsx");
    expect(workspace).toContain("redirectUnverifiedToVerifyPhone");
    expect(workspace).toContain('redirect("/")');
    const history = source("src/app/history/page.tsx");
    expect(history).toContain("redirectUnverifiedToVerifyPhone");
  });

  it("renders a persistent activation banner in the root layout", () => {
    const layout = source("src/app/layout.tsx");
    expect(layout).toContain("VerifyPhoneBanner");
    expect(layout).toContain("appPhoneStateSafe");
    expect(layout).toContain("phoneVerifiedAt");
    const banner = source("src/components/verify-phone-banner.tsx");
    expect(banner).toContain("حسابك غير مكتمل");
    expect(banner).toContain("usePathname");
    expect(banner).toContain("VERIFY_PHONE_PATH");
  });

  it("sends a freshly logged-in unverified customer straight to the gate", () => {
    const route = source("src/app/api/auth/google/route.ts");
    expect(route).toContain("verifyPhoneHref");
    expect(route).toContain("next");
    const intent = source("src/components/google-intent.tsx");
    expect(intent).toContain("body.data?.next");
  });
});

describe("OTP screen UX: no dead ends", () => {
  const component = source("src/components/phone-verification.tsx");

  it("offers editing the phone from inside the OTP step", () => {
    expect(component).toContain("تعديل رقم الجوال");
    expect(component).toContain("setPhase(\"phone\")");
  });

  it("shows a live resend countdown and disables the button while it runs", () => {
    expect(component).toContain("secondsLeft");
    expect(component).toContain("إعادة الإرسال بعد");
    expect(component).toContain("setInterval");
    expect(component).toContain("disabled={pending || secondsLeft > 0}");
  });

  it("is RTL-friendly and accessible", () => {
    expect(component).toContain("dir=\"ltr\"");
    expect(component).toContain("autoComplete=\"one-time-code\"");
    expect(component).toContain("inputMode=\"numeric\"");
    expect(component).toContain("aria-label");
    expect(component).toContain("role={tone ===");
    expect(component).toContain("autoFocus");
  });

  it("actually sends the single-use Turnstile token with the OTP request", () => {
    // Regression: the component used to mint a token and post only { phone },
    // which made every activation fail with 403 in production.
    expect(component).toContain('"cf-turnstile-response": token');
    expect(component).toContain("issueTurnstileToken(\"otp\")");
  });

  it("keeps the customer on a recoverable step for every server error", () => {
    expect(component).toContain("retryAfterSeconds");
    expect(component).toContain("remainingAttempts");
    expect(component).toContain("NOT_CONFIGURED");
  });
});

describe("customer dashboard and admin audit surface", () => {
  it("turns /account into a real profile dashboard with phone history", () => {
    const account = source("src/app/account/page.tsx");
    expect(account).toContain("لوحة بيانات العميل");
    expect(account).toContain("سجل الأرقام والتفعيل");
    expect(account).toContain("PhoneVerification");
    expect(account).toContain("readPhoneHistoryForUser");
    expect(account).toContain("phoneStatusLabel");
  });

  it("adds the admin phone-history tab, stuck-customer filter and change forms", () => {
    const tabs = source("src/components/admin-tabs.tsx");
    expect(tabs).toContain("/admin/phones");
    expect(tabs).toContain("سجل الجوالات");
    expect(existsSync(`${root}/src/app/admin/phones/page.tsx`)).toBe(true);
    const page = source("src/app/admin/phones/page.tsx");
    expect(page).toContain("currentAdmin");
    expect(page).toContain("forbidden=admin");
    const component = source("src/components/admin-phones.tsx");
    expect(component).toContain("العملاء العالقون");
    expect(component).toContain("إلغاء التوثيق");
    expect(component).toContain("سجل الحركات");
    expect(component).toContain("csrf");
    expect(component).toContain("phone-badge");
  });

  it("exposes the stuck-customer counter on the main admin dashboard", () => {
    expect(source("src/server/admin/overview.ts")).toContain("phoneUnverified");
    expect(source("src/components/admin-dashboard.tsx")).toContain("/admin/phones?status=unverified");
  });
});

describe("P0 server contracts", () => {
  it("defines the append-only audit migration with both triggers", () => {
    const migration = source("migrations/008_phone_audit.sql");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS phone_history");
    expect(migration).toContain("phone_history_no_update");
    expect(migration).toContain("phone_history_no_delete");
    expect(migration).toContain("PHONE_HISTORY_APPEND_ONLY");
    expect(migration).toContain("CREATE INDEX");
  });

  it("hardens both OTP routes with ownership checks, rate limits and audit writes", () => {
    const send = source("src/app/api/otp/send/route.ts");
    expect(send).toContain("findVerifiedPhoneOwner");
    expect(send).toContain("recordPhoneAudit");
    expect(send).toContain("countRecentSendsToPhone");
    expect(send).toContain("OTP_MAX_SENDS");
    expect(send).toContain("phone.e164");
    const verify = source("src/app/api/otp/verify/route.ts");
    expect(verify).toContain("rateLimitResponse");
    expect(verify).toContain("OTP_VERIFIED");
    expect(verify).toContain("PHONE_CHANGED_BY_USER");
    expect(verify).toContain("findVerifiedPhoneOwner");
    expect(verify).toContain("FAILED_OTP_ATTEMPT");
  });
});
