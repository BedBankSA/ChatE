-- Admin operations, presence, and secret versions.
-- No message text, file names, or secret plaintext columns.

ALTER TABLE users ADD COLUMN suspended_until TEXT;
ALTER TABLE users ADD COLUMN session_valid_after TEXT;

ALTER TABLE jobs ADD COLUMN cancelled_at TEXT;
ALTER TABLE jobs ADD COLUMN cancel_requested_at TEXT;

CREATE TABLE IF NOT EXISTS presence (
  subject_key TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS presence_active_idx ON presence (expires_at, last_seen_at);
CREATE INDEX IF NOT EXISTS presence_user_idx ON presence (user_id);

CREATE TABLE IF NOT EXISTS operation_stats (
  operation_id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  model TEXT,
  provider TEXT,
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'question', 'comparison', 'generation', 'extra_attempt',
    'embedding', 'rerank', 'classification', 'speech'
  )),
  occurred_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'succeeded', 'failed', 'incomplete', 'cancelled')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  reasoning_included_in_output INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_included_in_output IN (0, 1)),
  ttft_ms INTEGER,
  completion_ms INTEGER,
  cost_usd REAL,
  quota_units INTEGER,
  error_code TEXT
);

CREATE INDEX IF NOT EXISTS operation_stats_time_idx ON operation_stats (occurred_at, operation_type);
CREATE INDEX IF NOT EXISTS operation_stats_user_idx ON operation_stats (user_id, occurred_at);
CREATE INDEX IF NOT EXISTS operation_stats_latency_idx ON operation_stats (operation_type, occurred_at, completion_ms);

CREATE TRIGGER IF NOT EXISTS operation_stats_redacted_error
BEFORE INSERT ON operation_stats
WHEN NEW.error_code IS NOT NULL AND (
  length(NEW.error_code) > 64
  OR instr(NEW.error_code, ' ') > 0
  OR instr(NEW.error_code, char(10)) > 0
  OR instr(lower(NEW.error_code), 'sk-') > 0
)
BEGIN
  SELECT RAISE(ABORT, 'REDACTED_ERROR_ONLY');
END;

CREATE TABLE IF NOT EXISTS operation_rollups (
  bucket_start TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  operations INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_excluded_tokens INTEGER NOT NULL DEFAULT 0,
  tokens_known INTEGER NOT NULL DEFAULT 0,
  ttft_sum_ms INTEGER NOT NULL DEFAULT 0,
  ttft_count INTEGER NOT NULL DEFAULT 0,
  completion_sum_ms INTEGER NOT NULL DEFAULT 0,
  completion_count INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  quota_units INTEGER NOT NULL DEFAULT 0,
  error_rate_limit INTEGER NOT NULL DEFAULT 0,
  error_auth INTEGER NOT NULL DEFAULT 0,
  error_service INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_start, operation_type, model, provider, status)
);

CREATE TABLE IF NOT EXISTS presence_rollups (
  bucket_start TEXT PRIMARY KEY,
  registered_peak INTEGER NOT NULL,
  anonymous_peak INTEGER NOT NULL,
  sampled_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_snapshots (
  provider TEXT PRIMARY KEY,
  body TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(body)),
  fetched_at TEXT,
  attempted_at TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS provider_sync_lock (
  provider TEXT PRIMARY KEY,
  locked_until TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_controls (
  service TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  actor_user_id TEXT
);

CREATE TABLE IF NOT EXISTS service_checks (
  service TEXT PRIMARY KEY,
  config_status TEXT NOT NULL,
  last_test_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_error_code TEXT,
  usage_unit TEXT,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_secret_versions (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('dev', 'prod')),
  version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('candidate', 'active', 'disabled', 'rejected')),
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  last_four TEXT,
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  tested_at TEXT,
  test_result TEXT,
  activated_at TEXT,
  UNIQUE (service, environment, version)
);

CREATE TABLE IF NOT EXISTS secret_audit (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  key_version INTEGER,
  actor_user_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  result TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_thresholds (
  kind TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  threshold REAL,
  notify_external INTEGER NOT NULL DEFAULT 0 CHECK (notify_external IN (0, 1))
);

CREATE TABLE IF NOT EXISTS admin_view_preferences (
  admin_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  view_key TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (admin_user_id, view_key)
);

CREATE VIEW IF NOT EXISTS admin_operation_feed AS
SELECT
  operation_id, user_id, model, provider, operation_type, occurred_at, status,
  input_tokens, output_tokens, reasoning_tokens, reasoning_included_in_output,
  ttft_ms, completion_ms, cost_usd, quota_units, error_code
FROM operation_stats;

CREATE VIEW IF NOT EXISTS admin_account_directory AS
SELECT
  u.id AS id,
  u.name AS name,
  u.email AS email,
  u.status AS status,
  u.suspended_until AS suspended_until,
  u.created_at AS created_at,
  u.last_activity_at AS last_activity_at,
  p.phone_e164 AS phone_e164,
  p.phone_verified_at AS phone_verified_at,
  p.age AS age,
  p.city AS city
FROM users u
LEFT JOIN profiles p ON p.user_id = u.id;

CREATE VIEW IF NOT EXISTS admin_storage_totals AS
SELECT COUNT(*) AS file_count, COALESCE(SUM(byte_size), 0) AS storage_bytes
FROM files;

CREATE VIEW IF NOT EXISTS admin_secret_status AS
SELECT
  id, service, environment, version, state, last_four, actor_user_id,
  created_at, tested_at, test_result, activated_at
FROM integration_secret_versions;

INSERT INTO alert_thresholds (kind, enabled, threshold, notify_external) VALUES
  ('quota_low', 1, 0.1, 0),
  ('quota_exhausted', 1, 0, 0),
  ('rate_limit_spike', 1, 10, 0),
  ('api_key_failure', 1, NULL, 0),
  ('service_down', 1, NULL, 0),
  ('request_spike', 1, 3, 0),
  ('stats_sync_failure', 1, NULL, 0)
ON CONFLICT(kind) DO NOTHING;
