import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { migrateDatabase, openAppDatabase } from "@/server/db/index";

const globalDb = globalThis as unknown as { __chateDb?: DatabaseSync };

export function sqliteMigrationsDir(cwd = process.cwd()): string {
  return path.join(cwd, "migrations");
}

export function getDatabase(): DatabaseSync {
  if (!globalDb.__chateDb) {
    const opened = openAppDatabase();
    migrateDatabase(opened.db, sqliteMigrationsDir());
    globalDb.__chateDb = opened.db;
  }
  return globalDb.__chateDb;
}
