import path from "node:path";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "@/domain/auth/session";
import { migrateDatabase, openDatabase } from "@/server/db/index";
import { readStoredProfile } from "@/server/db/profiles";

const root = process.cwd();

function source(file: string): string {
  return readFileSync(`${root}/${file}`, "utf8");
}

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }));

vi.mock("@/server/db/runtime", () => ({
  getDatabase: () => {
    if (!state.db) throw new Error("test database is not ready");
    return state.db;
  },
}));

const SECRET = "gate-test-session-secret";
const USER_ID = "99999999-9999-4999-8999-999999999999";
const MIGRATIONS = path.join(process.cwd(), "migrations");

function database(): DatabaseSync {
  if (!state.db) throw new Error("test database is not ready");
  return state.db;
}

function cookie(): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = signSession({ userId: USER_ID, googleSub: USER_ID, exp: nowSec + 600, csrf: "csrf", iat: nowSec }, SECRET);
  return "chate_session=" + token;
}

function uploadRequest(): Request {
  const form = new FormData();
  form.append("files", new File(["hello"], "note.txt"));
  return new Request("http://localhost:3211/api/uploads", {
    method: "POST",
    headers: { "x-forwarded-host": "localhost", cookie: cookie() },
    body: form,
  });
}

beforeEach(() => {
  state.db = openDatabase(":memory:");
  migrateDatabase(database(), MIGRATIONS);
  database().prepare("INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)").run(
    USER_ID,
    "sub-" + USER_ID,
    "gate@example.com",
    "عميل",
  );
  database().prepare("INSERT INTO profiles (user_id) VALUES (?)").run(USER_ID);
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("OTP_PROVIDER", "");
  vi.stubEnv("SMS_PROVIDER", "");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "test-turnstile-secret");
  vi.stubEnv("TURNSTILE_EXPECTED_HOSTNAMES", "localhost");
  vi.stubEnv("APP_URL", "http://localhost:3211");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (state.db && state.db.isOpen) state.db.close();
  state.db = null;
});

describe("uploads follow the same phone-verification gate as comparisons", () => {
  it("refuses an unverified account before reading any upload bytes", async () => {
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(uploadRequest());
    const body = (await response.json()) as { error?: { code?: string } };
    expect([403, 503]).toContain(response.status);
    expect(["profile_incomplete", "OTP_UNCONFIGURED"]).toContain(body.error?.code);
    // No file row was written.
    const files = database().prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number };
    expect(files.n).toBe(0);
  });

  it("lets a verified account reach the Turnstile gate", async () => {
    database()
      .prepare("UPDATE profiles SET phone_e164 = ?, phone_verified_at = ? WHERE user_id = ?")
      .run("+966501234567", new Date().toISOString(), USER_ID);
    const { POST } = await import("@/app/api/uploads/route");
    const response = await POST(uploadRequest());
    const body = (await response.json()) as { error?: { code?: string } };
    expect(response.status).toBe(403);
    expect(body.error?.code).toBe("missing");
  });
});

describe("temporary suspension expiry and login loop", () => {
  const profileSeed = (status: string, until: string | null): void => {
    database().prepare("UPDATE users SET status = ?, suspended_until = ? WHERE id = ?").run(status, until, USER_ID);
  };

  it("reports an account as active once its temporary suspension has elapsed", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    profileSeed("suspended", past);
    expect(readStoredProfile(database(), USER_ID)?.status).toBe("active");
    // An indefinite suspension stays suspended.
    profileSeed("suspended", null);
    expect(readStoredProfile(database(), USER_ID)?.status).toBe("suspended");
    // A future temporary suspension is suspended.
    profileSeed("suspended", new Date(Date.now() + 60_000).toISOString());
    expect(readStoredProfile(database(), USER_ID)?.status).toBe("suspended");
  });

  it("refuses to mint a session for an actively suspended account", () => {
    const route = source("src/app/api/auth/google/route.ts");
    expect(route).toContain("suspensionActive");
    expect(route).toContain("readSessionStanding");
    expect(route).toContain("حسابك موقوف");
    // The cookie is only set after the suspension check in the source order.
    expect(route.indexOf("suspensionActive")).toBeLessThan(route.indexOf("response.cookies.set(\"chate_session\""));
  });
});

describe("logout and account are reachable from the UI", () => {
  it("renders a logout control and an account link in the header", () => {
    const layout = source("src/app/layout.tsx");
    expect(layout).toContain("/api/auth/logout");
    expect(layout).toContain("تسجيل الخروج");
    expect(layout).toContain('href="/account"');
    expect(layout).toContain('href="/verify-phone"');
  });
});
