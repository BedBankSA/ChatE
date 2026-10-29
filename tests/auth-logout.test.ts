import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/auth/logout/route";

function request(origin: string | null, host = "chate.test"): Request {
  const headers: Record<string, string> = { host };
  if (origin) headers.origin = origin;
  return new Request("http://" + host + "/api/auth/logout", { method: "POST", headers });
}

describe("logout route", () => {
  it("clears both auth cookies on a same-origin POST", async () => {
    const response = await POST(request("http://chate.test"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://chate.test/");
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.startsWith("chate_session=") && /max-age=0/i.test(cookie))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith("chate_google_nonce=") && /max-age=0/i.test(cookie))).toBe(true);
  });

  it("refuses to clear cookies for a cross-origin request", async () => {
    const response = await POST(request("http://evil.example"));
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });
});
