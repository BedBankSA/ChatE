import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(`${root}/${path}`, "utf8");
}

function themeBlock(css: string, theme: "light" | "dark"): string {
  const marker = `html[data-theme="${theme}"]`;
  const start = css.indexOf(marker);
  const end = theme === "light" ? css.indexOf('html[data-theme="dark"]') : css.length;
  return css.slice(start, end);
}

describe("approved visual theme", () => {
  const css = source("src/app/globals.css");
  const light = themeBlock(css, "light");
  const dark = themeBlock(css, "dark");

  it("uses the approved light and dark hex values", () => {
    for (const hex of ["#E9E1D2", "#FBF7F0", "#1C1915", "#6E655C", "#8D4B2A"]) {
      expect(light).toContain(hex);
    }
    for (const hex of ["#141210", "#2A2521", "#F3EFE4", "#B7AA9A", "#E0A07A"]) {
      expect(dark).toContain(hex);
    }
    expect(light).toContain("background-color: #E9E1D2");
    expect(dark).toContain("background-color: #141210");
    expect(light).toContain("background-color: #FBF7F0");
    expect(dark).toContain("background-color: #2A2521");
    expect(css).not.toContain("#FFFAF3");
    expect(css).not.toContain("#5E564C");
    expect(css).not.toContain("#1E1B18");
    expect(css).not.toContain("#C8BBAA");
    expect(css.toLowerCase()).not.toContain("readex");
  });

  it("keeps IBM Plex Sans Arabic with the approved metrics and fallback", () => {
    const layout = source("src/app/layout.tsx");
    expect(css).toContain('"IBM Plex Sans Arabic", "Segoe UI", Tahoma, sans-serif');
    expect(layout).toContain("IBM_Plex_Sans_Arabic");
    expect(layout).toContain('fallback: ["Segoe UI", "Tahoma", "sans-serif"]');
    expect(layout).toContain('weight: ["400", "600"]');
    expect(css).toContain("font-weight: 600");
    expect(css).toContain("font-weight: 400");
    expect(css).toContain("line-height: 1.35");
    expect(css).toContain("line-height: 1.8");
    expect(css).toContain("letter-spacing: 0");
    expect(source("src/app/page.tsx")).not.toContain("letterSpacing");
  });

  it("keeps the theme toggle on the current page and stacks the mobile header", () => {
    const layout = source("src/app/layout.tsx");
    expect(layout).toContain('action="/api/theme"');
    expect(layout).toContain('method="post"');
    expect(layout).toContain("site-header-top");
    expect(layout).toContain("site-header-nav");
    expect(css).toContain(".site-header-top");
    expect(source("src/app/api/theme/route.ts")).toContain("themeRedirectTarget");
  });
});
