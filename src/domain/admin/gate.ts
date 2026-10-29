import { timingSafeEqual } from "node:crypto";
import { adminGranted } from "@/domain/admin/access";

export type StoredAccount = {
  userId: string;
  googleSub: string;
  email: string;
  /** DB-backed admin role; an environment allowlist entry still grants access. */
  role?: string;
};

export function adminDecision(
  session: { userId: string; googleSub: string } | null,
  stored: StoredAccount | null,
  env: Record<string, string | undefined>,
  claimedEmail?: string | null,
): { ok: true; userId: string; googleSub: string; email: string } | { ok: false; status: 401 | 403; code: "anonymous" | "not_admin" } {
  void claimedEmail;
  if (!session?.userId || !session.googleSub) return { ok: false, status: 401, code: "anonymous" };
  if (!stored || stored.userId !== session.userId || stored.googleSub !== session.googleSub || !stored.email) {
    return { ok: false, status: 401, code: "anonymous" };
  }
  const grantedByEnv = adminGranted({ googleSub: stored.googleSub, email: stored.email }, env);
  if (!grantedByEnv && stored.role !== "admin") {
    return { ok: false, status: 403, code: "not_admin" };
  }
  return { ok: true, userId: stored.userId, googleSub: stored.googleSub, email: stored.email };
}

export function adminDenialMessage(code: "anonymous" | "not_admin"): string {
  if (code === "anonymous") return "يلزم تسجيل الدخول";
  return "هذه الواجهة للمشرف فقط";
}

export function adminMutationAllowed(input: {
  origin: string | null;
  host: string | null;
  csrf: string;
  sessionCsrf: string;
}): boolean {
  const host = input.host?.split(",")[0]?.trim().toLowerCase() ?? "";
  if (!host || !input.origin) return false;
  let originHost = "";
  try {
    originHost = new URL(input.origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (originHost !== host) return false;
  return sameText(input.csrf, input.sessionCsrf);
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
