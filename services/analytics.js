/**
 * T24 — Decision Analytics Dashboard
 *
 * Aggregates data from `paper_positions` and `backtests` to produce:
 * - Win rate, avg PnL, Sharpe estimate, holding time histogram
 * - Signal contribution analysis (pool type, strategy)
 * - Top-3 losing decision patterns for REVIEW agent
 *
 * Exposed via /analytics Telegram command.
 */

import { ORGANIC_CLOSED_FILTER } from "./paperTrading.js";

/**
 * Holding time bucket: 0=<1h, 1=1-4h, 2=4-24h, 3=>24h
 */
function holdingBucket(hours) {
  if (hours < 1)  return "<1h";
  if (hours < 4)  return "1-4h";
  if (hours < 24) return "4-24h";
  return ">24h";
}

/**
 * Compute Sharpe ratio estimate: mean_return / std_return * sqrt(annualization_factor).
 * Uses a daily annualization factor (365). Returns null if fewer than 20 data points.
 *
 * @param {number[]} returns - Array of return values (pct or usd, consistent units)
 * @returns {number|null}
 */
export const MIN_SHARPE_SAMPLES = 20;

export function computeSharpe(returns) {
  if (returns.length < MIN_SHARPE_SAMPLES) return null;
  const n = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  if (std < 1e-12) return null;
  return (mean / std) * Math.sqrt(365);
}

/**
 * Aggregate paper trading stats for the /analytics command.
 *
 * @param {object} db
 * @returns {{ closed_count: number, win_count: number, loss_count: number,
 *             win_rate: number|null, avg_pnl_sol: number|null,
 *             avg_holding_hours: number|null, sharpe: number|null,
 *             holding_histogram: Record<string, number>,
 *             top_losing_patterns: Array<{ pool_name: string, avg_pnl_sol: number, count: number }> }}
 */
export function getPaperAnalytics(db) {
  const closed = db.prepare(`
    SELECT pool_name, strategy, amount_sol, simulated_pnl_sol, simulated_fee_sol,
           entry_time, exit_time
    FROM paper_positions
    WHERE ${ORGANIC_CLOSED_FILTER}
    ORDER BY exit_time DESC
  `).all();

  const closedCount = closed.length;
  // simulated_pnl_sol is already net of every cost (gas, priority fee, swap slippage, and
  // conversion/impermanent loss — see simulatedExitCosts in paperTrading.js), so a win is
  // simply net-positive. Analytics and the T25 gate agree on this definition.
  const winCount  = closed.filter((r) => (r.simulated_pnl_sol ?? 0) > 0).length;
  const lossCount = closedCount - winCount;
  const winRate   = closedCount > 0 ? winCount / closedCount : null;

  const avgPnlSol = closedCount > 0
    ? closed.reduce((s, r) => s + (r.simulated_pnl_sol ?? 0), 0) / closedCount
    : null;

  // Holding time histogram
  const histogram = { "<1h": 0, "1-4h": 0, "4-24h": 0, ">24h": 0 };
  let holdingSum = 0;
  let holdingCount = 0;
  for (const row of closed) {
    if (row.entry_time && row.exit_time) {
      const entryMs = new Date(row.entry_time).getTime();
      const exitMs  = new Date(row.exit_time).getTime();
      if (!isNaN(entryMs) && !isNaN(exitMs) && exitMs > entryMs) {
        const hours = (exitMs - entryMs) / 3_600_000;
        histogram[holdingBucket(hours)]++;
        holdingSum += hours;
        holdingCount++;
      }
    }
  }
  const avgHoldingHours = holdingCount > 0 ? holdingSum / holdingCount : null;

  // Sharpe on pnl_sol returns
  const returns = closed.map((r) => r.simulated_pnl_sol ?? 0);
  const sharpe = computeSharpe(returns);

  // Top-3 losing patterns by pool_name (lowest avg pnl, minimum 2 closes)
  const poolMap = new Map();
  for (const row of closed) {
    const name = row.pool_name ?? "unknown";
    if (!poolMap.has(name)) poolMap.set(name, { sum: 0, count: 0 });
    const e = poolMap.get(name);
    e.sum   += row.simulated_pnl_sol ?? 0;
    e.count += 1;
  }
  const losingPatterns = [...poolMap.entries()]
    .filter(([, e]) => e.count >= 2 && e.sum < 0)
    .map(([pool_name, e]) => ({ pool_name, avg_pnl_sol: e.sum / e.count, count: e.count }))
    .sort((a, b) => a.avg_pnl_sol - b.avg_pnl_sol)
    .slice(0, 3);

  return {
    closed_count: closedCount,
    win_count: winCount,
    loss_count: lossCount,
    win_rate: winRate,
    avg_pnl_sol: avgPnlSol,
    avg_holding_hours: avgHoldingHours,
    sharpe,
    holding_histogram: histogram,
    top_losing_patterns: losingPatterns,
  };
}

/**
 * Cross-source analytics: combines paper_positions + backtests for joint win rate.
 * Used for /certification gate.
 *
 * @param {object} db
 * @returns {{ paper_win_rate: number|null, backtest_win_rate: number|null,
 *             combined_trade_count: number, sharpe: number|null }}
 */
export function getCombinedAnalytics(db) {
  const paper = getPaperAnalytics(db);

  const backtestRows = db.prepare(`
    SELECT actual_outcome, fee_apy_7d
    FROM backtests
    WHERE actual_outcome != 'unknown'
  `).all();

  const btTotal = backtestRows.length;
  const btWins  = backtestRows.filter((r) => r.actual_outcome === "win").length;
  const backtestWinRate = btTotal > 0 ? btWins / btTotal : null;

  const combinedReturns = db.prepare(`SELECT simulated_pnl_sol FROM paper_positions WHERE ${ORGANIC_CLOSED_FILTER}`).all()
    .map((r) => r.simulated_pnl_sol ?? 0);

  return {
    paper_win_rate: paper.win_rate,
    backtest_win_rate: backtestWinRate,
    combined_trade_count: paper.closed_count + btTotal,
    sharpe: computeSharpe(combinedReturns),
  };
}
