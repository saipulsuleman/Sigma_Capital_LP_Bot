import { getDb } from "../db/db.js";
import { log } from "../logger.js";

/**
 * Fallback hourly fee rate used when pool's real fee_tvl_ratio is unavailable.
 * 0.02%/hr ≈ 175% APY — conservative baseline. Real pools vary: 0.04%–0.5%/hr.
 */
export const PAPER_HOURLY_FEE_RATE = 0.0002;

// Live gas cost per position (deploy + close base transactions).
// Matches GAS_SOL constant in scripts/monte_carlo.py for 1:1 simulation accuracy.
export const GAS_ROUND_TRIP_SOL = 0.006;
// Priority / Jito tips to land the deploy + close (+ swap-back) txs on a busy validator.
export const PRIORITY_FEE_ROUND_TRIP_SOL = 0.0004;
// Slippage paid when swapping the converted token back to SOL on a downward exit.
export const SWAP_SLIPPAGE_PCT = 0.05;
// Fallback bin step (bps) for positions opened before entry_bin_step was recorded.
export const DEFAULT_BIN_STEP_BPS = 100;

/** Parse the bin id out of an exit_reason like "oor_down:bin=-469". */
function parseExitBin(reason) {
  const m = /bin=(-?\d+)/.exec(reason ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * Estimate the real costs a paper position would pay at close, in SOL, so paper PnL
 * tracks a live close. Returns { gas, priority, il_loss, swap_slippage, total }.
 *
 * Conversion / impermanent loss applies only to downward exits (oor_down). Single-sided
 * SOL liquidity sits in bins BELOW price; as price falls the SOL is swapped into the
 * token, so at a downward exit the principal is now token worth less than the SOL
 * deposited. We mark it to market at the exit bin using the geometric-mean average buy
 * price across the range: value/principal = r^((exit_bin - entry_bin) + bins_below/2),
 * where r = 1 + bin_step/10000. Upward / max-hold exits leave SOL intact (no IL).
 *
 * Pure + exported for unit testing.
 */
export function simulatedExitCosts(pos, exit_reason) {
  const gas = GAS_ROUND_TRIP_SOL;
  const priority = PRIORITY_FEE_ROUND_TRIP_SOL;
  let il_loss = 0;
  let swap_slippage = 0;

  const isDownExit = typeof exit_reason === "string" && exit_reason.startsWith("oor_down");
  const exitBin = parseExitBin(exit_reason);
  if (isDownExit && pos.entry_bin != null && exitBin != null) {
    const binStepBps = pos.entry_bin_step ?? DEFAULT_BIN_STEP_BPS;
    const r = 1 + binStepBps / 10000;
    const binsBelow = Number(pos.bins_below) || 0;
    const exponent = (exitBin - pos.entry_bin) + binsBelow / 2;
    const conversionRatio = Math.min(1, Math.max(0, Math.pow(r, exponent)));
    const principalValueSol = pos.amount_sol * conversionRatio;
    il_loss = pos.amount_sol - principalValueSol;
    swap_slippage = principalValueSol * SWAP_SLIPPAGE_PCT;
  }
  return { gas, priority, il_loss, swap_slippage, total: gas + priority + il_loss + swap_slippage };
}

/**
 * SQL filter for win-rate / analytics: only count closed positions exited under the
 * CURRENT OOR logic. Pre-fix `oor:` positions (buggy era — premature upward exits,
 * ~0.16h holds, ~0 fees) are excluded as corrupt data, not real strategy performance.
 * Shared by getPaperStats, getPaperAnalytics, and getCombinedAnalytics so the T25 gate,
 * /paper_stats, and /analytics all agree.
 */
export const ORGANIC_CLOSED_FILTER =
  "status='closed' AND exit_time IS NOT NULL AND (exit_reason IS NULL OR exit_reason NOT LIKE 'oor:%')";

/**
 * Record a new simulated paper position when SCREENER calls deploy_position in DRY_RUN mode.
 * @returns {string} id of the created record
 */
export function openPaperPosition(db = getDb(), {
  pool_address,
  pool_name = null,
  entry_bin = null,
  bins_below = 0,
  bins_above = 0,
  amount_sol,
  strategy = null,
  reasoning_summary = null,
  fee_rate_24h = null,  // fee_tvl_ratio converted to %/24h (caller must normalize from per-timeframe)
  position_type = "unknown",  // "stable" | "meme" | "unknown" from dual screening slot
  bin_step = null,      // pool bin step (bps) — needed to mark converted principal to market on exit
} = {}) {
  if (!pool_address) throw new Error("pool_address is required");
  if (!amount_sol || amount_sol <= 0) throw new Error("amount_sol must be positive");

  const id = `${pool_address}_${Date.now()}`;
  const parsedFeeRate = fee_rate_24h != null && Number.isFinite(Number(fee_rate_24h)) ? Number(fee_rate_24h) : null;
  const parsedBinStep = bin_step != null && Number.isFinite(Number(bin_step)) ? Number(bin_step) : null;

  db.prepare(`
    INSERT INTO paper_positions
      (id, pool_address, pool_name, strategy, entry_bin, bins_below, bins_above, amount_sol, entry_fee_rate_24h, reasoning_summary, position_type, entry_bin_step)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, pool_address, pool_name ?? null, strategy ?? null, entry_bin ?? null, bins_below, bins_above, amount_sol, parsedFeeRate, reasoning_summary ?? null, position_type, parsedBinStep);

  const feeNote = parsedFeeRate != null
    ? ` fee_rate=${parsedFeeRate}%/24h → est ${(amount_sol * parsedFeeRate / 100).toFixed(5)} SOL/24h if in range`
    : " fee_rate=fallback";
  log("paper", `Opened paper position: ${pool_name || pool_address} entry_bin=${entry_bin ?? "?"} bins=[${bins_below}↓ ${bins_above}↑] amount=${amount_sol} SOL${feeNote}`);
  return id;
}

/**
 * Close an open paper position, computing simulated PnL based on time in range.
 * @returns {object|null} closed position data, or null if not found
 */
export function closePaperPosition(db = getDb(), id, exit_reason = "oor") {
  try {
    db.exec("BEGIN");
    const pos = db.prepare("SELECT * FROM paper_positions WHERE id = ? AND status = 'open'").get(id);
    if (!pos) { db.exec("ROLLBACK"); return null; }

    const now = new Date().toISOString();
    // Guard: entry_time null → new Date(null) = epoch 0 → ~495k hours. Use Date.now() as safe fallback (0h held).
    const entryMs = pos.entry_time ? new Date(pos.entry_time).getTime() : Date.now();
    const exitMs = Date.now();
    const hoursInRange = Math.max(0, (exitMs - entryMs) / 3_600_000);
    // Use real pool fee rate if stored, else fallback to constant.
    // entry_fee_rate_24h is a percentage (e.g. 9.69 means 9.69% of position per 24h).
    const hourlyRate = pos.entry_fee_rate_24h != null
      ? (pos.entry_fee_rate_24h / 100) / 24
      : PAPER_HOURLY_FEE_RATE;
    const simulated_fee_sol = pos.amount_sol * hourlyRate * hoursInRange;  // gross fees earned
    // Net PnL: subtract every cost a live close would pay — gas + priority fee, plus on a
    // downward exit the conversion/impermanent loss (SOL swapped into a now-cheaper token)
    // and the slippage to swap it back. Keeps paper PnL close to live reality.
    const costs = simulatedExitCosts({ ...pos, exit_reason }, exit_reason);
    const simulated_pnl_sol = simulated_fee_sol - costs.total;

    db.prepare(`
      UPDATE paper_positions
      SET status='closed', exit_time=?, exit_reason=?, simulated_fee_sol=?, simulated_pnl_sol=?
      WHERE id = ?
    `).run(now, exit_reason, simulated_fee_sol, simulated_pnl_sol, id);

    db.exec("COMMIT");
    log("paper", `Closed paper position ${id}: ${exit_reason} | holding=${hoursInRange.toFixed(2)}h | fee=${simulated_fee_sol.toFixed(6)} SOL | costs=${costs.total.toFixed(6)} (il=${costs.il_loss.toFixed(6)}) | net=${simulated_pnl_sol.toFixed(6)} SOL`);
    return { id, pool_address: pos.pool_address, pool_name: pos.pool_name, simulated_fee_sol, simulated_pnl_sol, exit_reason, hours_in_range: hoursInRange };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

/**
 * Check each open paper position's current active bin.
 * Close positions that have gone out of range.
 * @param {object} db - SQLite connection
 * @param {Function} getActiveBinFn - async fn({ pool_address }) → { binId }
 * @returns {Array} array of closed position result objects
 */
export async function updatePaperPositions(db = getDb(), getActiveBinFn) {
  const open = db.prepare("SELECT * FROM paper_positions WHERE status = 'open'").all();
  if (open.length === 0) return [];

  const closed = [];
  for (const pos of open) {
    if (pos.entry_bin == null) continue; // no entry bin recorded — can't detect OOR

    try {
      const binData = await getActiveBinFn({ pool_address: pos.pool_address });
      const currentBin = binData?.binId ?? null;
      if (currentBin == null) continue;

      const minBin = pos.entry_bin - pos.bins_below;
      const maxBin = pos.entry_bin + pos.bins_above;
      // Single-sided positions (bins_above=0) are idle when price is above entry — SOL
      // intact, just waiting. Only exit on downward OOR (price crashed below range).
      // Two-sided positions exit in either direction as normal.
      const isOorDown = currentBin < minBin;
      const isOorUp = currentBin > maxBin;
      const isOor = pos.bins_above === 0 ? isOorDown : (isOorDown || isOorUp);

      if (isOor) {
        const exitReason = isOorDown ? `oor_down:bin=${currentBin}` : `oor_up:bin=${currentBin}`;
        const result = closePaperPosition(db, pos.id, exitReason);
        if (result) closed.push(result);
      }
    } catch (e) {
      const hoursOpenMs = pos.entry_time ? Date.now() - new Date(pos.entry_time).getTime() : 0;
      const hoursOpen = (hoursOpenMs / 3_600_000).toFixed(1);
      log("paper_warn", `OOR check failed for paper position ${pos.id} (open ${hoursOpen}h): ${e.message}`);
      // Force-close after 168h (7 days) — matches monte carlo max hold cap — prevents stuck positions
      if (hoursOpenMs >= 168 * 3_600_000) {
        const result = closePaperPosition(db, pos.id, "max_hold_exceeded");
        if (result) closed.push(result);
      }
    }
  }
  return closed;
}

/**
 * Aggregate stats for the /paper_stats Telegram command.
 */
export function getPaperStats(db = getDb()) {
  const openRow = db.prepare("SELECT COUNT(*) as count FROM paper_positions WHERE status='open'").get();
  const closedRow = db.prepare(`SELECT COUNT(*) as count FROM paper_positions WHERE ${ORGANIC_CLOSED_FILTER}`).get();
  // simulated_pnl_sol is already net of all costs (gas, priority, slippage, IL) — a win is net-positive.
  const winsRow = db.prepare(`SELECT COUNT(*) as count FROM paper_positions WHERE ${ORGANIC_CLOSED_FILTER} AND simulated_pnl_sol > 0`).get();
  const pnlRow = db.prepare(`
    SELECT AVG(simulated_pnl_sol) as avg_pnl, SUM(simulated_fee_sol) as total_fee
    FROM paper_positions WHERE ${ORGANIC_CLOSED_FILTER}
  `).get();

  const closedCount = closedRow?.count ?? 0;
  const winCount = winsRow?.count ?? 0;
  const win_rate = closedCount > 0 ? winCount / closedCount : null;

  // Holding time histogram
  const holdingRows = db.prepare(`
    SELECT CAST((julianday(exit_time) - julianday(entry_time)) * 24 AS REAL) as hours
    FROM paper_positions WHERE ${ORGANIC_CLOSED_FILTER} AND entry_time IS NOT NULL
  `).all();

  const histogram = { lt1h: 0, h1_4: 0, h4_24: 0, gt24h: 0 };
  let totalHours = 0;
  for (const { hours } of holdingRows) {
    totalHours += hours;
    if (hours < 1) histogram.lt1h++;
    else if (hours < 4) histogram.h1_4++;
    else if (hours < 24) histogram.h4_24++;
    else histogram.gt24h++;
  }

  const avg_holding_hours = holdingRows.length > 0 ? totalHours / holdingRows.length : null;

  return {
    open_count: openRow?.count ?? 0,
    closed_count: closedCount,
    win_count: winCount,
    win_rate,
    avg_pnl_sol: pnlRow?.avg_pnl ?? null,
    total_fee_sol: pnlRow?.total_fee ?? null,
    avg_holding_hours,
    holding_histogram: histogram,
  };
}
