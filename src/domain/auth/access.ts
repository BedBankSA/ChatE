export type AccessInput = {
  session: { userId: string } | null;
  profileComplete: boolean;
  suspended: boolean;
  adminRoute: boolean;
  isAdmin: boolean;
  turnstileRequired: boolean;
  turnstileOk: boolean;
  quotaOk: boolean;
  modelAllowed: boolean;
};

export function evaluateAccess(input: AccessInput): { ok: true } | { ok: false; code: string; status: number } {
  if (!input.session) return { ok: false, code: "anonymous", status: 401 };
  if (input.suspended) return { ok: false, code: "suspended", status: 403 };
  if (input.adminRoute && !input.isAdmin) return { ok: false, code: "not_admin", status: 403 };
  if (!input.profileComplete) return { ok: false, code: "profile_incomplete", status: 403 };
  if (input.turnstileRequired && !input.turnstileOk) return { ok: false, code: "turnstile", status: 403 };
  if (!input.quotaOk) return { ok: false, code: "quota", status: 429 };
  if (!input.modelAllowed) return { ok: false, code: "model_policy", status: 403 };
  return { ok: true };
}

export function isAdmin(user: { googleSub: string; email: string }, allow: { subs: string[]; emails: string[] }): boolean {
  if (allow.subs.includes(user.googleSub)) return true;
  return allow.emails.includes(user.email.toLowerCase());
}

export function assertOwner(resourceUserId: string, sessionUserId: string): boolean {
  return resourceUserId === sessionUserId;
}
