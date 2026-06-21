-- Closed positions analytics (migrated from lessons.json → performance array)
-- status: 'active' (default) | 'archived' (closed >90 days ago — excluded from hot/cold layers)
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
  raw         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
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
-- Three distinct counters — NEVER share the same key for different purposes:
--   consecutive_api_errors : reset on any DeepSeek success (conservative mode — T17)
--   closes_since_review    : reset only after REVIEW agent runs (REVIEW trigger — T15)
--   closes_since_compound  : reset after fee compound triggered (5 oor_down closes → compound)
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

-- Paper trading positions — simulated positions tracked in DRY_RUN mode (T18)
-- OOR detection uses entry_bin ± bins_below/above against live active bin.
CREATE TABLE IF NOT EXISTS paper_positions (
  id                TEXT PRIMARY KEY,
  pool_address      TEXT NOT NULL,
  pool_name         TEXT,
  strategy          TEXT,
  entry_bin         INTEGER,
  bins_below        INTEGER NOT NULL DEFAULT 0,
  bins_above        INTEGER NOT NULL DEFAULT 0,
  amount_sol        REAL NOT NULL,
  entry_time        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  exit_time         TEXT,
  exit_reason       TEXT,
  simulated_fee_sol  REAL NOT NULL DEFAULT 0.0,
  simulated_pnl_sol  REAL NOT NULL DEFAULT 0.0,
  entry_fee_rate_24h REAL,   -- fee_tvl_ratio (%) from Meteora at deploy time; NULL = use constant fallback
  reasoning_summary  TEXT,
  status             TEXT NOT NULL DEFAULT 'open'
);

-- Circuit breaker state — single-row sentinel (id must be 1) (T20)
-- Tracks daily loss, consecutive losses, and triggered status.
-- date_utc triggers automatic reset of daily_loss_usd on UTC day rollover.
CREATE TABLE IF NOT EXISTS circuit_breaker (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  daily_loss_usd     REAL    NOT NULL DEFAULT 0.0,
  consecutive_losses INTEGER NOT NULL DEFAULT 0,
  peak_portfolio_sol REAL,
  triggered          INTEGER NOT NULL DEFAULT 0,
  trigger_reason     TEXT,
  triggered_at       TEXT,
  date_utc           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d', 'now'))
);

-- Historical backtest results (T23) — one row per (pool, date, decision) simulated replay.
-- Each scenario is run 3x at temp>0 for robustness; majority vote stored in majority_decision.
-- actual_outcome: 'win' | 'loss' | 'unknown' — filled after 7-day APY comparison.
CREATE TABLE IF NOT EXISTS backtests (
  id               TEXT NOT NULL DEFAULT (lower(hex(randomblob(8)))),
  pool_address     TEXT NOT NULL,
  pool_name        TEXT,
  snapshot_date    TEXT NOT NULL,           -- 'YYYY-MM-DD' — the day the frozen context was built
  decision         TEXT NOT NULL,           -- final majority vote: 'deploy' | 'skip'
  decision_reason  TEXT,                    -- brief reason from LLM
  majority_count   INTEGER NOT NULL DEFAULT 1,  -- how many of 3 runs agreed (1-3)
  fee_apy_7d       REAL,                    -- actual 7-day fee APY after snapshot_date
  oor_within_24h   INTEGER,                 -- 1=went OOR within 24h, 0=held, NULL=unknown
  actual_outcome   TEXT NOT NULL DEFAULT 'unknown',  -- 'win' | 'loss' | 'unknown'
  ran_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Devnet test run records (T22) — each row is one phase (deploy or close) of a devnet cycle.
-- Gate: 10+ total_cycles rows with success=1 and no unhandled errors (checked by getDevnetSummary).
CREATE TABLE IF NOT EXISTS devnet_runs (
  id             TEXT NOT NULL DEFAULT (lower(hex(randomblob(8)))),
  run_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  cycle_id       TEXT NOT NULL,           -- groups deploy+close of the same cycle
  phase          TEXT NOT NULL,           -- 'deploy' | 'close'
  pool_address   TEXT,
  tx_signature   TEXT,
  deploy_amount  REAL,
  close_amount   REAL,
  gas_actual_sol REAL,
  slippage_pct   REAL,
  success        INTEGER NOT NULL DEFAULT 0,
  error_msg      TEXT
);

-- Migration metadata
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
