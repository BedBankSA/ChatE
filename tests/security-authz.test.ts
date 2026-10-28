import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAdmin, evaluateAccess } from "@/domain/auth/access";
import { adminAllowlist, adminGranted } from "@/domain/admin/access";
import { adminDecision, adminMutationAllowed } from "@/domain/admin/gate";
import { parseAdminCommand } from "@/domain/admin/command";
import { likeContains } from "@/domain/admin/user-query";
import { migrateDatabase, openDatabase } from "@/server/db/index";
import { readComparison } from "@/server/comparisons/store";

describe("admin authorization uses the stored account, not caller input", () => {
  const env = { ADMIN_GOOGLE_SUBS: "sub-admin", ADMIN_EMAILS: "Admin@Example.com" };
  const session = { userId: "user-admin", googleSub: "sub-admin" };
  const stored = { userId: "user-admin", googleSub: "sub-admin", email: "admin@example.com" };

  it("denies anonymous callers", () => {
    expect(adminDecision(null, null, env)).toMatchObject({ ok: false, status: 401, code: "anonymous" });
  });

  it("denies a valid session whose stored account cannot be loaded", () => {
    expect(adminDecision(session, null, env)).toMatchObject({ ok: false, status: 401, code: "anonymous" });
  });

  it("denies when the stored account does not match the session identity", () => {
    expect(
      adminDecision(session, { ...stored, googleSub: "other-sub" }, env),
    ).toMatchObject({ ok: false, status: 401, code: "anonymous" });
    expect(
      adminDecision(session, { ...stored, userId: "other-user" }, env),
    ).toMatchObject({ ok: false, status: 401, code: "anonymous" });
  });

  it("denies a stored non-admin account with 403", () => {
    const nonAdminSession = { userId: "user-1", googleSub: "sub-user" };
    const nonAdminStored = { userId: "user-1", googleSub: "sub-user", email: "user@example.com" };
    expect(
      adminDecision(nonAdminSession, nonAdminStored, {
        ADMIN_GOOGLE_SUBS: "sub-admin",
        ADMIN_EMAILS: "",
      }),
    ).toMatchObject({ ok: false, status: 403, code: "not_admin" });
  });

  it("allows a stored account on the sub allowlist and normalizes email case", () => {
    expect(adminDecision(session, stored, env)).toMatchObject({ ok: true, email: "admin@example.com" });
    expect(adminAllowlist(env)).toEqual({ subs: ["sub-admin"], emails: ["admin@example.com"] });
    expect(adminGranted({ googleSub: "sub-x", email: "admin@example.com" }, { ADMIN_EMAILS: "Admin@Example.com" })).toBe(true);
  });

  it("keeps the email fallback exact after lowercasing, with no substring match", () => {
    expect(isAdmin({ googleSub: "sub-x", email: "admin@example.com.evil" }, { subs: [], emails: ["admin@example.com"] })).toBe(false);
    expect(isAdmin({ googleSub: "sub-x", email: "ADMIN@EXAMPLE.COM" }, { subs: [], emails: ["admin@example.com"] })).toBe(true);
  });
});

describe("admin mutation CSRF gate", () => {
  const base = { origin: "http://localhost:3211", host: "localhost:3211", csrf: "csrf-1", sessionCsrf: "csrf-1" };

  it("accepts a same-host origin with the session CSRF token", () => {
    expect(adminMutationAllowed(base)).toBe(true);
  });

  it("rejects a missing or cross-site origin", () => {
    expect(adminMutationAllowed({ ...base, origin: null })).toBe(false);
    expect(adminMutationAllowed({ ...base, origin: "https://evil.example" })).toBe(false);
    expect(adminMutationAllowed({ ...base, origin: "not a url" })).toBe(false);
    expect(adminMutationAllowed({ ...base, host: null })).toBe(false);
  });

  it("rejects a missing or mismatched CSRF token", () => {
    expect(adminMutationAllowed({ ...base, csrf: "" })).toBe(false);
    expect(adminMutationAllowed({ ...base, csrf: "csrf-2" })).toBe(false);
    expect(adminMutationAllowed({ ...base, sessionCsrf: "" })).toBe(false);
  });

  it("compares the first Host value when a proxy appends a list", () => {
    expect(adminMutationAllowed({ ...base, host: "localhost:3211, internal:3000" })).toBe(true);
  });
});

describe("admin command parsing rejects injection-shaped identifiers", () => {
  it("rejects quotes, spaces, and oversized quotas", () => {
    const command = (values: Record<string, string>) => ({
      get: (name: string) => values[name],
    });
    expect(parseAdminCommand(command({ action: "restore", userId: "id' OR 1=1 --" })).ok).toBe(false);
    expect(parseAdminCommand(command({ action: "restore", userId: "a b" })).ok).toBe(false);
    expect(parseAdminCommand(command({ action: "quota", userId: "user-1", limit: "10000000" })).ok).toBe(false);
    expect(parseAdminCommand(command({ action: "quota", userId: "user-1", limit: "abc" })).ok).toBe(false);
    expect(parseAdminCommand(command({ action: "restore", userId: "user-1" }))).toMatchObject({
      ok: true,
      command: { type: "restore", userId: "user-1" },
    });
  });

  it("escapes LIKE wildcards for typed admin searches", () => {
    expect(likeContains("%_\\")).toBe("%\\%\\_\\\\%");
  });
});

describe("access decision ordering fails closed", () => {
  const base = {
    session: { userId: "u" },
    profileComplete: true,
    suspended: false,
    adminRoute: false,
    isAdmin: false,
    turnstileRequired: true,
    turnstileOk: true,
    quotaOk: true,
    modelAllowed: true,
  };

  it("returns anonymous before any deeper check", () => {
    expect(evaluateAccess({ ...base, session: null })).toMatchObject({ code: "anonymous", status: 401 });
  });

  it("returns suspended before profile/admin checks", () => {
    expect(evaluateAccess({ ...base, suspended: true, profileComplete: false })).toMatchObject({
      code: "suspended",
      status: 403,
    });
  });

  it("returns not_admin before profile-completion for admin routes", () => {
    expect(
      evaluateAccess({ ...base, adminRoute: true, profileComplete: false }),
    ).toMatchObject({ code: "not_admin", status: 403 });
  });

  it("then enforces profile, Turnstile, quota, and model policy", () => {
    expect(evaluateAccess({ ...base, profileComplete: false })).toMatchObject({ code: "profile_incomplete" });
    expect(evaluateAccess({ ...base, turnstileOk: false })).toMatchObject({ code: "turnstile" });
    expect(evaluateAccess({ ...base, quotaOk: false })).toMatchObject({ code: "quota", status: 429 });
    expect(evaluateAccess({ ...base, modelAllowed: false })).toMatchObject({ code: "model_policy" });
    expect(evaluateAccess(base)).toEqual({ ok: true });
  });
});

describe("comparison ownership (IDOR regression)", () => {
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrateDatabase(db, path.join(process.cwd(), "migrations"));
    for (const id of ["user-a", "user-b"]) {
      db.prepare("INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, 'u')").run(
        id,
        "sub-" + id,
        id + "@example.com",
      );
    }
    for (const [id, owner] of [["cmp-a", "user-a"], ["cmp-b", "user-b"]] as const) {
      db.prepare(
        "INSERT INTO comparisons (id, user_id, question, evidence_mode, idempotency_key, status) VALUES (?, ?, ?, 'native', ?, 'closed')",
      ).run(id, owner, "سؤال " + id, "key-" + id);
      db.prepare(
        "INSERT INTO model_runs (id, comparison_id, user_id, model_id, status, requested_settings, input_label, output_text) VALUES (?, ?, ?, 'google/gemma-4-31b-it:free', 'completed', '{}', '', ?)",
      ).run("run-" + id, id, owner, "answer " + id);
    }
  });

  afterEach(() => {
    if (db.isOpen) db.close();
  });

  it("only returns a comparison to its owner", () => {
    expect(readComparison(db, "user-a", "cmp-a")?.question).toBe("سؤال cmp-a");
    expect(readComparison(db, "user-a", "cmp-b")).toBeNull();
    expect(readComparison(db, "user-b", "cmp-b")?.question).toBe("سؤال cmp-b");
  });

  it("returns null for unknown and injection-shaped identifiers", () => {
    expect(readComparison(db, "user-a", "11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(readComparison(db, "user-a", "' OR 1=1 --")).toBeNull();
    expect(readComparison(db, "user-a", "cmp-a' OR '1'='1")).toBeNull();
  });

  it("does not leak another user's runs through the shared read path", () => {
    const own = readComparison(db, "user-a", "cmp-a");
    expect(own?.runs.map((run) => run.outputText)).toEqual(["answer cmp-a"]);
    expect(JSON.stringify(own)).not.toContain("answer cmp-b");
  });
});
