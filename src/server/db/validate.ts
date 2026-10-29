import { StoreError } from "@/server/db/errors";

export function requireText(value: string, code: string, max = 200): string {
  if (typeof value !== "string") throw new StoreError(code);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new StoreError(code);
  return trimmed;
}

export function requireInteger(value: number, code: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new StoreError(code);
  return value;
}
