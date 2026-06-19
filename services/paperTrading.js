import { getDb } from "../db/db.js";
import { log } from "../logger.js";

/** Simulated hourly fee rate: 0.02% per hour ≈ 175% APY (optimistic — good active pool). */
export const PAPER_HOURLY_FEE_RATE = 0.0002;

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
} = {}) {
  if (!pool_address) throw new Error("pool_address is required");
  if (!amount_sol || amount_sol <= 0) throw new Error("amount_sol must be positive");

  const id = `${pool_address}_${Date.now()}`;
  db.prepare(`
    INSERT INTO paper_positions
      (id, pool_address, pool_name, strategy, entry_bin, bins_below, bins_above, amount_sol, reasoning_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, pool_address, pool_name ?? null, strategy ?? null, entry_bin ?? null, bins_below, bins_above, amount_sol, reasoning_summary ?? null);

  log("paper", `Opened paper position: ${pool_name || pool_address} entry_bin=${entry_bin ?? "?"} bins=[${bins_below}↓ ${bins_above}↑] amount=${amount_sol} SOL`);
  return id;
}

/**
 * Close an open paper position, computing simulated PnL based on time in range.
 * @returns {object|null} closed position data, or null if not found
 */
export function closePaperPosition(db = getDb(), id, exit_reason = "oor") {
  const pos = db.prepare("SELECT * FROM paper_positions WHERE id = ? AND status = 'open'").get(id);
  if (!pos) return null;

  const now = new Date().toISOString();
  const entryMs = new Date(pos.entry_time).getTime();
  const exitMs = Date.now();
  const hoursInRange = Math.max(0, (exitMs - entryMs) / 3_600_000);
  const simulated_fee_sol = pos.amount_sol * PAPER_HOURLY_FEE_RATE * hoursInRange;
  // Single-side SOL deploy: no impermanent loss when in range, PnL = earned fees
  const simulated_pnl_sol = simulated_fee_sol;

  db.prepare(`
    UPDATE paper_positions
    SET status='closed', exit_time=?, exit_reason=?, simulated_fee_sol=?, simulated_pnl_sol=?
    WHERE id = ?
  `).run(now, exit_reason, simulated_fee_sol, simulated_pnl_sol, id);

  log("paper", `Closed paper position ${id}: ${exit_reason} | holding=${hoursInRange.toFixed(2)}h | fee=${simulated_fee_sol.toFixed(6)} SOL`);
  return { id, pool_address: pos.pool_address, pool_name: pos.pool_name, simulated_fee_sol, simulated_pnl_sol, exit_reason, hours_in_range: hoursInRange };
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
      const isOor = currentBin < minBin || currentBin > maxBin;

      if (isOor) {
        const result = closePaperPosition(db, pos.id, `oor:bin=${currentBin}`);
        if (result) closed.push(result);
      }
    } catch (e) {
      const hoursOpen = pos.entry_time
        ? ((Date.now() - new Date(pos.entry_time).getTime()) / 3_600_000).toFixed(1)
        : "?";
      log("paper_warn", `OOR check failed for paper position ${pos.id} (open ${hoursOpen}h): ${e.message}`);
    }
  }
  return closed;
}

/**
 * Aggregate stats for the /paper_stats Telegram command.
 */
export function getPaperStats(db = getDb()) {
  const openRow = db.prepare("SELECT COUNT(*) as count FROM paper_positions WHERE status='open'").get();
  const closedRow = db.prepare("SELECT COUNT(*) as count FROM paper_positions WHERE status='closed'").get();
  const winsRow = db.prepare("SELECT COUNT(*) as count FROM paper_positions WHERE status='closed' AND simulated_pnl_sol > 0.000001").get();
  const pnlRow = db.prepare(`
    SELECT AVG(simulated_pnl_sol) as avg_pnl, SUM(simulated_fee_sol) as total_fee
    FROM paper_positions WHERE status='closed'
  `).get();

  const closedCount = closedRow?.count ?? 0;
  const winCount = winsRow?.count ?? 0;
  const win_rate = closedCount > 0 ? winCount / closedCount : null;

  // Holding time histogram
  const holdingRows = db.prepare(`
    SELECT CAST((julianday(exit_time) - julianday(entry_time)) * 24 AS REAL) as hours
    FROM paper_positions WHERE status='closed' AND exit_time IS NOT NULL AND entry_time IS NOT NULL
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
