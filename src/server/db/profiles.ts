import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { Profile } from "@/domain/auth/profile";
import { requireText } from "@/server/db/validate";

export function upsertGoogleUser(
  db: DatabaseSync,
  user: { id: string; googleSub: string; email: string; name: string },
): void {
  const id = requireText(user.id, "USER_ID");
  const googleSub = requireText(user.googleSub, "GOOGLE_SUB");
  const email = requireText(user.email, "EMAIL", 320);
  const name = requireText(user.name.trim() || "مستخدم", "NAME");
  db.prepare(`
    INSERT INTO users (id, google_sub, email, name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      google_sub = excluded.google_sub
  `).run(id, googleSub, email, name);
  db.prepare("INSERT INTO profiles (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING").run(id);
}

export function readStoredProfile(db: DatabaseSync, userId: string): Profile | null {
  const row = db.prepare(`
    SELECT u.name AS name, u.email AS email, u.status AS status,
           p.phone_e164 AS phone_e164, p.phone_verified_at AS phone_verified_at,
           p.age AS age, p.city AS city
    FROM users u
    LEFT JOIN profiles p ON p.user_id = u.id
    WHERE u.id = ?
  `).get(userId) as Record<string, SQLOutputValue> | undefined;
  if (!row) return null;
  return {
    name: typeof row.name === "string" ? row.name : null,
    email: typeof row.email === "string" ? row.email : null,
    phoneE164: typeof row.phone_e164 === "string" ? row.phone_e164 : null,
    phoneVerifiedAt: typeof row.phone_verified_at === "string" ? row.phone_verified_at : null,
    age: typeof row.age === "number" ? row.age : null,
    city: typeof row.city === "string" ? row.city : null,
    status: row.status === "suspended" ? "suspended" : "active",
  };
}
