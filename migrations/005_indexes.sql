-- Lookup indexes for the hot read paths. 001/002 only indexed jobs and
-- operation_stats, so run reads and per-user cleanups scanned whole tables.
CREATE INDEX IF NOT EXISTS model_runs_comparison_idx ON model_runs (comparison_id, status);
CREATE INDEX IF NOT EXISTS model_runs_user_idx ON model_runs (user_id, created_at);

CREATE INDEX IF NOT EXISTS evidence_snapshots_comparison_idx ON evidence_snapshots (comparison_id);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE INDEX IF NOT EXISTS usage_events_user_idx ON usage_events (user_id, created_at);

CREATE INDEX IF NOT EXISTS admin_audit_target_idx ON admin_audit_events (target, created_at);
