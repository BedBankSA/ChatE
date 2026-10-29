import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { StoreError } from "@/server/db/errors";
import { immediateTransaction } from "@/server/db/transaction";

export function migrateDatabase(db: DatabaseSync, migrationsDir: string): string[] {
  if (!statSync(migrationsDir, { throwIfNoEntry: false })?.isDirectory()) throw new StoreError("MIGRATIONS_DIR");
  ensureMigrationsTable(db);
  const applied = appliedNames(db);
  const newlyApplied: string[] = [];
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    immediateTransaction(db, () => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(file);
      return { commit: true, value: undefined };
    });
    newlyApplied.push(file);
  }
  return newlyApplied;
}

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
}

function appliedNames(db: DatabaseSync): Set<string> {
  const names = new Set<string>();
  const rows = db.prepare("SELECT id FROM schema_migrations").all();
  for (const row of rows) {
    if (typeof row.id === "string") names.add(row.id);
  }
  return names;
}
