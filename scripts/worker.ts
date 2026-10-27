import path from "node:path";
import { migrateDatabase, openAppDatabase, requeueStaleClaims } from "../src/server/db/index";

const STALE_CLAIM_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
  const opened = openAppDatabase();
  let stopped = false;
  const requestStop = () => {
    stopped = true;
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  try {
    const applied = migrateDatabase(opened.db, path.join(process.cwd(), "migrations"));
    const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
    const stale = requeueStaleClaims(opened.db, staleBefore);
    console.log(`ملف SQLite: ${opened.filePath}`);
    for (const file of applied) console.log(`applied ${file}`);
    console.log(`أُعيدت المهام القديمة إلى الطابور: ${stale}`);
    console.log("عامل SQLite لا يأخذ مهام المقارنة ولا يستدعي مزودًا.");
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    opened.db.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "worker failed";
  console.error(message.slice(0, 300));
  process.exit(1);
});
