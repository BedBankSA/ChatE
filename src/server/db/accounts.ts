import type { DatabaseSync } from "node:sqlite";
import { requireInteger, requireText } from "@/server/db/validate";

export type NewUser = {
  id: string;
  googleSub: string;
  email: string;
  name: string;
};

export type NewSession = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
};

export type NewFile = {
  id: string;
  userId: string;
  storageKey: string;
  originalName: string;
  detectedType: string;
  byteSize: number;
  sha256: string;
  status: string;
};

export function insertUser(db: DatabaseSync, user: NewUser): void {
  db.prepare(`
    INSERT INTO users (id, google_sub, email, name)
    VALUES (?, ?, ?, ?)
  `).run(
    requireText(user.id, "USER_ID"),
    requireText(user.googleSub, "GOOGLE_SUB"),
    requireText(user.email, "EMAIL", 320),
    requireText(user.name, "NAME"),
  );
}

export function insertSession(db: DatabaseSync, session: NewSession): void {
  db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(
    requireText(session.id, "SESSION_ID"),
    requireText(session.userId, "USER_ID"),
    requireText(session.tokenHash, "TOKEN_HASH"),
    requireText(session.expiresAt, "EXPIRES_AT"),
  );
}

export function insertFile(db: DatabaseSync, file: NewFile): void {
  db.prepare(`
    INSERT INTO files (id, user_id, storage_key, original_name, detected_type, byte_size, sha256, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    requireText(file.id, "FILE_ID"),
    requireText(file.userId, "USER_ID"),
    requireText(file.storageKey, "STORAGE_KEY", 1000),
    requireText(file.originalName, "FILE_NAME", 500),
    requireText(file.detectedType, "FILE_TYPE"),
    requireInteger(file.byteSize, "FILE_SIZE", 0, 2_000_000_000),
    requireText(file.sha256, "FILE_HASH", 128),
    requireText(file.status, "FILE_STATUS"),
  );
}
