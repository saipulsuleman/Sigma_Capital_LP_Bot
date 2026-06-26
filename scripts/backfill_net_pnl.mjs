/**
 * One-time backfill: recompute simulated_pnl_sol as realistic NET for every closed paper
 * position. Positions closed before the cost model (commit d233713) stored GROSS pnl, which
 * inflates the T25 win-rate gate (e.g. a tiny gross-positive close counts as a win when its
 * net — after gas/slippage/IL — is a loss). Recomputing from stored params makes the gate,
 * analytics, /paper_stats, and the audit all agree on net. Idempotent: recomputes from
 * params, so positions already stored as net are unchanged.
 *
 * Run: node scripts/backfill_net_pnl.mjs
 */
import { getDb } from "../db/db.js";
import { simulatedExitCosts, PAPER_HOURLY_FEE_RATE } from "../services/paperTrading.js";

const db = getDb();
const rows = db.prepare(`
  SELECT id, pool_name, amount_sol, entry_fee_rate_24h, bins_below, entry_bin, entry_bin_step,
         exit_reason, entry_time, exit_time, simulated_pnl_sol
  FROM paper_positions WHERE status='closed'
`).all();

const update = db.prepare("UPDATE paper_positions SET simulated_pnl_sol=?, simulated_fee_sol=? WHERE id=?");
let changed = 0;
for (const r of rows) {
  const hrs = (r.entry_time && r.exit_time) ? Math.max(0, (new Date(r.exit_time) - new Date(r.entry_time)) / 3_600_000) : 0;
  const rate = r.entry_fee_rate_24h != null ? (r.entry_fee_rate_24h / 100) / 24 : PAPER_HOURLY_FEE_RATE;
  const gross = (r.amount_sol ?? 0) * rate * hrs;
  const net = gross - simulatedExitCosts(r, r.exit_reason).total;
  const before = Number(r.simulated_pnl_sol ?? 0);
  if (Math.abs(before - net) > 1e-9) {
    update.run(net, gross, r.id);
    changed++;
    console.log(`  ${(r.pool_name || r.id).slice(0, 22).padEnd(22)} | ${before >= 0 ? "+" : ""}${before.toFixed(4)} → ${net >= 0 ? "+" : ""}${net.toFixed(4)} SOL`);
  }
}
console.log(`\nBackfilled ${changed}/${rows.length} closed positions to realistic net.`);
