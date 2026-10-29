import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { changeCount } from "@/server/db/rows";

// A Turnstile token is valid for 300s. Keep the replay record a little longer
// than that so a token cannot be replayed inside the verification window.
export const REPLAY_TTL_MS = 10 * 60 * 1000;

const MAX_MEMORY_ENTRIES = 2048;
const MEMORY_SWEEP_EVERY = 64;
const DB_PRUNE_EVERY = 100;

// Fallback only: the authoritative single-use record is the SQLite row, which
// survives process restarts and is shared by every server process.
const memory = new Map<string, number>();
let sweepTicker = 0;
let insertTicker = 0;

export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function replaySeen(db: DatabaseSync | undefined, digest: string, nowMs: number): boolean {
  if (db && digest) {
    try {
      const row = db
        .prepare("SELECT 1 AS seen FROM turnstile_tokens WHERE token_hash = ? AND expires_at > ?")
        .get(digest, new Date(nowMs).toISOString());
      if (row) return true;
    } catch {
      // The table may be missing during a partial migration. Fall back to the
      // bounded in-process guard instead of failing the request.
    }
  }
  sweepMemory(nowMs);
  const expires = memory.get(digest);
  return expires != null && expires > nowMs;
}

/** Records a verified token. Returns false when another request already used it. */
export function replayRemember(
  db: DatabaseSync | undefined,
  input: { digest: string; action: string; hostname: string; nowMs: number },
): boolean {
  if (!input.digest) return false;
  const verifiedAt = new Date(input.nowMs).toISOString();
  const expiresAt = new Date(input.nowMs + REPLAY_TTL_MS).toISOString();
  if (db) {
    try {
      const result = db.prepare(`
        INSERT INTO turnstile_tokens (token_hash, action, hostname, verified_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(token_hash) DO NOTHING
      `).run(
        input.digest,
        input.action.slice(0, 32),
        input.hostname.slice(0, 255),
        verifiedAt,
        expiresAt,
      );
      const inserted = changeCount(result) === 1;
      if (inserted) pruneDatabase(db, input.nowMs);
      return inserted;
    } catch {
      // Fall through to the in-process guard.
    }
  }
  sweepMemory(input.nowMs);
  if (memory.has(input.digest)) return false;
  memory.set(input.digest, input.nowMs + REPLAY_TTL_MS);
  enforceMemoryCap();
  return true;
}

export function resetReplayMemory(): void {
  memory.clear();
}

function sweepMemory(nowMs: number): void {
  if (memory.size === 0) return;
  if (memory.size < MAX_MEMORY_ENTRIES && ++sweepTicker % MEMORY_SWEEP_EVERY !== 0) return;
  for (const [digest, expires] of memory) {
    if (expires <= nowMs) memory.delete(digest);
  }
}

function enforceMemoryCap(): void {
  while (memory.size > MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next();
    if (oldest.done) return;
    memory.delete(oldest.value);
  }
}

function pruneDatabase(db: DatabaseSync, nowMs: number): void {
  if (++insertTicker % DB_PRUNE_EVERY !== 0) return;
  try {
    db.prepare("DELETE FROM turnstile_tokens WHERE expires_at <= ?").run(new Date(nowMs).toISOString());
  } catch {
    // Cleanup is best effort; a failure must not reject a valid token.
  }
}
