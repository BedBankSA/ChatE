import type { DatabaseSync } from "node:sqlite";
import type { PhoneState } from "@/domain/auth/phone-history";
import { getDatabase } from "@/server/db/runtime";
import { readProfilePhone } from "@/server/phone/audit";

/**
 * Phone/verification facts for one account, used by the page gate, the layout
 * banner and the account dashboard. Returns null when the users row is gone.
 */
export function readPhoneState(db: DatabaseSync, userId: string): PhoneState | null {
  const row = readProfilePhone(db, userId);
  if (!row) return null;
  return { phoneE164: row.phoneE164, phoneVerifiedAt: row.phoneVerifiedAt };
}

/**
 * Store failures must not break page rendering or hide the app behind an error:
 * the pages fall back to "unknown" and the API/model gate still fails closed.
 */
export function readPhoneStateSafe(db: DatabaseSync, userId: string): PhoneState | null {
  try {
    return readPhoneState(db, userId);
  } catch {
    return null;
  }
}

export function appPhoneStateSafe(userId: string): PhoneState | null {
  try {
    return readPhoneStateSafe(getDatabase(), userId);
  } catch {
    return null;
  }
}

