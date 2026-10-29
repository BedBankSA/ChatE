import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isSuspended, sessionEnded } from "@/domain/admin/access";
import { adminDecision, adminMutationAllowed } from "@/domain/admin/gate";
import { parseAdminCommand } from "@/domain/admin/command";
import { AdminDashboard } from "@/components/admin-dashboard";
import type { AdminDashboardData } from "@/domain/admin/dashboard";
import { migrateDatabase, openDatabase } from "@/server/db/index";
import { storedGoogleAccount } from "@/server/admin/identity";
import { handleAdminOverview, handleAdminUsers } from "@/server/admin/http";

const migrationsDir = path.join(process.cwd(), "migrations");
const ownerEmail = "DR_EMAD@msn.com";
const canaries = [
  "CANARY-QUESTION-9f3a",
  "CANARY-ANSWER-9f3a",
  "CANARY-LABEL-9f3a",
  "CANARY-FILENAME-9f3a",
  "CANARY-STORAGE-9f3a",
  "CANARY-EVIDENCE-9f3a",
  "CANARY-JOB-9f3a",
  "CANARY-REASON-9f3a",
  "sk-or-v1-CANARYKEY999",
];

async function withDb(run: (db: DatabaseSync) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "chate-admin-"));
  const db = openDatabase(path.join(dir, "chate.sqlite"));
  try {
    migrateDatabase(db, migrationsDir);
    await run(db);
  } finally {
    if (db.isOpen && db.isTransaction) db.exec("ROLLBACK");
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function insertUser(db: DatabaseSync, id: string, email: string, name: string): void {
  db.prepare("INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)").run(id, id, email, name);
}

function seedPrivateRows(db: DatabaseSync, ownerId: string): void {
  insertUser(db, ownerId, ownerEmail, "المالك");
  insertUser(db, "visitor-1", "visitor@example.com", "زائر");
  db.prepare(`
    INSERT INTO comparisons (id, user_id, question, evidence_mode, idempotency_key, status)
    VALUES ('cmp-1', ?, ?, 'off', 'k1', 'done')
  `).run(ownerId, "CANARY-QUESTION-9f3a");
  db.prepare(`
    INSERT INTO model_runs (
      id, comparison_id, user_id, model_id, status, requested_settings, input_label, output_text
    ) VALUES ('run-1', 'cmp-1', ?, 'example/model:free', 'succeeded', '{}', ?, ?)
  `).run(ownerId, "CANARY-LABEL-9f3a", "CANARY-ANSWER-9f3a");
  db.prepare(`
    INSERT INTO evidence_snapshots (id, comparison_id, user_id, payload)
    VALUES ('ev-1', 'cmp-1', ?, ?)
  `).run(ownerId, JSON.stringify({ body: "CANARY-EVIDENCE-9f3a" }));
  db.prepare(`
    INSERT INTO files (id, user_id, storage_key, original_name, detected_type, byte_size, sha256, status)
    VALUES ('file-1', ?, ?, ?, 'text', 12, ?, 'stored')
  `).run(ownerId, "CANARY-STORAGE-9f3a", "CANARY-FILENAME-9f3a.txt", "ab".repeat(32));
  db.prepare(`
    INSERT INTO jobs (id, queue, payload, status, provider)
    VALUES ('job-1', 'model-run', ?, 'queued', 'none')
  `).run(JSON.stringify({ question: "CANARY-JOB-9f3a" }));
  db.prepare(`
    INSERT INTO operation_stats (operation_id, user_id, operation_type, occurred_at, status)
    VALUES ('question:cmp-1', ?, 'question', '2026-10-27T11:00:00.000Z', 'accepted')
  `).run(ownerId);
}

function sessionFor(id: string, csrf = "csrf-1") {
  return { userId: id, googleSub: id, exp: 2_000_000_000, csrf };
}

function assertNoPrivate(json: string): void {
  for (const canary of canaries) expect(json).not.toContain(canary);
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      keys.add(key.toLowerCase());
      walk(item);
    }
  };
  walk(JSON.parse(json) as unknown);
  for (const key of ["question", "output_text", "input_label", "original_name", "storage_key", "ciphertext", "payload", "content", "answer", "filename"]) {
    expect(keys.has(key)).toBe(false);
  }
}

describe("admin authorization", () => {
  const allow = { ADMIN_EMAILS: "dr_emad@msn.com", ADMIN_GOOGLE_SUBS: "" };

  it("treats the verified stored email as admin without trusting a typed email", () => {
    expect(adminDecision(
      { userId: "id-1", googleSub: "sub-1" },
      { userId: "id-1", googleSub: "sub-1", email: ownerEmail },
      allow,
      "someone@example.com",
    )).toMatchObject({ ok: true, email: ownerEmail });
    expect(adminDecision(
      { userId: "id-2", googleSub: "sub-2" },
      { userId: "id-2", googleSub: "sub-2", email: "other@example.com" },
      allow,
      "dr_emad@msn.com",
    )).toMatchObject({ ok: false, status: 403, code: "not_admin" });
    expect(adminDecision(null, { userId: "id-1", googleSub: "sub-1", email: ownerEmail }, allow, ownerEmail)).toMatchObject({
      ok: false,
      status: 401,
      code: "anonymous",
    });
    expect(adminDecision(
      { userId: "id-1", googleSub: "sub-1" },
      { userId: "id-1", googleSub: "sub-other", email: ownerEmail },
      allow,
    )).toMatchObject({ status: 401 });
  });

  it("honors ADMIN_GOOGLE_SUBS", () => {
    expect(adminDecision(
      { userId: "id-1", googleSub: "sub-owner" },
      { userId: "id-1", googleSub: "sub-owner", email: "other@example.com" },
      { ADMIN_GOOGLE_SUBS: "sub-owner", ADMIN_EMAILS: "" },
      "dr_emad@msn.com",
    ).ok).toBe(true);
  });

  it("accepts only a same-origin mutation with the session csrf", () => {
    expect(adminMutationAllowed({
      origin: "http://localhost:3211",
      host: "localhost:3211",
      csrf: "csrf-1",
      sessionCsrf: "csrf-1",
    })).toBe(true);
    expect(adminMutationAllowed({
      origin: "http://evil.example",
      host: "localhost:3211",
      csrf: "csrf-1",
      sessionCsrf: "csrf-1",
    })).toBe(false);
    expect(adminMutationAllowed({
      origin: "http://localhost:3211",
      host: "localhost:3211",
      csrf: "typed-email",
      sessionCsrf: "csrf-1",
    })).toBe(false);
  });

  it("parses account actions and drops emailed or pasted text", () => {
    const form = new FormData();
    form.set("action", "suspend");
    form.set("mode", "indefinite");
    form.set("userId", "visitor-1");
    form.set("email", "dr_emad@msn.com");
    form.set("question", "CANARY-QUESTION-9f3a");
    form.set("reason", "CANARY-REASON-9f3a");
    expect(parseAdminCommand(form)).toEqual({
      ok: true,
      command: { type: "suspend", userId: "visitor-1", mode: "indefinite" },
    });
  });

  it("keeps suspension checks used by account access", () => {
    expect(isSuspended("suspended", null, "2026-10-27T00:00:00.000Z")).toBe(true);
    expect(isSuspended("suspended", "2020-01-01T00:00:00.000Z", "2026-10-27T00:00:00.000Z")).toBe(false);
    expect(isSuspended("active", null, "2026-10-27T00:00:00.000Z")).toBe(false);
    expect(sessionEnded(null, undefined, 1_700_000_000)).toBe(false);
    expect(sessionEnded("2026-10-27T00:00:00.000Z", undefined, 1_700_000_000)).toBe(true);
  });
});

describe("admin http", () => {
  const now = new Date("2026-10-27T12:00:00.000Z");
  const env = {
    ADMIN_EMAILS: "dr_emad@msn.com",
    ADMIN_GOOGLE_SUBS: "",
    OPENROUTER_API_KEY: "sk-or-v1-CANARYKEY999",
  };

  it("returns 401 and 403 without private text, and 200 for the stored admin", async () => {
    await withDb(async (db) => {
      seedPrivateRows(db, "owner-1");
      const anonymous = await handleAdminOverview(new Request("http://localhost:3211/api/admin/overview?email=dr_emad@msn.com"), {
        session: null,
        db,
        env,
        now,
      });
      expect(anonymous.status).toBe(401);
      const deniedResponse = await handleAdminOverview(new Request("http://localhost:3211/api/admin/overview?email=dr_emad@msn.com"), {
        session: sessionFor("visitor-1"),
        db,
        env,
        now,
      });
      expect(deniedResponse.status).toBe(403);
      assertNoPrivate(JSON.stringify(await deniedResponse.json()));
      const allowed = await handleAdminOverview(new Request("http://localhost:3211/api/admin/overview?email=fake@example.com"), {
        session: sessionFor("owner-1"),
        db,
        env,
        now,
      });
      expect(allowed.status).toBe(200);
      const body = await allowed.json() as { ok: boolean; data: AdminDashboardData };
      const json = JSON.stringify(body);
      assertNoPrivate(json);
      expect(body.data.email).toBe(ownerEmail);
      expect(body.data.users.some((user) => user.name === "زائر" && user.email === "visitor@example.com")).toBe(true);
      expect(body.data.metrics.find((metric) => metric.id === "questions")?.value).toBe(1);
      expect(body.data.metrics.find((metric) => metric.id === "storageBytes")?.value).toBe(12);
      expect(body.data.services.find((service) => service.service === "openrouter")?.configured).toBe(true);
      expect(storedGoogleAccount(db, sessionFor("missing"))).toBeNull();
    });
  });

  it("applies suspend and quota for the admin and ignores a typed admin email", async () => {
    await withDb(async (db) => {
      seedPrivateRows(db, "owner-1");
      const forged = new FormData();
      forged.set("csrf", "csrf-1");
      forged.set("action", "suspend");
      forged.set("mode", "indefinite");
      forged.set("userId", "visitor-1");
      forged.set("email", "dr_emad@msn.com");
      forged.set("reason", "CANARY-REASON-9f3a");
      const rejected = await handleAdminUsers(new Request("http://localhost:3211/api/admin/users", {
        method: "POST",
        headers: { origin: "http://localhost:3211", host: "localhost:3211" },
        body: forged,
      }), { session: sessionFor("visitor-1"), db, env, now });
      expect(rejected.status).toBe(403);
      expect(db.prepare("SELECT status FROM users WHERE id = 'visitor-1'").get()).toMatchObject({ status: "active" });

      const suspend = new FormData();
      suspend.set("csrf", "csrf-1");
      suspend.set("action", "suspend");
      suspend.set("mode", "indefinite");
      suspend.set("userId", "visitor-1");
      suspend.set("actorId", "visitor-1");
      suspend.set("reason", "CANARY-REASON-9f3a");
      const saved = await handleAdminUsers(new Request("http://localhost:3211/api/admin/users", {
        method: "POST",
        headers: { origin: "http://localhost:3211", host: "localhost:3211" },
        body: suspend,
      }), { session: sessionFor("owner-1"), db, env, now });
      expect(saved.status).toBe(303);
      expect(saved.headers.get("location")).toContain("notice=saved");
      expect(db.prepare("SELECT status FROM users WHERE id = 'visitor-1'").get()).toMatchObject({ status: "suspended" });
      const audit = JSON.stringify(db.prepare("SELECT admin_user_id, action, metadata FROM admin_audit_events").all());
      expect(audit).toContain("owner-1");
      expect(audit).not.toContain("CANARY-REASON-9f3a");

      const self = new FormData();
      self.set("csrf", "csrf-1");
      self.set("action", "suspend");
      self.set("mode", "indefinite");
      self.set("userId", "owner-1");
      const blocked = await handleAdminUsers(new Request("http://localhost:3211/api/admin/users", {
        method: "POST",
        headers: { origin: "http://localhost:3211", host: "localhost:3211" },
        body: self,
      }), { session: sessionFor("owner-1"), db, env, now });
      expect(blocked.status).toBe(303);
      expect(blocked.headers.get("location")).toContain("notice=rejected");
      expect(db.prepare("SELECT status FROM users WHERE id = 'owner-1'").get()).toMatchObject({ status: "active" });

      const quota = new FormData();
      quota.set("csrf", "csrf-1");
      quota.set("action", "quota");
      quota.set("userId", "visitor-1");
      quota.set("limit", "40");
      const quotaSaved = await handleAdminUsers(new Request("http://localhost:3211/api/admin/users", {
        method: "POST",
        headers: { origin: "http://localhost:3211", host: "localhost:3211" },
        body: quota,
      }), { session: sessionFor("owner-1"), db, env, now });
      expect(quotaSaved.status).toBe(303);
      expect(quotaSaved.headers.get("location")).toContain("notice=saved");
      expect(db.prepare("SELECT limit_units FROM quota_accounts WHERE id = 'user:visitor-1'").get()).toMatchObject({ limit_units: 40 });
    });
  });
});

describe("admin page surface", () => {
  it("shows no admin controls until the dashboard is rendered", () => {
    // The denial surface is now a server-side redirect, so no component can
    // render admin chrome for a non-admin. Assert the page contract directly.
    const pageSource = readFileSync(path.join(process.cwd(), "src/app/admin/page.tsx"), "utf8");
    expect(pageSource).toContain("currentAdmin");
    expect(pageSource).toContain('redirect("/?forbidden=admin")');
    expect(pageSource).not.toMatch(/<form/i);

    const data: AdminDashboardData = {
      email: ownerEmail,
      actorId: "owner-1",
      rangeKey: "7d",
      query: "",
      metrics: [{ id: "questions", label: "الأسئلة", value: 0, previous: 0, source: "local", detail: "محلي" }],
      users: [{
        id: "visitor-1",
        name: "زائر",
        email: "visitor@example.com",
        role: "user",
        roleSource: "db",
        phone: null,
        phoneVerified: false,
        city: null,
        status: "active",
        questionsInRange: 0,
        apiCalls: 0,
        tokens: null,
        quotaLimit: null,
        quotaRemaining: null,
      }],
      userTotal: 1,
      page: 1,
      pageSize: 20,
      audit: [],
      alerts: [],
      externalAlertReason: "التنبيهات الخارجية غير موصولة. لا بريد ولا رسالة.",
      providerReason: "لا قراءة حية من المزود في هذه الصفحة.",
      secretsNote: "لا نسخ أسرار مخزنة. التعديل غير موصول، ولا يُعرض المفتاح.",
      secretVersions: [],
      services: [],
      presenceNote: "النشاط خلال 90 ثانية من آخر نبض، وليس تعدادًا مؤكدًا للرؤوس.",
      notice: null,
      loadError: null,
    };
    const dashboard = renderToStaticMarkup(createElement(AdminDashboard, { data, csrf: "csrf-1" }));
    expect(dashboard).toContain("المستخدمون");
    expect(dashboard).toContain("الأسئلة");
    expect(dashboard).toContain("<button");
    expect(dashboard).toContain("إيقاف");
    expect(dashboard).toContain("بحث");
    expect(dashboard).toContain(ownerEmail);
    expect(dashboard).toContain("لا قراءة حية من المزود");
    expect(dashboard).not.toContain("CANARY");
  });
});
