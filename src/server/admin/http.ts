import { NextResponse } from "next/server";
import type { DatabaseSync } from "node:sqlite";
import { parseAdminCommand } from "@/domain/admin/command";
import { adminDecision, adminDenialMessage, adminMutationAllowed } from "@/domain/admin/gate";
import { applyAdminAction } from "@/server/admin/actions";
import { storedGoogleAccount } from "@/server/admin/identity";
import { buildAdminOverview } from "@/server/admin/overview";
import { jsonError, jsonOk } from "@/server/http";

export type AdminDeps = {
  session: { userId: string; googleSub: string; csrf: string } | null;
  db: DatabaseSync;
  env: Record<string, string | undefined>;
  now?: Date;
};

export function handleAdminOverview(request: Request, deps: AdminDeps): Response {
  const decision = decide(deps);
  if (!decision.ok) return noStore(jsonError(adminDenialMessage(decision.code), decision.code, decision.status));
  const data = buildAdminOverview(deps.db, {
    now: deps.now ?? new Date(),
    params: new URL(request.url).searchParams,
    email: decision.email,
    actorId: decision.userId,
    notice: null,
    env: deps.env,
  });
  return noStore(jsonOk(data));
}

export async function handleAdminUsers(request: Request, deps: AdminDeps): Promise<Response> {
  const decision = decide(deps);
  if (!decision.ok) {
    return noStore(jsonError(adminDenialMessage(decision.code), decision.code, decision.status));
  }
  const session = deps.session;
  if (!session) return noStore(jsonError(adminDenialMessage("anonymous"), "anonymous", 401));
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirectNotice(request, "rejected");
  }
  const csrfField = form.get("csrf");
  const csrf = typeof csrfField === "string" ? csrfField : "";
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (!adminMutationAllowed({ origin: request.headers.get("origin"), host, csrf, sessionCsrf: session.csrf })) {
    return noStore(jsonError("الطلب مرفوض.", "origin", 403));
  }
  const parsed = parseAdminCommand(form);
  if (!parsed.ok) return redirectNotice(request, "rejected");
  try {
    const result = applyAdminAction(deps.db, decision.userId, parsed.command, deps.now ?? new Date());
    return redirectNotice(request, result.ok && result.changed ? "saved" : "rejected");
  } catch {
    return redirectNotice(request, "rejected");
  }
}

function decide(deps: AdminDeps) {
  const stored = deps.session ? storedGoogleAccount(deps.db, deps.session) : null;
  // The admin identity always comes from the stored account, never from a
  // query string, form field, or other caller-supplied email.
  return adminDecision(deps.session, stored, deps.env);
}

function redirectNotice(request: Request, notice: "saved" | "rejected"): Response {
  const location = new URL("/admin", request.url);
  location.searchParams.set("notice", notice);
  return noStore(NextResponse.redirect(location, 303));
}

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}
