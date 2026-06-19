/**
 * T22 — Devnet Testing Harness
 *
 * Records devnet cycle outcomes (deploy + close) to the `devnet_runs` SQLite table.
 * Each full cycle consists of two phases: 'deploy' and 'close'.
 *
 * Gate for go-live certification (T25): ≥10 complete cycles, all successful.
 *
 * Usage:
 *   SOLANA_NETWORK=devnet HELIUS_DEVNET_RPC_URL=https://devnet.helius-rpc.com/?api-key=X node index.js
 */

/**
 * @returns {boolean} True when running in devnet mode.
 */
export function isDevnetMode() {
  return process.env.SOLANA_NETWORK === "devnet";
}

/**
 * Record a single phase (deploy or close) of a devnet cycle.
 *
 * @param {object} db
 * @param {{ cycle_id: string, phase: 'deploy'|'close', pool_address?: string,
 *            tx_signature?: string, deploy_amount?: number, close_amount?: number,
 *            gas_actual_sol?: number, slippage_pct?: number,
 *            success: boolean, error_msg?: string }} run
 * @returns {string} - The id of the inserted row
 */
export function recordDevnetRun(db, run) {
  const id = `dr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO devnet_runs
      (id, cycle_id, phase, pool_address, tx_signature, deploy_amount,
       close_amount, gas_actual_sol, slippage_pct, success, error_msg)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    run.cycle_id,
    run.phase,
    run.pool_address ?? null,
    run.tx_signature ?? null,
    run.deploy_amount ?? null,
    run.close_amount ?? null,
    run.gas_actual_sol ?? null,
    run.slippage_pct ?? null,
    run.success ? 1 : 0,
    run.error_msg ?? null,
  );
  return id;
}

/**
 * Return aggregated stats for the `/devnet_report` Telegram command and T25 certification.
 * A "complete cycle" means both 'deploy' and 'close' phases exist for the same cycle_id.
 *
 * @param {object} db
 * @returns {{ total_phases: number, successful_phases: number, failed_phases: number,
 *             complete_cycles: number, successful_cycles: number,
 *             avg_gas_sol: number|null, last_run_at: string|null,
 *             gate_passed: boolean }}
 */
export function getDevnetSummary(db) {
  const phases = db.prepare("SELECT * FROM devnet_runs ORDER BY run_at ASC").all();

  const totalPhases = phases.length;
  const successfulPhases = phases.filter((r) => r.success === 1).length;
  const failedPhases = totalPhases - successfulPhases;

  // Count cycles where BOTH deploy AND close phases exist
  const cycleMap = new Map();
  for (const row of phases) {
    if (!cycleMap.has(row.cycle_id)) cycleMap.set(row.cycle_id, { deploy: false, close: false, failed: false });
    const c = cycleMap.get(row.cycle_id);
    if (row.phase === "deploy") c.deploy = true;
    if (row.phase === "close") c.close = true;
    if (!row.success) c.failed = true;
  }

  const completeCycles = [...cycleMap.values()].filter((c) => c.deploy && c.close).length;
  const successfulCycles = [...cycleMap.values()].filter((c) => c.deploy && c.close && !c.failed).length;

  const gasRows = phases.filter((r) => r.gas_actual_sol != null);
  const avgGasSol = gasRows.length > 0
    ? gasRows.reduce((sum, r) => sum + r.gas_actual_sol, 0) / gasRows.length
    : null;

  const lastRun = phases.at(-1);

  return {
    total_phases: totalPhases,
    successful_phases: successfulPhases,
    failed_phases: failedPhases,
    complete_cycles: completeCycles,
    successful_cycles: successfulCycles,
    avg_gas_sol: avgGasSol,
    last_run_at: lastRun?.run_at ?? null,
    gate_passed: successfulCycles >= 10,
  };
}
