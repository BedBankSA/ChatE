-- P0: append-only phone & activation audit trail.
--
-- Why no FOREIGN KEY on user_id: this table is the permanent historical record
-- of every phone/activation event. A cascading FK would erase the trail when a
-- users row is deleted, which is exactly what this table must never allow.
-- The append-only triggers below make UPDATE/DELETE impossible even for code
-- holding the raw database handle (including an admin SQL console).

CREATE TABLE IF NOT EXISTS phone_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  old_phone TEXT,
  new_phone TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'INITIAL_ENTRY',
    'OTP_SENT',
    'OTP_VERIFIED',
    'PHONE_CHANGED_BY_USER',
    'PHONE_CHANGED_BY_ADMIN',
    'FAILED_OTP_ATTEMPT'
  )),
  phone_verified INTEGER NOT NULL DEFAULT 0 CHECK (phone_verified IN (0, 1)),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'admin', 'system')),
  actor_user_id TEXT,
  ip TEXT,
  user_agent TEXT,
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS phone_history_user_time_idx ON phone_history (user_id, created_at);
CREATE INDEX IF NOT EXISTS phone_history_phone_time_idx ON phone_history (new_phone, created_at);
CREATE INDEX IF NOT EXISTS phone_history_action_time_idx ON phone_history (action, created_at);
CREATE INDEX IF NOT EXISTS phone_history_time_idx ON phone_history (created_at);

CREATE TRIGGER IF NOT EXISTS phone_history_no_update
BEFORE UPDATE ON phone_history
BEGIN
  SELECT RAISE(ABORT, 'PHONE_HISTORY_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS phone_history_no_delete
BEFORE DELETE ON phone_history
BEGIN
  SELECT RAISE(ABORT, 'PHONE_HISTORY_APPEND_ONLY');
END;

-- Current-phone lookups (duplicate-number check) and the stuck-customer filter.
CREATE INDEX IF NOT EXISTS profiles_phone_idx ON profiles (phone_e164);
CREATE INDEX IF NOT EXISTS profiles_unverified_idx ON profiles (user_id) WHERE phone_verified_at IS NULL;
-- OTP history reads: newest challenge per user and the rolling send counter.
CREATE INDEX IF NOT EXISTS otp_challenges_user_created_idx ON otp_challenges (user_id, created_at);

-- Backfill (append-only): reconstruct what the existing data already proves.
-- 1) The phone stored on each profile (current phone, verified or not).
INSERT INTO phone_history (id, user_id, old_phone, new_phone, action, phone_verified, actor_type, actor_user_id, metadata, created_at)
SELECT
  lower(hex(randomblob(16))),
  p.user_id,
  NULL,
  p.phone_e164,
  CASE WHEN p.phone_verified_at IS NULL THEN 'INITIAL_ENTRY' ELSE 'OTP_VERIFIED' END,
  CASE WHEN p.phone_verified_at IS NULL THEN 0 ELSE 1 END,
  'system',
  NULL,
  '{"source":"migration_backfill","kind":"profile_phone"}',
  COALESCE(p.phone_verified_at, p.updated_at)
FROM profiles p
WHERE p.phone_e164 IS NOT NULL AND p.phone_e164 <> '';

-- 2) Every OTP challenge ever sent: this is the only record of numbers the
--    customer typed and then abandoned before verification.
INSERT INTO phone_history (id, user_id, old_phone, new_phone, action, phone_verified, actor_type, actor_user_id, metadata, created_at)
SELECT
  lower(hex(randomblob(16))),
  c.user_id,
  NULL,
  c.phone_e164,
  'OTP_SENT',
  0,
  'system',
  NULL,
  '{"source":"migration_backfill","kind":"otp_challenge","consumed":' ||
    CASE WHEN c.consumed_at IS NULL THEN 'false' ELSE 'true' END || '}',
  c.created_at
FROM otp_challenges c
WHERE NOT EXISTS (
  SELECT 1 FROM phone_history h
  WHERE h.user_id = c.user_id
    AND h.new_phone = c.phone_e164
    AND h.action = 'OTP_SENT'
    AND h.created_at = c.created_at
);
