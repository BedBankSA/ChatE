/**
 * ChatE QA seed: inserts local test users into the app SQLite database and mints
 * signed session cookies for browser E2E runs.
 *
 * - Reads SESSION_SECRET and SQLITE_PATH from process.env first, then an optional
 *   QA_ENV_FILE, then .env.local. Values are used in memory only and are never
 *   printed, logged, or written to disk.
 * - Idempotent: users are keyed by qa_* ids and upserted.
 * - Applies pending migrations so a fresh data/qa.sqlite works.
 *
 * CLI:
 *   C:\Pak\node.exe scripts/qa/seed.mjs [--env-file=path] [--write-sessions]
 *
 * Programmatic:
 *   import { seedQaUsers, loadEnv } from "./seed.mjs";
 *   const { sessions } = seedQaUsers();
 */
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, "..", "..");
export const MIGRATIONS_DIR = path.join(PROJECT_ROOT, "migrations");

/** Parse a dotenv-style file without exporting values anywhere. */
export function parseEnvFile(filePath) {
  const values = {};
  if (!existsSync(filePath)) return values;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

/** process.env > QA_ENV_FILE > .env.local (first non-empty wins). */
export function loadEnv(extraEnvFile) {
  const local = parseEnvFile(path.join(PROJECT_ROOT, ".env.local"));
  const override = extraEnvFile ? parseEnvFile(path.resolve(PROJECT_ROOT, extraEnvFile)) : {};
  const merged = { ...local, ...override, ...process.env };
  return merged;
}

function resolveDbPath(env) {
  const raw = env.SQLITE_PATH || "data/chate.sqlite";
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

function applyMigrations(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
  );
  const applied = new Set(
    db
      .prepare("SELECT id FROM schema_migrations")
      .all()
      .map((row) => row.id)
      .filter((id) => typeof id === "string"),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const newlyApplied = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(file);
      db.exec("COMMIT");
      newlyApplied.push(file);
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error("migration failed: " + file + ": " + error.message);
    }
  }
  return newlyApplied;
}

export function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return body + "." + signature;
}

function mintCookie(user, secret, nowSec) {
  const token = signSession(
    {
      userId: user.id,
      googleSub: user.googleSub,
      exp: nowSec + 60 * 60 * 2,
      csrf: randomBytes(18).toString("base64url"),
      iat: nowSec,
    },
    secret,
  );
  return "chate_session=" + encodeURIComponent(token);
}

function upsertUser(db, user) {
  db.prepare(
    "INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET google_sub = excluded.google_sub, email = excluded.email, name = excluded.name",
  ).run(user.id, user.googleSub, user.email, user.name);
  db.prepare("INSERT INTO profiles (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING").run(user.id);
  db.prepare(
    "UPDATE profiles SET phone_e164 = ?, phone_verified_at = ?, age = ?, city = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ?",
  ).run(user.phone ?? null, user.phoneVerifiedAt ?? null, user.age ?? null, user.city ?? null, user.id);
}

/**
 * Insert QA users and mint session cookies.
 * @returns {{sessions: Record<string, {role: string, cookie: string, header: string, userId: string, googleSub: string, email: string}>, dbPath: string, applied: string[], adminConfigured: boolean}}
 */
export function seedQaUsers(options = {}) {
  const env = options.env ?? loadEnv(options.envFile);
  const secret = env.QA_SESSION_SECRET || env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SECRET missing or too short; cannot mint a session cookie");
  }
  const dbPath = options.dbPath || resolveDbPath(env);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: 8000, enableForeignKeyConstraints: true });
  db.exec("PRAGMA busy_timeout = 8000");
  const applied = applyMigrations(db);
  const nowSec = Math.floor(Date.now() / 1000);

  const adminEmail = (env.ADMIN_EMAILS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)[0];
  const adminSub = (env.ADMIN_GOOGLE_SUBS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)[0];

  const users = [
    {
      key: "unverified",
      role: "authenticated, phone not verified",
      id: "qa_user_unverified",
      googleSub: "qa-google-unverified",
      email: "qa.unverified@example.invalid",
      name: "QA مستخدم غير موثق",
      phone: "+15550000001",
      phoneVerifiedAt: null,
    },
    {
      key: "unverified2",
      role: "authenticated, phone not verified (API-only OTP test user)",
      id: "qa_user_unverified2",
      googleSub: "qa-google-unverified2",
      email: "qa.unverified2@example.invalid",
      name: "QA مستخدم غير موثق ٢",
      phone: null,
      phoneVerifiedAt: null,
    },
    {
      key: "verified",
      role: "authenticated, phone verified",
      id: "qa_user_verified",
      googleSub: "qa-google-verified",
      email: "qa.verified@example.invalid",
      name: "QA مستخدم موثق",
      phone: "+15550000002",
      phoneVerifiedAt: new Date(nowSec * 1000).toISOString(),
    },
    {
      key: "nonadmin",
      role: "authenticated, not an admin",
      id: "qa_user_nonadmin",
      googleSub: "qa-google-nonadmin",
      email: "qa.nonadmin@example.invalid",
      name: "QA مستخدم عادي",
      phone: "+15550000003",
      phoneVerifiedAt: new Date(nowSec * 1000).toISOString(),
    },
  ];
  if (adminEmail) {
    users.push({
      key: "admin",
      role: "authenticated admin",
      id: "qa_user_admin",
      googleSub: adminSub || "qa-google-admin",
      email: adminEmail,
      name: "QA مشرف",
      phone: "+15550000004",
      phoneVerifiedAt: new Date(nowSec * 1000).toISOString(),
    });
  }

  // A rerun must not inherit old OTP rate-limit windows or a previously
  // verified state for the API OTP test user.
  db.prepare("DELETE FROM otp_challenges WHERE user_id IN (?, ?, ?, ?)").run(
    "qa_user_unverified",
    "qa_user_unverified2",
    "qa_user_verified",
    "qa_user_nonadmin",
  );
  const sessions = {};
  for (const user of users) {
    upsertUser(db, user);
    const cookie = mintCookie(user, secret, nowSec);
    sessions[user.key] = {
      role: user.role,
      userId: user.id,
      googleSub: user.googleSub,
      email: user.email,
      cookie,
      header: cookie,
    };
  }
  db.close();

  if (options.writeSessions) {
    const dir = path.join(PROJECT_ROOT, "tmp", "qa");
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "sessions.json");
    writeFileSync(
      target,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          dbPath,
          note: "Ephemeral local QA cookies. Never commit. Regenerate with scripts/qa/seed.mjs.",
          sessions,
        },
        null,
        2,
      ),
    );
    sessions.file = target;
  }
  return { sessions, dbPath, applied, adminConfigured: Boolean(adminEmail) };
}

// CLI entry point.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const envFileArg = process.argv.find((arg) => arg.startsWith("--env-file="));
  const envFile = envFileArg ? envFileArg.slice("--env-file=".length) : process.env.QA_ENV_FILE;
  const writeSessions = process.argv.includes("--write-sessions");
  const result = seedQaUsers({ envFile, writeSessions });
  console.log("QA seed complete.");
  console.log("database:", path.relative(PROJECT_ROOT, result.dbPath), "| migrations applied:", result.applied.length ? result.applied.join(", ") : "none");
  console.log("admin session available:", result.adminConfigured ? "yes (ADMIN_EMAILS configured)" : "no (ADMIN_EMAILS empty)");
  for (const [key, session] of Object.entries(result.sessions)) {
    console.log(" - " + key.padEnd(10) + " userId=" + session.userId + "  " + session.role);
  }
  if (writeSessions) console.log("sessions written to:", path.relative(PROJECT_ROOT, result.sessions.file));
  console.log("(cookie values intentionally not printed)");
}
