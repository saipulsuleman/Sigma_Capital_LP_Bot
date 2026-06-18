-- Closed positions analytics (migrated from lessons.json → performance array)
CREATE TABLE IF NOT EXISTS positions (
  id          TEXT PRIMARY KEY,
  position    TEXT,
  pool        TEXT NOT NULL,
  pool_name   TEXT,
  strategy    TEXT,
  pnl_usd     REAL,
  pnl_pct     REAL,
  range_efficiency REAL,
  amount_sol  REAL,
  fees_earned_usd REAL,
  close_reason TEXT,
  deployed_at TEXT,
  closed_at   TEXT,
  raw         TEXT NOT NULL
);

-- Agent decisions (migrated from decision-log.json → decisions array)
CREATE TABLE IF NOT EXISTS decisions (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  type        TEXT,
  actor       TEXT,
  pool        TEXT,
  pool_name   TEXT,
  position    TEXT,
  summary     TEXT,
  reason      TEXT,
  risks       TEXT,
  metrics     TEXT,
  rejected    TEXT
);

-- Derived trading lessons (migrated from lessons.json → lessons array)
CREATE TABLE IF NOT EXISTS lessons (
  id          TEXT PRIMARY KEY,
  rule        TEXT,
  confidence  REAL,
  type        TEXT,
  recorded_at TEXT,
  raw         TEXT NOT NULL
);

-- Skill files for REVIEW agent (Fase 3 — T15/T16)
CREATE TABLE IF NOT EXISTS skills (
  id          TEXT PRIMARY KEY,
  filename    TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'pending',
  approved_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Key-value counters.
-- Two distinct counters — NEVER share the same key for different purposes:
--   consecutive_api_errors : reset on any DeepSeek success (conservative mode — T17)
--   closes_since_review    : reset only after REVIEW agent runs (REVIEW trigger — T15)
CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- Daily LLM token usage for budget guard (T14)
CREATE TABLE IF NOT EXISTS daily_usage (
  date      TEXT NOT NULL,
  model     TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd  REAL NOT NULL DEFAULT 0.0,
  PRIMARY KEY (date, model)
);

-- Migration metadata
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
