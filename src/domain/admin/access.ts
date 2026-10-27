import { isAdmin } from "@/domain/auth/access";

export const FRESH_SESSION_MS = 15 * 60 * 1000;

export function splitList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function adminAllowlist(env: Record<string, string | undefined>): { subs: string[]; emails: string[] } {
  return {
    subs: splitList(env.ADMIN_GOOGLE_SUBS),
    emails: splitList(env.ADMIN_EMAILS).map((email) => email.toLowerCase()),
  };
}

export function secretsWriteSubs(env: Record<string, string | undefined>): string[] {
  return splitList(env.ADMIN_SECRETS_WRITE_SUBS);
}

export function adminGranted(user: { googleSub: string; email: string }, env: Record<string, string | undefined>): boolean {
  return isAdmin(user, adminAllowlist(env));
}

export function secretsWriteGranted(googleSub: string, env: Record<string, string | undefined>): boolean {
  return secretsWriteSubs(env).includes(googleSub);
}

export function sessionIsFresh(iat: number | undefined, nowMs: number): boolean {
  if (iat == null) return false;
  const age = nowMs - iat * 1000;
  return age >= 0 && age <= FRESH_SESSION_MS;
}
