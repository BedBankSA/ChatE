import { sessionStillValid, suspensionActive } from "@/domain/admin/suspension";
import { isAdmin } from "@/domain/auth/access";

export function splitList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function adminAllowlist(env: Record<string, string | undefined>): { subs: string[]; emails: string[] } {
  return {
    subs: splitList(env.ADMIN_GOOGLE_SUBS),
    emails: splitList(env.ADMIN_EMAILS).map((email) => email.toLowerCase()),
  };
}

export function adminGranted(user: { googleSub: string; email: string }, env: Record<string, string | undefined>): boolean {
  return isAdmin(user, adminAllowlist(env));
}

export function isSuspended(status: string, suspendedUntil: string | null, nowIso: string): boolean {
  return suspensionActive(status, suspendedUntil, Date.parse(nowIso));
}

export function sessionEnded(sessionValidAfter: string | null, issuedAt: number | undefined, nowSec: number): boolean {
  return !sessionStillValid(issuedAt, sessionValidAfter, nowSec * 1000);
}
