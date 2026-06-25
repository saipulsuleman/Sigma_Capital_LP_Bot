/**
 * Auto-tune sweep — find the optimal single-sided range (bins_below) per pool type by
 * running the REAL cost model (simulatedExitCosts / projectDeployEV) over Monte Carlo
 * GBM price paths. Instead of guessing bins_below, MEASURE net PnL for each setting.
 *
 * The position model mirrors the bot exactly:
 *  - single-sided SOL in bins below price; fees accrue only while price is in the band
 *    [entry - bins_below, entry] (where trades pass through and SOL converts to token);
 *  - exit on downward OOR (oor_down) → conversion/IL marked to market via simulatedExitCosts;
 *  - otherwise force-close at 168h max hold (SOL intact above range → tx cost only, no IL).
 *
 * Run: node scripts/autotune.mjs
 */
import { simulatedExitCosts, projectDeployEV } from "../services/paperTrading.js";

const MAX_HOLD_H = 168;
const AMOUNT_SOL = 1.0;
const GATE_CAP_H = 72;   // maxBreakEvenHours used by the live/paper IL gate

// ── Seeded RNG (mulberry32) so sweeps are reproducible ──────────────────────────
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Simulate one position's net PnL over a GBM price path.
 * @returns {{ net:number, exit:"oor_down"|"max_hold", hours:number, inRangeHours:number }}
 */
export function simulatePosition({
  binsBelow,
  feeRate24h,
  sigmaDaily,
  muDaily = 0,
  binStep = 100,
  amountSol = AMOUNT_SOL,
  rand = Math.random,
}) {
  const lnStep = Math.log(1 + binStep / 10000);   // price → bin-offset scale
  const sigmaH = sigmaDaily / Math.sqrt(24);
  const muH = muDaily / 24;
  let offset = 0;            // price position in bins vs entry (0 = entry, negative = below)
  let inRangeHours = 0;
  const hourlyFee = amountSol * (feeRate24h / 100 / 24);

  for (let h = 1; h <= MAX_HOLD_H; h++) {
    offset += ((muH - (sigmaH * sigmaH) / 2) + sigmaH * gauss(rand)) / lnStep;
    if (offset <= 0 && offset >= -binsBelow) inRangeHours++;   // in the fee-earning band
    if (offset < -binsBelow) {
      const exitBin = Math.round(offset);
      const costs = simulatedExitCosts(
        { amount_sol: amountSol, entry_bin: 0, bins_below: binsBelow, entry_bin_step: binStep },
        `oor_down:bin=${exitBin}`,
      );
      return { net: hourlyFee * inRangeHours - costs.total, exit: "oor_down", hours: h, inRangeHours };
    }
  }
  // Max hold without a downward exit — SOL intact (no IL), tx cost only.
  const costs = simulatedExitCosts(
    { amount_sol: amountSol, entry_bin: 0, bins_below: binsBelow, entry_bin_step: binStep },
    "max_hold_exceeded",
  );
  return { net: hourlyFee * inRangeHours - costs.total, exit: "max_hold", hours: MAX_HOLD_H, inRangeHours };
}

/** Sweep bins_below for one pool scenario; print a table and the optimum. */
export function sweepScenario(name, scenario, binsBelowGrid, paths = 4000) {
  const { feeRate24h, sigmaDaily, muDaily = 0, binStep = 100 } = scenario;
  let best = null;
  const rows = [];
  for (const bb of binsBelowGrid) {
    const rand = makeRng(0x9E3779B9 ^ (bb * 2654435761));
    let sumNet = 0, wins = 0, downs = 0, sumH = 0;
    for (let i = 0; i < paths; i++) {
      const r = simulatePosition({ binsBelow: bb, feeRate24h, sigmaDaily, muDaily, binStep, rand });
      sumNet += r.net; if (r.net > 0) wins++; if (r.exit === "oor_down") downs++; sumH += r.hours;
    }
    const mean = sumNet / paths;
    const ev = projectDeployEV({ amount_sol: AMOUNT_SOL, fee_rate_24h: feeRate24h, bins_below: bb, bin_step: binStep, maxBreakEvenHours: GATE_CAP_H });
    rows.push({ bb, mean, win: 100 * wins / paths, down: 100 * downs / paths, avgH: sumH / paths, gate: ev.pass });
    if (!best || mean > best.mean) best = { bb, mean };
  }
  return { name, scenario, rows, best };
}

function printScenario(res) {
  const { name, scenario, rows, best } = res;
  console.log(`\n=== ${name}  (fee ${scenario.feeRate24h}%/24h, σ ${(scenario.sigmaDaily * 100).toFixed(0)}%/day, μ ${(scenario.muDaily * 100 || 0).toFixed(0)}%/day) ===`);
  console.log("bins_below | gate  | mean net SOL | win% | oor_down% | avg hold h");
  for (const r of rows) {
    console.log(
      String(r.bb).padStart(9) + " | " +
      (r.gate ? "PASS " : "block") + " | " +
      (r.mean >= 0 ? "+" : "") + r.mean.toFixed(4).padStart(8) + "     | " +
      r.win.toFixed(0).padStart(3) + "%  | " +
      r.down.toFixed(0).padStart(3) + "%      | " +
      r.avgH.toFixed(0).padStart(3),
    );
  }
  const verdict = best.mean > 0 ? `optimal bins_below = ${best.bb}` : `ALL settings net-negative → avoid this pool type`;
  console.log(`  → ${verdict} (best mean net ${best.mean >= 0 ? "+" : ""}${best.mean.toFixed(4)} SOL)`);
}

// ── Run when invoked directly ───────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("autotune.mjs");
if (isMain) {
  const GRID = [6, 8, 10, 12, 15, 20, 30, 50, 69];
  console.log("Auto-tune sweep — realistic net PnL per bins_below (1 SOL, gate cap 72h, 4000 paths/setting)");
  printScenario(sweepScenario("MEME high-vol",  { feeRate24h: 10, sigmaDaily: 1.2, muDaily: -0.05, binStep: 100 }, GRID));
  printScenario(sweepScenario("MEME extreme",   { feeRate24h: 15, sigmaDaily: 2.4, muDaily: -0.10, binStep: 100 }, GRID));
  printScenario(sweepScenario("STABLE low-vol", { feeRate24h: 2,  sigmaDaily: 0.30, muDaily: 0,    binStep: 100 }, GRID));
  printScenario(sweepScenario("STABLE good-fee",{ feeRate24h: 4,  sigmaDaily: 0.40, muDaily: 0,    binStep: 100 }, GRID));
  console.log("\nNote: GBM model. 'gate' = would the IL gate (72h break-even cap) deploy this setting.");
}
