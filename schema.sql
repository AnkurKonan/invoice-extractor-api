-- Run once:  npx wrangler d1 execute invoice-extractor --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS api_keys (
  key_hash      TEXT PRIMARY KEY,          -- SHA-256 of the key; the raw key is never stored
  key_prefix    TEXT NOT NULL UNIQUE,      -- first 20 chars, safe to show / use for revoking
  email         TEXT NOT NULL,
  plan          TEXT NOT NULL,
  monthly_quota INTEGER NOT NULL,
  rate_per_min  INTEGER NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  key_id TEXT NOT NULL,
  period TEXT NOT NULL,                    -- 'YYYY-MM' (UTC)
  calls  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, period)
);

CREATE TABLE IF NOT EXISTS rate_window (
  key_id TEXT NOT NULL,
  win    INTEGER NOT NULL,                 -- minute bucket
  hits   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, win)
);

-- Audit trail: metadata ONLY. Document contents are never stored.
CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  ts           TEXT NOT NULL,
  key_id       TEXT NOT NULL,
  endpoint     TEXT NOT NULL,
  status       INTEGER NOT NULL,
  latency_ms   INTEGER NOT NULL,
  input_type   TEXT,
  input_bytes  INTEGER,
  confidence   TEXT,
  needs_review INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_key_ts ON audit_log(key_id, ts);
