/**
 * T23 — Historical Replay Pipeline
 *
 * For each pool and historical date D:
 *   1. Build a "frozen context" snapshot (pool stats as of day D)
 *   2. Run SCREENER in simulation mode 3x → majority vote for 'deploy' | 'skip'
 *   3. Compare decision vs actual pool performance (fee APY next 7 days, OOR within 24h)
 *   4. Store in `backtests` SQLite table
 *
 * Actual LLM calls are done via agentLoop in simulation mode (passed in as dependency).
 * This module handles only the data layer and decision recording — no LLM imports.
 *
 * Usage (called from index.js `/run_backtest` Telegram command):
 *   const results = await runBacktestBatch(db, pools, agentSimFn, { daysBack: 30 });
 */

/**
 * Record a single backtest result.
 *
 * @param {object} db
 * @param {{ pool_address: string, pool_name?: string, snapshot_date: string,
 *            decision: 'deploy'|'skip', decision_reason?: string,
 *            majority_count?: number, fee_apy_7d?: number,
 *            oor_within_24h?: number, actual_outcome?: 'win'|'loss'|'unknown' }} bt
 * @returns {string} - inserted row id
 */
export function recordBacktest(db, bt) {
  const id = `bt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO backtests
      (id, pool_address, pool_name, snapshot_date, decision, decision_reason,
       majority_count, fee_apy_7d, oor_within_24h, actual_outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    bt.pool_address,
    bt.pool_name ?? null,
    bt.snapshot_date,
    bt.decision,
    bt.decision_reason ?? null,
    bt.majority_count ?? 1,
    bt.fee_apy_7d ?? null,
    bt.oor_within_24h ?? null,
    bt.actual_outcome ?? "unknown",
  );
  return id;
}

/**
 * Update actual outcome fields after 7-day window has passed.
 *
 * @param {object} db
 * @param {string} id - backtest row id
 * @param {{ fee_apy_7d: number, oor_within_24h: number }} outcome
 */
export function updateBacktestOutcome(db, id, { fee_apy_7d, oor_within_24h }) {
  const actual_outcome = fee_apy_7d > 0 && oor_within_24h != null && !oor_within_24h ? "win" : "loss";
  db.prepare(`
    UPDATE backtests
    SET fee_apy_7d = ?, oor_within_24h = ?, actual_outcome = ?
    WHERE id = ?
  `).run(fee_apy_7d, oor_within_24h ? 1 : 0, actual_outcome, id);
}

/**
 * Query backtest results, optionally filtered.
 *
 * @param {object} db
 * @param {{ pool_name?: string, decision?: 'deploy'|'skip',
 *            actual_outcome?: 'win'|'loss'|'unknown', limit?: number }} filters
 * @returns {Array<object>}
 */
export function queryBacktests(db, { pool_name, decision, actual_outcome, limit = 50 } = {}) {
  const conditions = [];
  const params = [];

  if (pool_name) {
    conditions.push("pool_name LIKE ?");
    params.push(`%${pool_name}%`);
  }
  if (decision) {
    conditions.push("decision = ?");
    params.push(decision);
  }
  if (actual_outcome) {
    conditions.push("actual_outcome = ?");
    params.push(actual_outcome);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(Math.min(limit, 200));

  return db.prepare(`
    SELECT * FROM backtests ${where} ORDER BY snapshot_date DESC, ran_at DESC LIMIT ?
  `).all(...params);
}

/**
 * Aggregate backtest statistics for /backtest_report Telegram command.
 *
 * @param {object} db
 * @param {{ pool_name?: string } } filters
 * @returns {{ total: number, deploy_decisions: number, skip_decisions: number,
 *             wins: number, losses: number, win_rate: number|null,
 *             avg_majority_count: number|null }}
 */
export function getBacktestSummary(db, { pool_name } = {}) {
  const rows = queryBacktests(db, { pool_name, limit: 200 });

  const total = rows.length;
  const deployDecisions = rows.filter((r) => r.decision === "deploy").length;
  const skipDecisions = rows.filter((r) => r.decision === "skip").length;
  const wins = rows.filter((r) => r.actual_outcome === "win").length;
  const losses = rows.filter((r) => r.actual_outcome === "loss").length;
  const resolved = wins + losses;

  const winRate = resolved > 0 ? wins / resolved : null;

  const majoritySum = rows.reduce((s, r) => s + (r.majority_count ?? 1), 0);
  const avgMajority = total > 0 ? majoritySum / total : null;

  return {
    total,
    deploy_decisions: deployDecisions,
    skip_decisions: skipDecisions,
    wins,
    losses,
    win_rate: winRate,
    avg_majority_count: avgMajority,
  };
}

/**
 * Derive a majority decision from an array of 3 LLM simulation results.
 * Returns 'deploy' if at least 2/3 runs say deploy, else 'skip'.
 *
 * @param {Array<'deploy'|'skip'>} decisions - Array of 1-3 individual run decisions
 * @returns {{ decision: 'deploy'|'skip', majority_count: number }}
 */
export function majorityVote(decisions) {
  const deployCount = decisions.filter((d) => d === "deploy").length;
  const majority_count = Math.max(deployCount, decisions.length - deployCount);
  const decision = deployCount >= Math.ceil(decisions.length / 2) ? "deploy" : "skip";
  return { decision, majority_count };
}
