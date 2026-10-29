import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveSqlitePath } from "@/server/db/path";
import { requireInteger } from "@/server/db/validate";

const DEFAULT_TIMEOUT_MS = 5_000;

export function openDatabase(filePath: string, options?: { timeoutMs?: number }): DatabaseSync {
  const timeoutMs = requireInteger(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS, "TIMEOUT", 0, 60_000);
  if (filePath !== ":memory:") mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath, {
    enableForeignKeyConstraints: true,
    timeout: timeoutMs,
  });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${timeoutMs}`);
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

export function openAppDatabase(options?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}): { db: DatabaseSync; filePath: string } {
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const filePath = resolveSqlitePath(env.SQLITE_PATH, cwd);
  return { db: openDatabase(filePath, { timeoutMs: options?.timeoutMs }), filePath };
}
