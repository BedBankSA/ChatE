import type { SQLOutputValue } from "node:sqlite";
import { StoreError } from "@/server/db/errors";

export function textField(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new StoreError("ROW");
  return value;
}

export function nullableText(row: Record<string, SQLOutputValue>, key: string): string | null {
  const value = row[key];
  if (value == null) return null;
  if (typeof value !== "string") throw new StoreError("ROW");
  return value;
}

export function numberField(row: Record<string, SQLOutputValue>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new StoreError("ROW");
  return value;
}

export function changeCount(result: { changes: number | bigint }): number {
  return Number(result.changes);
}
