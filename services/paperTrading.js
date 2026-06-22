import { getDb } from "../db/db.js";
import { log } from "../logger.js";

/**
 * Fallback hourly fee rate used when pool's real fee_tvl_ratio is unavailable.
 * 0.02%/hr ≈ 175% APY — conservative baseline. Real pools vary: 0.04%–0.5%/hr.
 */
export const PAPER_HOURLY_FEE_RATE = 0.0002;

// Live gas cost per position (deploy + close). Win in paper trading = earned more than this.
// Matches GAS_SOL constant in scripts/monte_carlo.py for 1:1 simulation accuracy.
export const GAS_ROUND_TRIP_SOL = 0.006;

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
  fee_rate_24h = null,  // fee_tvl_ratio (%) from pool at deploy time — used for realistic fee simulation
  position_type = "unknown",  // "stable" | "meme" | "unknown" from dual screening slot
} = {}) {
  if (!pool_address) throw new Error("pool_address is required");
  if (!amount_sol || amount_sol <= 0) throw new Error("amount_sol must be positive");

  const id = `${pool_address}_${Date.now()}`;
  const parsedFeeRate = fee_rate_24h != null && Number.isFinite(Number(fee_rate_24h)) ? Number(fee_rate_24h) : null;

  db.prepare(`
    INSERT INTO paper_positions
      (id, pool_address, pool_name, strategy, entry_bin, bins_below, bins_above, amount_sol, entry_fee_rate_24h, reasoning_summary, position_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, pool_address, pool_name ?? null, strategy ?? null, entry_bin ?? null, bins_below, bins_above, amount_sol, parsedFeeRate, reasoning_summary ?? null, position_type);

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
    const simulated_fee_sol = pos.amount_sol * hourlyRate * hoursInRange;
    // Single-side SOL deploy: no impermanent loss when in range, PnL = earned fees
    const simulated_pnl_sol = simulated_fee_sol;

    db.prepare(`
      UPDATE paper_positions
      SET status='closed', exit_time=?, exit_reason=?, simulated_fee_sol=?, simulated_pnl_sol=?
      WHERE id = ?
    `).run(now, exit_reason, simulated_fee_sol, simulated_pnl_sol, id);

    db.exec("COMMIT");
    log("paper", `Closed paper position ${id}: ${exit_reason} | holding=${hoursInRange.toFixed(2)}h | fee=${simulated_fee_sol.toFixed(6)} SOL`);
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
  const closedRow = db.prepare("SELECT COUNT(*) as count FROM paper_positions WHERE status='closed'").get();
  const winsRow = db.prepare("SELECT COUNT(*) as count FROM paper_positions WHERE status='closed' AND simulated_pnl_sol > ?").get(GAS_ROUND_TRIP_SOL);
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
