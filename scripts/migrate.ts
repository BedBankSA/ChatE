import path from "node:path";
import { migrateDatabase, openAppDatabase } from "../src/server/db/index";

const opened = openAppDatabase();
try {
  const applied = migrateDatabase(opened.db, path.join(process.cwd(), "migrations"));
  console.log(`ملف SQLite: ${opened.filePath}`);
  if (applied.length === 0) console.log("no pending migrations");
  for (const file of applied) console.log(`applied ${file}`);
} finally {
  opened.db.close();
}
