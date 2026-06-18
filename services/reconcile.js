/**
 * T11: Blockchain reconciliation service.
 *
 * Compares local state.json open positions with on-chain positions.
 * Any local-open position missing from chain (and outside the 5-min grace period)
 * is auto-closed by syncOpenPositions() and triggers a Telegram alert.
 *
 * Called on bot startup + every 30 minutes via startCronJobs() in index.js.
 */

import { getTrackedPositions, syncOpenPositions } from "../state.js";
import { sendMessage, isEnabled } from "../telegram.js";
import { getMyPositions } from "../tools/dlmm.js";
import { log } from "../logger.js";

/**
 * Reconcile local state with on-chain positions.
 *
 * @param {object}   [opts]
 * @param {boolean}  [opts.fetchFromChain=true]      Fetch live data; set false in tests.
 * @param {string[]} [opts.activeAddresses]           On-chain addresses (used when fetchFromChain=false).
 * @param {Function} [opts._getTrackedPositions]      Injectable for testing.
 * @param {Function} [opts._syncOpenPositions]        Injectable for testing.
 * @param {Function|null} [opts._sendAlert]           Injectable for testing (null → real Telegram).
 * @returns {Promise<{reconciled:number, autoClosed:string[]} | {error:string, reconciled:0}>}
 */
export async function reconcilePositions({
  fetchFromChain = true,
  activeAddresses = null,
  _getTrackedPositions = getTrackedPositions,
  _syncOpenPositions = syncOpenPositions,
  _sendAlert = null,
} = {}) {
  // Snapshot local open positions before sync
  const openBefore = _getTrackedPositions(true).map((p) => p.position);

  if (openBefore.length === 0) {
    return { reconciled: 0, autoClosed: [] };
  }

  // Get on-chain active position addresses
  let chainAddresses;
  if (fetchFromChain) {
    try {
      const result = await getMyPositions({ force: true, silent: true });
      chainAddresses = (result.positions || []).map((p) => p.position);
    } catch (err) {
      log("reconcile_error", `Failed to fetch on-chain positions: ${err.message}`);
      return { error: err.message, reconciled: 0 };
    }
  } else {
    chainAddresses = activeAddresses ?? [];
  }

  // Run the sync — syncOpenPositions handles the 5-min grace period internally
  _syncOpenPositions(chainAddresses);

  // Detect auto-closed positions: locally open before sync, not found on chain
  const chainSet = new Set(chainAddresses);
  const autoClosed = openBefore.filter((addr) => !chainSet.has(addr));

  if (autoClosed.length > 0) {
    log("reconcile", `Mismatch: ${autoClosed.length} position(s) not found on-chain — auto-closed`);

    const alertFn = _sendAlert ?? (isEnabled() ? sendMessage : null);
    if (alertFn) {
      const names = autoClosed.map((a) => `• ${a.slice(0, 8)}…`).join("\n");
      await alertFn(
        `⚠️ Blockchain reconciliation: ${autoClosed.length} local position(s) not found on-chain — auto-closed:\n${names}\n\nLocal state updated from chain. Check for failed transactions.`
      ).catch(() => {});
    }
  } else {
    log("reconcile", "Reconciliation OK — local state matches chain");
  }

  return { reconciled: autoClosed.length, autoClosed };
}
