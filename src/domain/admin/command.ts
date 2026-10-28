export type AdminCommand =
  | { type: "suspend"; userId: string; mode: "indefinite" | "7d" }
  | { type: "restore"; userId: string }
  | { type: "quota"; userId: string; limit: number };

export function parseAdminCommand(form: { get(name: string): unknown }): { ok: true; command: AdminCommand } | { ok: false } {
  const action = readText(form.get("action"));
  const userId = readText(form.get("userId"));
  if (!/^[\w.:-]{1,200}$/.test(userId)) return { ok: false };
  if (action === "suspend") return suspendCommand(userId, readText(form.get("mode")));
  if (action === "restore") return { ok: true, command: { type: "restore", userId } };
  if (action === "quota") return quotaCommand(userId, readText(form.get("limit")));
  return { ok: false };
}

function suspendCommand(userId: string, mode: string): { ok: true; command: AdminCommand } | { ok: false } {
  if (mode !== "indefinite" && mode !== "7d") return { ok: false };
  return { ok: true, command: { type: "suspend", userId, mode } };
}

function quotaCommand(userId: string, raw: string): { ok: true; command: AdminCommand } | { ok: false } {
  if (!/^\d{1,7}$/.test(raw)) return { ok: false };
  const limit = Number(raw);
  if (limit > 1_000_000) return { ok: false };
  return { ok: true, command: { type: "quota", userId, limit } };
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
