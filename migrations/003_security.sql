-- Turnstile replay protection is now a single-use row per token (see
-- src/server/turnstile-replay.ts). Expired rows are pruned by the server, and
-- this index keeps that sweep and the lookup cheap as traffic grows.
CREATE INDEX IF NOT EXISTS turnstile_tokens_expiry_idx ON turnstile_tokens (expires_at);
