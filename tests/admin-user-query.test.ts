import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AdminQueryError,
  e164Query,
  likeContains,
  parseUserQuery,
} from "@/domain/admin/user-query";
import { insertUser } from "@/server/db/accounts";
import { migrateDatabase, openDatabase } from "@/server/db/index";
import { queryUsers } from "@/server/admin/users";

const migrationsDir = path.join(process.cwd(), "migrations");
const range = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-28T00:00:00.000Z" };
const nowIso = "2026-10-27T12:00:00.000Z";

function parse(search: string) {
  return parseUserQuery(new URLSearchParams(search), range, nowIso);
}

function withDb(run: (db: DatabaseSync) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "chate-query-"));
  const db = openDatabase(path.join(dir, "chate.sqlite"));
  try {
    migrateDatabase(db, migrationsDir);
    insertUser(db, { id: "user-1", googleSub: "sub-1", email: "layan@example.com", name: "ليان" });
    insertUser(db, { id: "user-2", googleSub: "sub-2", email: "other@example.com", name: "سامي" });
    db.prepare("INSERT INTO profiles (user_id, phone_e164) VALUES (?, ?)").run("user-1", "+966500000000");
    db.prepare("INSERT INTO profiles (user_id, phone_e164) VALUES (?, ?)").run("user-2", "+966500000001");
    run(db);
  } finally {
    if (db.isOpen && db.isTransaction) db.exec("ROLLBACK");
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("admin user query validation", () => {
  it("applies documented defaults", () => {
    const query = parse("");
    expect(query).toMatchObject({
      q: "",
      qField: "all",
      statuses: [],
      phoneVerified: null,
      sort: "registeredAt",
      dir: "desc",
      page: 1,
      pageSize: 20,
      from: range.from,
      to: range.to,
      nowIso,
    });
  });

  it("rejects unknown sort, direction, search field, status, filter and page values", () => {
    expect(() => parse("sort=id;DROP TABLE users;--")).toThrow(AdminQueryError);
    expect(() => parse("dir=sideways")).toThrow(AdminQueryError);
    expect(() => parse("qField=password")).toThrow(AdminQueryError);
    expect(() => parse("status=deleted")).toThrow(AdminQueryError);
    expect(() => parse("phoneVerified=maybe")).toThrow(AdminQueryError);
    expect(() => parse("page=0")).toThrow(AdminQueryError);
    expect(() => parse("page=100001")).toThrow(AdminQueryError);
    expect(() => parse("pageSize=101")).toThrow(AdminQueryError);
    expect(() => parse("ageMin=1.5")).toThrow(AdminQueryError);
    expect(() => parse("registeredFrom=not-a-date")).toThrow(AdminQueryError);
  });

  it("normalizes dates and trims the message", () => {
    const query = parse("q=%20%20ليان%20%20&registeredFrom=2026-10-01&status=active,temporary&sort=tokens&dir=asc&page=2&pageSize=50");
    expect(query.q).toBe("ليان");
    expect(query.registeredFrom).toBe("2026-10-01T00:00:00.000Z");
    expect(query.statuses).toEqual(["active", "temporary"]);
    expect(query.sort).toBe("tokens");
    expect(query.dir).toBe("asc");
    expect(query).toMatchObject({ page: 2, pageSize: 50 });
  });

  it("escapes LIKE wildcards and only accepts E.164 phone queries", () => {
    expect(likeContains("100%_x")).toBe("%100\\%\\_x%");
    expect(likeContains("a\\b")).toBe("%a\\\\b%");
    expect(e164Query("+966 50 000 0000")).toBe("+966500000000");
    expect(e164Query("0500000000")).toBeNull();
    expect(e164Query("+96650000000000001")).toBeNull();
  });
});

describe("admin user query SQL", () => {
  it("does not turn a non-E.164 phone search into a match-all pattern", () => {
    withDb((db) => {
      const bad = queryUsers(db, parse("qField=phone&q=0500000000"));
      expect(bad.total).toBe(0);
      expect(bad.rows).toEqual([]);

      const good = queryUsers(db, parse("qField=phone&q=%2B966500000000"));
      expect(good.total).toBe(1);
      expect(good.rows[0]?.id).toBe("user-1");
    });
  });

  it("treats typed LIKE metacharacters as literals", () => {
    withDb((db) => {
      expect(queryUsers(db, parse("qField=name&q=%25")).total).toBe(0);
      expect(queryUsers(db, parse("qField=name&q=_")).total).toBe(0);
      expect(queryUsers(db, parse("qField=name&q=ليان")).total).toBe(1);
    });
  });

  it("filters by status label, phone verification and ranges", () => {
    withDb((db) => {
      expect(queryUsers(db, parse("status=active")).total).toBe(2);
      expect(queryUsers(db, parse("status=suspended")).total).toBe(0);
      expect(queryUsers(db, parse("phoneVerified=yes")).total).toBe(0);
      expect(queryUsers(db, parse("ageMin=18")).total).toBe(0);
      expect(queryUsers(db, parse("questionsMin=0")).total).toBe(2);
    });
  });

  it("pages results without losing the stable id tiebreak", () => {
    withDb((db) => {
      const first = queryUsers(db, parse("page=1&pageSize=1&sort=id&dir=asc"));
      const second = queryUsers(db, parse("page=2&pageSize=1&sort=id&dir=asc"));
      expect(first.total).toBe(2);
      expect(first.rows.map((row) => row.id)).toEqual(["user-1"]);
      expect(second.rows.map((row) => row.id)).toEqual(["user-2"]);
    });
  });
});
