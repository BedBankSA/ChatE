import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/theme/route";

function themeRequest(headers: Record<string, string>, url = "http://localhost/api/theme") {
  return new Request(url, { method: "POST", headers });
}

describe("theme toggle route", () => {
  it("rejects a cross-site origin before touching the cookie", async () => {
    const response = await POST(themeRequest({ origin: "https://evil.example", host: "localhost" }));
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("returns a relative same-origin path, never an absolute Host-derived URL", async () => {
    const response = await POST(themeRequest({ referer: "http://localhost/workspace?tab=2", host: "localhost" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/workspace?tab=2");
    expect(response.headers.get("location")?.startsWith("http")).toBe(false);
    expect(response.headers.get("set-cookie")).toContain("chate_theme=dark");
  });

  it("rejects a foreign referer and never emits an off-site absolute redirect", async () => {
    const foreign = await POST(themeRequest({ referer: "https://evil.example/phish", host: "localhost" }));
    expect(foreign.status).toBe(403);
    // Even when Host is attacker-controlled the route can only emit a relative path.
    const spoofed = await POST(themeRequest({ origin: "http://evil.example", host: "evil.example" }, "http://evil.example/api/theme"));
    expect(spoofed.status).toBe(303);
    expect(spoofed.headers.get("location")).toBe("/");
  });
});
