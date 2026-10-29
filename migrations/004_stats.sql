-- The admin counters write hourly buckets and a latency histogram alongside
-- operation_stats. These tables were referenced by src/server/admin/operations.ts
-- but were never created by 001/002, so every stats write failed silently.
CREATE TABLE IF NOT EXISTS operation_buckets (
  bucket_start TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_separate INTEGER NOT NULL DEFAULT 0,
  reasoning_included INTEGER NOT NULL DEFAULT 0,
  quota_units INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_events INTEGER NOT NULL DEFAULT 0,
  error_rate_limit INTEGER NOT NULL DEFAULT 0,
  error_auth INTEGER NOT NULL DEFAULT 0,
  error_service INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_start, operation_type, model, provider, status)
);

CREATE INDEX IF NOT EXISTS operation_buckets_time_idx ON operation_buckets (bucket_start, operation_type);

CREATE TABLE IF NOT EXISTS latency_histogram (
  metric TEXT NOT NULL CHECK (metric IN ('ttft', 'completion')),
  bucket_start TEXT NOT NULL,
  le_ms INTEGER NOT NULL,
  events INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (metric, bucket_start, le_ms)
);

CREATE INDEX IF NOT EXISTS latency_histogram_time_idx ON latency_histogram (metric, bucket_start);
