import path from "node:path";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSession,
  sessionCookie,
  signSession,
  storedSessionAllows,
  type SessionPayload,
  type StoredSessionStanding,
} from "@/domain/auth/session";
import { migrateDatabase, openDatabase } from "@/server/db/index";
import { readSessionStanding } from "@/server/account-access";
import { readGoogleSession, sessionFromRequest } from "@/server/google-session";

const NOW = 1_700_000_000;
const SECRET = "test-session-secret";

function payload(patch: Partial<SessionPayload> = {}): SessionPayload {
  return { userId: "user-1", googleSub: "sub-1", exp: NOW + 600, iat: NOW, csrf: "csrf-1", ...patch };
}

function standing(patch: Partial<StoredSessionStanding> = {}): StoredSessionStanding {
  return { status: "active", suspendedUntil: null, sessionValidAfter: null, ...patch };
}

function signRaw(payloadValue: unknown, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payloadValue)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

describe("storedSessionAllows: signed token plus current account standing", () => {
  it("accepts an active account with no revocation", () => {
    expect(storedSessionAllows(payload(), standing(), NOW)).toBe(true);
  });

  it("rejects a token whose account is actively suspended", () => {
    expect(storedSessionAllows(payload(), standing({ status: "suspended" }), NOW)).toBe(false);
    expect(
      storedSessionAllows(
        payload(),
        standing({ status: "suspended", suspendedUntil: new Date((NOW + 60) * 1000).toISOString() }),
        NOW,
      ),
    ).toBe(false);
  });

  it("accepts a token after a temporary suspension has expired", () => {
    expect(
      storedSessionAllows(
        payload(),
        standing({ status: "suspended", suspendedUntil: new Date((NOW - 60) * 1000).toISOString() }),
        NOW,
      ),
    ).toBe(true);
  });

  it("rejects a token issued before session_valid_after (admin revocation)", () => {
    expect(
      storedSessionAllows(
        payload(),
        standing({ sessionValidAfter: new Date((NOW + 1) * 1000).toISOString() }),
        NOW,
      ),
    ).toBe(false);
  });

  it("accepts a token issued at or after the revocation timestamp", () => {
    expect(
      storedSessionAllows(
        payload(),
        standing({ sessionValidAfter: new Date((NOW - 5) * 1000).toISOString() }),
        NOW,
      ),
    ).toBe(true);
  });

  it("fails closed for a legacy token without iat once revocation is set", () => {
    expect(
      storedSessionAllows(
        payload({ iat: undefined }),
        standing({ sessionValidAfter: new Date((NOW - 5) * 1000).toISOString() }),
        NOW,
      ),
    ).toBe(false);
  });

  it("fails closed when the revocation timestamp cannot be parsed", () => {
    expect(storedSessionAllows(payload(), standing({ sessionValidAfter: "not-a-date" }), NOW)).toBe(false);
  });
});

describe("readSessionStanding: stored account facts", () => {
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrateDatabase(db, path.join(process.cwd(), "migrations"));
  });

  afterEach(() => {
    if (db.isOpen) db.close();
  });

  function seed(userId: string, status: string, until: string | null, validAfter: string | null): void {
    db.prepare(`
      INSERT INTO users (id, google_sub, email, name, status, suspended_until, session_valid_after)
      VALUES (?, ?, ?, 'user', ?, ?, ?)
    `).run(userId, `sub-${userId}`, `${userId}@example.com`, status, until, validAfter);
  }

  it("returns null for an unknown account (fail closed)", () => {
    expect(readSessionStanding(db, "missing-user")).toBeNull();
  });

  it("returns the status, suspension end, and revocation timestamp", () => {
    seed("user-1", "suspended", "2026-01-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z");
    expect(readSessionStanding(db, "user-1")).toEqual({
      status: "suspended",
      suspendedUntil: "2026-01-01T00:00:00.000Z",
      sessionValidAfter: "2025-12-01T00:00:00.000Z",
    });
  });
});

describe("sessionFromRequest: forged and revoked sessions", () => {
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    db = openDatabase(":memory:");
    migrateDatabase(db, path.join(process.cwd(), "migrations"));
  });

  afterEach(() => {
    if (db.isOpen) db.close();
    vi.unstubAllEnvs();
  });

  function seed(userId: string, patch: { status?: string; validAfter?: string | null } = {}): void {
    db.prepare(`
      INSERT INTO users (id, google_sub, email, name, status, session_valid_after)
      VALUES (?, ?, ?, 'user', ?, ?)
    `).run(userId, `sub-${userId}`, `${userId}@example.com`, patch.status ?? "active", patch.validAfter ?? null);
  }

  function requestWith(token?: string): Request {
    return new Request("http://localhost:3211/workspace", {
      headers: token ? { cookie: `chate_session=${token}` } : {},
    });
  }

  it("accepts a valid signed token for an existing active account", () => {
    seed("user-1");
    const session = sessionFromRequest(requestWith(signSession(payload(), SECRET)), NOW, db);
    expect(session?.userId).toBe("user-1");
  });

  it("rejects a forged token for an account that does not exist", () => {
    // The signature is valid (local test secret), but no such stored user exists.
    const session = sessionFromRequest(requestWith(signSession(payload({ userId: "ghost" }), SECRET)), NOW, db);
    expect(session).toBeNull();
  });

  it("rejects a valid token after the account is suspended", () => {
    seed("user-1", { status: "suspended" });
    expect(sessionFromRequest(requestWith(signSession(payload(), SECRET)), NOW, db)).toBeNull();
  });

  it("rejects a token minted before session_valid_after", () => {
    const validAfter = new Date((NOW + 10) * 1000).toISOString();
    seed("user-1", { validAfter });
    expect(sessionFromRequest(requestWith(signSession(payload(), SECRET)), NOW, db)).toBeNull();
    const fresh = sessionFromRequest(
      requestWith(signSession(payload({ iat: NOW + 20 }), SECRET)),
      NOW + 20,
      db,
    );
    expect(fresh?.userId).toBe("user-1");
  });

  it("ignores an expired or badly signed token", () => {
    seed("user-1");
    expect(sessionFromRequest(requestWith(signSession(payload({ exp: NOW - 1 }), SECRET)), NOW, db)).toBeNull();
    expect(sessionFromRequest(requestWith(signSession(payload(), "other-secret")), NOW, db)).toBeNull();
    expect(sessionFromRequest(requestWith(signRaw({ ...payload(), csrf: 42 })), NOW, db)).toBeNull();
    expect(sessionFromRequest(requestWith("garbage"), NOW, db)).toBeNull();
  });

  it("returns no session when the store is unavailable (fail closed)", () => {
    const closed = openDatabase(":memory:");
    closed.close();
    expect(sessionFromRequest(requestWith(signSession(payload(), SECRET)), NOW, closed)).toBeNull();
  });
});

describe("session cookie flags", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is HttpOnly, Lax, high priority and path-scoped", () => {
    expect(sessionCookie(false)).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      priority: "high",
    });
  });

  it("is Secure whenever the app is running in production, even if APP_URL is not https", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookie(false).secure).toBe(true);
    expect(sessionCookie(true).secure).toBe(true);
  });

  it("keeps plain-http local development usable", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(sessionCookie(false).secure).toBe(false);
  });
});

describe("readSession is not accidentally narrowed in tests", () => {
  it("still verifies a short local secret outside production", () => {
    const token = signSession(payload(), "short-secret");
    expect(readSession(token, "short-secret", NOW)?.userId).toBe("user-1");
  });
});

describe("readGoogleSession outside a request scope", () => {
  it("fails closed instead of throwing", async () => {
    await expect(readGoogleSession(NOW)).resolves.toBeNull();
  });
});
