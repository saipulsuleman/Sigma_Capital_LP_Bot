/**
 * T12: Capital allocation guard.
 *
 * Pure function — no side effects, no I/O — so it can be unit-tested without mocks.
 * runScreeningCycle() calls this before letting the agent deploy.
 *
 * Capital constraints (user-config.example.json, D8):
 *   maxPositions:    2        (prevents more than 2 concurrent positions)
 *   deployAmountSol: 0.15 SOL (per-position floor + ceil for go-live)
 *   gasReserve:      0.10 SOL (always-kept reserve for transaction fees)
 *   Total at 2 positions: 0.15 + 0.15 + 0.10 = 0.40 SOL < 0.50 SOL go-live ✓
 */

/**
 * Check whether a new position is allowed given current capital state.
 *
 * @param {object}  opts
 * @param {number}  opts.openCount   - Number of currently open positions
 * @param {number}  opts.solBalance  - Current wallet SOL balance
 * @param {object}  opts.cfg         - Config object (config.risk + config.management)
 * @param {boolean} [opts.isDryRun=false] - Skip SOL check in DRY_RUN mode
 * @returns {{ allowed: true } | { allowed: false, reason: string }}
 */
export function checkAllocation({ openCount, solBalance, cfg, isDryRun = false }) {
  if (openCount >= cfg.risk.maxPositions) {
    return {
      allowed: false,
      reason: `Max positions reached (${openCount}/${cfg.risk.maxPositions})`,
    };
  }

  if (!isDryRun) {
    const minRequired = cfg.management.deployAmountSol + cfg.management.gasReserve;
    if (solBalance < minRequired) {
      return {
        allowed: false,
        reason: `Insufficient SOL: ${solBalance.toFixed(3)} < ${minRequired.toFixed(3)} required (deploy + reserve)`,
      };
    }
  }

  return { allowed: true };
}
