import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAdminCommand } from "@/domain/admin/command";
import { PhoneQueryError, parsePhoneListQuery } from "@/domain/admin/phones";
import { applyAdminAction } from "@/server/admin/actions";
import { buildAdminPhones } from "@/server/admin/phones";
import { insertUser } from "@/server/db/accounts";
import { migrateDatabase, openDatabase } from "@/server/db/index";
import { readPhoneHistoryForUser, readProfilePhone, recordPhoneAudit } from "@/server/phone/audit";

const MIGRATIONS = path.join(process.cwd(), "migrations");
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
const VERIFIED_USER = "aaaaaaaa-0000-4000-8000-000000000002";
const STUCK_USER = "aaaaaaaa-0000-4000-8000-000000000003";
const PHONE = "+966501234567";
const OTHER_PHONE = "+966555555555";
const NOW = new Date("2026-10-29T09:00:00.000Z");

let db: DatabaseSync;

function seed(id: string, name: string, email: string): void {
  insertUser(db, { id, googleSub: "sub-" + id, email, name });
  db.prepare("INSERT INTO profiles (user_id) VALUES (?)").run(id);
}

function setPhone(id: string, phone: string, verified: boolean): void {
  db.prepare("UPDATE profiles SET phone_e164 = ?, phone_verified_at = ? WHERE user_id = ?").run(
    phone,
    verified ? NOW.toISOString() : null,
    id,
  );
}

function form(fields: Record<string, string | null>): { get(name: string): unknown } {
  return { get: (name: string) => fields[name] ?? null };
}

function view(params: string): ReturnType<typeof buildAdminPhones> {
  return buildAdminPhones(db, {
    params: new URLSearchParams(params),
    notice: null,
    email: "admin@example.com",
    actorId: ADMIN,
  });
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrateDatabase(db, MIGRATIONS);
  seed(ADMIN, "المشرف", "admin@example.com");
  seed(VERIFIED_USER, "عميل موثق", "verified@example.com");
  seed(STUCK_USER, "عميل عالق", "stuck@example.com");
  setPhone(VERIFIED_USER, PHONE, true);
  setPhone(STUCK_USER, OTHER_PHONE, false);
});

afterEach(() => {
  if (db.isOpen) db.close();
});

describe("admin phone history read model", () => {
  it("counts verified vs stuck customers and filters them", () => {
    const all = view("");
    expect(all.counts).toEqual({ total: 3, verified: 1, unverified: 2, duplicatePhones: 0 });
    expect(all.customerTotal).toBe(3);

    const unverified = view("status=unverified");
    expect(unverified.customerTotal).toBe(2);
    expect(unverified.customers.map((row) => row.id).sort()).toEqual([ADMIN, STUCK_USER].sort());
    expect(unverified.customers.every((row) => row.phoneVerifiedAt === null)).toBe(true);

    const verified = view("status=verified");
    expect(verified.customerTotal).toBe(1);
    expect(verified.customers[0]?.id).toBe(VERIFIED_USER);
    // Stuck customers are listed before verified ones so the operator sees them first.
    expect(all.customers[0]?.phoneVerifiedAt).toBeNull();
  });

  it("searches by national phone spelling, name and filters the permanent events", () => {
    recordPhoneAudit(db, {
      userId: VERIFIED_USER,
      oldPhone: null,
      newPhone: PHONE,
      action: "OTP_SENT",
      phoneVerified: false,
      actorType: "user",
      actorUserId: VERIFIED_USER,
      ip: "203.0.113.5",
      now: NOW,
    });
    recordPhoneAudit(db, {
      userId: VERIFIED_USER,
      oldPhone: PHONE,
      newPhone: OTHER_PHONE,
      action: "OTP_VERIFIED",
      phoneVerified: true,
      actorType: "user",
      actorUserId: VERIFIED_USER,
      now: new Date(NOW.getTime() + 1000),
    });
    recordPhoneAudit(db, {
      userId: STUCK_USER,
      oldPhone: null,
      newPhone: OTHER_PHONE,
      action: "INITIAL_ENTRY",
      phoneVerified: false,
      actorType: "user",
      actorUserId: STUCK_USER,
      now: new Date(NOW.getTime() + 2000),
    });

    expect(view("q=0501234567").customers.map((row) => row.id)).toContain(VERIFIED_USER);
    expect(view("q=عميل عالق").customers.map((row) => row.id)).toEqual([STUCK_USER]);
    const sentOnly = view("event=OTP_SENT");
    expect(sentOnly.events).toHaveLength(1);
    expect(sentOnly.events[0]?.action).toBe("OTP_SENT");
    expect(sentOnly.events[0]?.ip).toBe("203.0.113.5");
    const byUser = view("userId=" + VERIFIED_USER);
    expect(byUser.events).toHaveLength(2);
    expect(byUser.customers.map((row) => row.id)).toEqual([VERIFIED_USER]);
  });

  it("reports a load error instead of throwing on invalid filters", () => {
    const viewWithError = view("status=everything");
    expect(viewWithError.loadError).not.toBeNull();
    expect(viewWithError.status).toBe("all");
    expect(() => parsePhoneListQuery(new URLSearchParams("status=everything"))).toThrow(PhoneQueryError);
    expect(() => parsePhoneListQuery(new URLSearchParams("event=DROP"))).toThrow(PhoneQueryError);
    expect(() => parsePhoneListQuery(new URLSearchParams("userId=" + "x".repeat(300)))).toThrow(PhoneQueryError);
    expect(() => parsePhoneListQuery(new URLSearchParams("page=0"))).toThrow(PhoneQueryError);
  });
});

describe("admin phone commands and actions", () => {
  it("parses a Saudi number with the same contract as the customer flow", () => {
    expect(parseAdminCommand(form({ action: "phone", userId: STUCK_USER, phone: "0555555555" }))).toEqual({
      ok: true,
      command: { type: "phone", userId: STUCK_USER, phone: OTHER_PHONE },
    });
    expect(parseAdminCommand(form({ action: "phone", userId: STUCK_USER, phone: "123" }))).toEqual({ ok: false });
    expect(parseAdminCommand(form({ action: "unverify", userId: STUCK_USER }))).toEqual({
      ok: true,
      command: { type: "unverify", userId: STUCK_USER },
    });
    expect(parseAdminCommand(form({ action: "phone", userId: "bad id with spaces", phone: "0555555555" }))).toEqual({
      ok: false,
    });
  });

  it("sets a new phone unverified, logs PHONE_CHANGED_BY_ADMIN and the admin audit event", () => {
    const parsed = parseAdminCommand(form({ action: "phone", userId: STUCK_USER, phone: "0501239999" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = applyAdminAction(db, ADMIN, parsed.command, NOW);
    expect(result).toEqual({ ok: true, changed: true });
    expect(readProfilePhone(db, STUCK_USER)).toEqual({
      phoneE164: "+966501239999",
      phoneVerifiedAt: null,
    });
    const history = readPhoneHistoryForUser(db, STUCK_USER, 5);
    expect(history[0]).toMatchObject({
      action: "PHONE_CHANGED_BY_ADMIN",
      oldPhone: OTHER_PHONE,
      newPhone: "+966501239999",
      phoneVerified: false,
      actorType: "admin",
      actorUserId: ADMIN,
    });
    const audit = db.prepare("SELECT action, target FROM admin_audit_events WHERE target = ?").get(STUCK_USER) as
      | { action: string; target: string }
      | undefined;
    expect(audit).toEqual({ action: "phone", target: STUCK_USER });
  });

  it("refuses to assign a number verified by another account and never mutates the profile", () => {
    const parsed = parseAdminCommand(form({ action: "phone", userId: STUCK_USER, phone: PHONE.replace("+966", "0") }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(applyAdminAction(db, ADMIN, parsed.command, NOW)).toEqual({ ok: false });
    expect(readProfilePhone(db, STUCK_USER)?.phoneE164).toBe(OTHER_PHONE);
  });

  it("clears verification for a stuck account without changing the number", () => {
    const result = applyAdminAction(db, ADMIN, { type: "unverify", userId: VERIFIED_USER }, NOW);
    expect(result).toEqual({ ok: true, changed: true });
    expect(readProfilePhone(db, VERIFIED_USER)).toEqual({ phoneE164: PHONE, phoneVerifiedAt: null });
    const history = readPhoneHistoryForUser(db, VERIFIED_USER, 5);
    expect(history[0]).toMatchObject({
      action: "PHONE_CHANGED_BY_ADMIN",
      oldPhone: PHONE,
      newPhone: PHONE,
      phoneVerified: false,
    });
    expect(JSON.parse(history[0]?.metadata ?? "{}").source).toBe("admin_unverify");
    // Idempotent: a second call reports no change.
    expect(applyAdminAction(db, ADMIN, { type: "unverify", userId: VERIFIED_USER }, NOW)).toEqual({
      ok: true,
      changed: false,
    });
  });

  it("forbids acting on the admin's own account", () => {
    expect(applyAdminAction(db, ADMIN, { type: "unverify", userId: ADMIN }, NOW)).toEqual({ ok: false });
  });
});
