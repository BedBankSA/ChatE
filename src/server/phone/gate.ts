import { redirect } from "next/navigation";
import { verifyPhoneHref } from "@/domain/auth/phone-history";
import { getDatabase } from "@/server/db/runtime";
import { readGoogleSession } from "@/server/google-session";
import { readPhoneState } from "@/server/phone/state";

/**
 * Hard page gate for authenticated product surfaces (workspace, history).
 *
 * A signed-in customer whose phone is missing or unverified is sent to
 * /verify-phone immediately instead of being left on a page that silently
 * refuses every action. The return path is validated by safeNextPath.
 *
 * Anonymous visitors are handled by the caller (each page keeps its own
 * anonymous behaviour); a store failure does not trap the customer in a
 * redirect loop, the API gate still answers with its Arabic error.
 */
export async function redirectUnverifiedToVerifyPhone(nextPath: string): Promise<void> {
  const session = await readGoogleSession();
  if (!session) return;
  let state;
  try {
    state = readPhoneState(getDatabase(), session.userId);
  } catch {
    return;
  }
  if (!state || state.phoneVerifiedAt) return;
  redirect(verifyPhoneHref(nextPath));
}
