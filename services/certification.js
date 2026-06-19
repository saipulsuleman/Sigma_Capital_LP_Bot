/**
 * T25 — Go-Live Certification Checklist
 *
 * Hard gate: the bot refuses to disable DRY_RUN until all certification criteria pass.
 * Each criterion has a PASS/FAIL/PENDING state and a required threshold from user-config.
 *
 * Criteria (all must be PASS before go-live):
 *   1. paper_win_rate   — paper trading win rate >= threshold (default 50%)
 *   2. sharpe           — Sharpe >= threshold (waived if < 20 trades)
 *   3. devnet_tx        — devnet successful cycles >= threshold (default 10)
 *   4. jest_tests       — test count >= threshold (default 80)
 *   5. conservative_mode_tested — triggered+recovered at least once (manual flag)
 *   6. circuit_breaker_tested   — triggered+cleared at least once (manual flag)
 */

import { getPaperAnalytics, computeSharpe, getCombinedAnalytics } from "./analytics.js";
import { getDevnetSummary } from "./devnetRunner.js";
import { config } from "../config.js";
import { getMeta, setMeta } from "../db/db.js";

const CERT_META_CONSERVATIVE = "cert_conservative_mode_tested";
const CERT_META_CIRCUIT       = "cert_circuit_breaker_tested";

/**
 * Mark that conservative mode was triggered and recovered at least once.
 * Called by utils/conservative.js after a successful auto-recovery.
 */
export function markConservativeModeTested(db) {
  setMeta(CERT_META_CONSERVATIVE, "true", db);
}

/**
 * Mark that circuit breaker was triggered and cleared at least once.
 * Called by utils/circuitBreaker.js resetCircuit + triggerCircuit combo.
 */
export function markCircuitBreakerTested(db) {
  setMeta(CERT_META_CIRCUIT, "true", db);
}

/**
 * Evaluate a single criterion.
 * @returns {{ name: string, status: 'PASS'|'FAIL'|'PENDING', actual: string, required: string }}
 */
function criterion(name, actual, required, status) {
  return { name, status, actual: String(actual), required: String(required) };
}

/**
 * Run the full certification check.
 *
 * @param {object} db
 * @param {object} certConfig — from config.certification (or default thresholds)
 * @returns {{ all_passed: boolean, criteria: Array<criterion> }}
 */
export function runCertification(db, certConfig = {}) {
  const thresholds = {
    paper_win_rate_min:       certConfig.paperWinRateMin       ?? config.certification?.paperWinRateMin       ?? 0.5,
    sharpe_min:               certConfig.sharpeMin             ?? config.certification?.sharpeMin             ?? 0.5,
    devnet_tx_min:            certConfig.devnetTxMin           ?? config.certification?.devnetTxMin           ?? 10,
    jest_tests_min:           certConfig.jestTestsMin          ?? config.certification?.jestTestsMin          ?? 80,
    conservative_mode_tested: true,
    circuit_breaker_tested:   true,
  };

  const paper    = getPaperAnalytics(db);
  const devnet   = getDevnetSummary(db);
  const combined = getCombinedAnalytics(db);

  // 1. Paper win rate
  const paperWinRate = paper.win_rate ?? 0;
  const paperStatus  = paper.closed_count === 0 ? "PENDING"
    : paperWinRate >= thresholds.paper_win_rate_min ? "PASS" : "FAIL";

  // 2. Sharpe (waived if < 20 trades)
  const sharpeVal   = paper.sharpe;
  const hasEnough   = paper.closed_count >= 20;
  const sharpeStatus = !hasEnough ? "PENDING"
    : sharpeVal != null && sharpeVal >= thresholds.sharpe_min ? "PASS" : "FAIL";

  // 3. Devnet successful cycles
  const devnetStatus = devnet.successful_cycles >= thresholds.devnet_tx_min ? "PASS" : "FAIL";

  // 4. Jest test count — read from meta (set by CI or test runner)
  const jestCountRaw = getMeta("jest_test_count", db);
  const jestCount    = jestCountRaw != null ? Number(jestCountRaw) : null;
  const jestStatus   = jestCount == null ? "PENDING"
    : jestCount >= thresholds.jest_tests_min ? "PASS" : "FAIL";

  // 5. Conservative mode tested
  const conservativeTested = getMeta(CERT_META_CONSERVATIVE, db) === "true";
  const conservativeStatus = conservativeTested ? "PASS" : "PENDING";

  // 6. Circuit breaker tested
  const circuitTested = getMeta(CERT_META_CIRCUIT, db) === "true";
  const circuitStatus = circuitTested ? "PASS" : "PENDING";

  const criteria = [
    criterion("paper_win_rate", `${(paperWinRate * 100).toFixed(1)}%`, `>=${(thresholds.paper_win_rate_min * 100).toFixed(0)}%`, paperStatus),
    criterion("sharpe",         sharpeVal != null ? sharpeVal.toFixed(2) : hasEnough ? "n/a" : `waived (<20 trades, have ${paper.closed_count})`, `>=${thresholds.sharpe_min}`, hasEnough && sharpeVal != null ? sharpeStatus : "PASS"),
    criterion("devnet_cycles",  devnet.successful_cycles, `>=${thresholds.devnet_tx_min}`, devnetStatus),
    criterion("jest_tests",     jestCount ?? "unknown", `>=${thresholds.jest_tests_min}`, jestStatus),
    criterion("conservative_mode_tested", conservativeTested ? "yes" : "no", "yes", conservativeStatus),
    criterion("circuit_breaker_tested",   circuitTested       ? "yes" : "no", "yes", circuitStatus),
  ];

  const allPassed = criteria.every((c) => c.status === "PASS");
  return { all_passed: allPassed, criteria };
}
