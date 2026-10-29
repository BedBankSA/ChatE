import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHORTCUTS } from "@/domain/models/catalog";
import { readCookieSession, signSession } from "@/domain/auth/session";
import { themeFromCookieHeader, themeRedirectTarget, themeReturnPath, toggledTheme } from "@/domain/theme-return";
import {
  CHAT_SHORTCUT_MODEL,
  CODE_SHORTCUT_MODEL,
  EMPTY_QUESTION_MESSAGE,
  comparisonFailureMessage,
  emptyQuestionMessage,
  shortcutModel,
} from "@/domain/workspace-start";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(`${root}/${path}`, "utf8");
}

describe("theme return", () => {
  const requestUrl = "http://localhost:3211/api/theme";

  it("stays on a same-origin referer and otherwise returns home", () => {
    expect(themeReturnPath(null, requestUrl)).toBe("/");
    expect(themeReturnPath("http://evil.example/history", requestUrl)).toBe("/");
    expect(themeReturnPath("http://localhost:3211/history?tab=1", requestUrl)).toBe("/history?tab=1");
    expect(themeReturnPath("http://localhost:3211//evil.example", requestUrl)).toBe("/");
    expect(themeReturnPath("http://localhost:3211/history\\@evil", requestUrl)).toBe("/");
    expect(themeReturnPath("not a url", requestUrl)).toBe("/");
    expect(themeRedirectTarget("http://localhost:3211/history?tab=1", requestUrl, "localhost:3211")).toBe(
      "http://localhost:3211/history?tab=1",
    );
    expect(
      themeRedirectTarget("http://127.0.0.1:3211/history", "http://localhost:3211/api/theme", "127.0.0.1:3211"),
    ).toBe("http://127.0.0.1:3211/history");
    expect(themeRedirectTarget("http://evil.example/phish", requestUrl, "localhost:3211")).toBe("http://localhost:3211/");
    expect(themeRedirectTarget(null, requestUrl, "localhost:3211")).toBe("http://localhost:3211/");
  });

  it("toggles the theme cookie value without treating other values as dark", () => {
    expect(themeFromCookieHeader(null)).toBe("light");
    expect(themeFromCookieHeader("chate_theme=dark")).toBe("dark");
    expect(themeFromCookieHeader("other=1; chate_theme=light")).toBe("light");
    expect(toggledTheme("light")).toBe("dark");
    expect(toggledTheme("dark")).toBe("light");
  });
});

describe("workspace shortcuts", () => {
  it("selects the free chat and code models", () => {
    expect(shortcutModel("chat")).toBe(SHORTCUTS.conversation);
    expect(shortcutModel("code")).toBe(SHORTCUTS.code);
    expect(CHAT_SHORTCUT_MODEL).toBe("google/gemma-4-31b-it:free");
    expect(CODE_SHORTCUT_MODEL).toBe("recursive/flint-v1.0:free");
    expect(CHAT_SHORTCUT_MODEL.endsWith(":free")).toBe(true);
    expect(CODE_SHORTCUT_MODEL.endsWith(":free")).toBe(true);
  });

  it("asks for a question instead of sending an empty one", () => {
    expect(emptyQuestionMessage("")).toBe(EMPTY_QUESTION_MESSAGE);
    expect(emptyQuestionMessage("   ")).toBe(EMPTY_QUESTION_MESSAGE);
    expect(emptyQuestionMessage("ما الفرق؟")).toBeNull();
  });

  it("keeps the server Arabic error", () => {
    expect(comparisonFailureMessage({ error: { message: "يلزم تسجيل الدخول قبل إرسال المقارنة" } })).toBe(
      "يلزم تسجيل الدخول قبل إرسال المقارنة",
    );
    expect(comparisonFailureMessage({ error: { message: "تحقق Turnstile غير مهيأ" } })).toBe("تحقق Turnstile غير مهيأ");
    expect(comparisonFailureMessage(null)).toBe("تعذر إكمال الطلب");
  });
});

describe("google session cookie", () => {
  const secret = "test-session-secret";
  const now = 1_700_000_000;

  it("accepts only a signed unexpired chate session", () => {
    const token = signSession(
      { userId: "user-1", googleSub: "sub-1", exp: now + 60, csrf: "csrf-token" },
      secret,
    );
    expect(readCookieSession(token, secret, now)?.userId).toBe("user-1");
    expect(readCookieSession(undefined, secret, now)).toBeNull();
    expect(readCookieSession(token, undefined, now)).toBeNull();
    expect(readCookieSession(`${token}x`, secret, now)).toBeNull();
    expect(readCookieSession(token, secret, now + 60)).toBeNull();
  });
});

describe("visible copy", () => {
  it("removes the retired homepage, history, and workspace sentences", () => {
    const page = source("src/app/page.tsx");
    const layout = source("src/app/layout.tsx");
    const history = source("src/app/history/page.tsx");
    const workspace = source("src/components/workspace.tsx");
    const workspacePage = source("src/app/workspace/page.tsx");
    const removed = [
      "مقارنة نماذج عربية",
      "إجابات متجاورة",
      "كل نتيجة تصل وحدها",
      "واتصال Postgres",
      "لا تُعرض مقارنات حساب آخر",
      "السؤال يبقى ظاهرًا فوق البطاقات",
      "لا تُعرض إجابات مصطنعة",
    ];
    for (const sentence of removed) {
      expect(page).not.toContain(sentence);
      expect(layout).not.toContain(sentence);
      expect(history).not.toContain(sentence);
      expect(workspace).not.toContain(sentence);
    }
    expect(page).toContain("إجابات متعددة...");
    expect(page).toContain("تكتب سؤالك، وترفق ملفاتك إن شئت، وتختار النماذج.");
    expect(layout).toContain("إجابات متعددة...");
    expect(history).toContain("يظهر هنا سجل حسابك بعد تسجيل الدخول.");
    // The workspace asks for the question and keeps the primary action next to
    // it, so a rejected send can never be silent.
    expect(workspace).toContain("إرسال السؤال");
    expect(workspace).toContain("لا نتائج بعد");
    expect(workspace).toContain("MAX_COMPARISON_MODELS");
    expect(workspace).toContain("تحديد الكل");
    // Zero-friction flow: no quick-selection toolbar, models auto-selected,
    // failed cards filtered out of the grid.
    expect(workspace).not.toContain("اختيار سريع");
    expect(workspace).not.toContain("SHORTCUT_LABELS");
    expect(workspace).toContain("visibleRuns");
    expect(workspace).toContain("successSummaryText");
    expect(workspace).toContain("visibleComparisonRuns");
    // Runtime key changes must reach open tabs without a reload.
    expect(workspace).toContain("visibilitychange");
    expect(workspace).toContain("userTouchedSelection");
    // The picker must not offer non-answer or provider-restricted models.
    expect(workspace).toContain("isSelectableModel");
    expect(workspace).toContain("نماذج متخصصة غير مخصصة لأسئلة المقارنة");
    expect(page).toContain("readGoogleSession");
    expect(layout).toContain("readGoogleSession");
    expect(workspacePage).toContain('redirect("/")');
  });
});
