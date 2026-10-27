import path from "node:path";
import { StoreError } from "@/server/db/errors";

export const DEFAULT_SQLITE_PATH = "data/chate.sqlite";

export function resolveSqlitePath(envPath: string | undefined, cwd: string): string {
  const trimmed = envPath?.trim() ?? "";
  const raw = trimmed || DEFAULT_SQLITE_PATH;
  if (raw.includes("\0") || /^postgres(ql)?:\/\//i.test(raw)) throw new StoreError("SQLITE_PATH");
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}
