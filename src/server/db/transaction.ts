import type { DatabaseSync } from "node:sqlite";
import { StoreError } from "@/server/db/errors";

export const BEGIN_IMMEDIATE_SQL = "BEGIN IMMEDIATE";

export function immediateTransaction<T>(
  db: DatabaseSync,
  body: () => { commit: boolean; value: T },
): T {
  if (db.isTransaction) throw new StoreError("NESTED_TRANSACTION");
  try {
    db.exec(BEGIN_IMMEDIATE_SQL);
    const outcome = body();
    db.exec(outcome.commit ? "COMMIT" : "ROLLBACK");
    return outcome.value;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
