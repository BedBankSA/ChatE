import { adminDecision } from "@/domain/admin/gate";
import { storedGoogleAccount } from "@/server/admin/identity";
import { getDatabase } from "@/server/db/runtime";
import { readGoogleSession } from "@/server/google-session";

export async function currentAdmin(): Promise<{ userId: string; googleSub: string; email: string; csrf: string } | null> {
  try {
    const session = await readGoogleSession();
    if (!session) return null;
    const decision = adminDecision(session, storedGoogleAccount(getDatabase(), session), process.env);
    if (!decision.ok) return null;
    return { userId: decision.userId, googleSub: decision.googleSub, email: decision.email, csrf: session.csrf };
  } catch {
    return null;
  }
}
