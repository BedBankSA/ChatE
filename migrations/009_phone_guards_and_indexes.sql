-- P0/P1 hardening after the phone/OTP audit findings.
--
-- 1) A number may belong to only one *verified* account. The application checks
--    inside BEGIN IMMEDIATE already; these triggers are defense in depth for any
--    future code path (or direct SQL) that forgets the check.
--    No data is deleted, and existing legacy duplicates are NOT rejected on
--    migration: the triggers only apply to new writes. The read-only view below
--    surfaces any legacy duplicates for the admin to resolve manually.
--
-- 2) Indexes chosen from measured query plans (docs/swarm/perf-audit-AR.md):
--    the per-phone send counter, the admin user list's per-user operation stats,
--    session expiry sweep, and admin audit reads.

CREATE VIEW IF NOT EXISTS admin_phone_duplicates AS
SELECT phone_e164, COUNT(*) AS accounts
FROM profiles
WHERE phone_verified_at IS NOT NULL AND phone_e164 IS NOT NULL AND phone_e164 <> ''
GROUP BY phone_e164
HAVING COUNT(*) > 1;

CREATE TRIGGER IF NOT EXISTS profiles_phone_unique_insert
BEFORE INSERT ON profiles
WHEN NEW.phone_verified_at IS NOT NULL AND NEW.phone_e164 IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'PHONE_ALREADY_VERIFIED')
  WHERE EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id <> NEW.user_id
      AND phone_e164 = NEW.phone_e164
      AND phone_verified_at IS NOT NULL
  );
END;

CREATE TRIGGER IF NOT EXISTS profiles_phone_unique_update
BEFORE UPDATE OF phone_e164, phone_verified_at ON profiles
WHEN NEW.phone_verified_at IS NOT NULL AND NEW.phone_e164 IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'PHONE_ALREADY_VERIFIED')
  WHERE EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id <> NEW.user_id
      AND phone_e164 = NEW.phone_e164
      AND phone_verified_at IS NOT NULL
  );
END;

CREATE INDEX IF NOT EXISTS otp_challenges_phone_created_idx ON otp_challenges (phone_e164, created_at);
CREATE INDEX IF NOT EXISTS operation_stats_user_type_time_idx ON operation_stats (user_id, operation_type, occurred_at);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS admin_audit_actor_time_idx ON admin_audit_events (admin_user_id, created_at);

-- One-time planner statistics refresh for the new indexes.
ANALYZE;
