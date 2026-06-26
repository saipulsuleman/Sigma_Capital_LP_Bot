/**
 * Pool availability probe — how many pools right now actually meet the validated +EV recipe
 * (high enough fee to clear the IL gate at a wide range). Runs live screening for both slots,
 * computes each candidate's 24h-normalized fee, and reports the IL-gate verdict.
 *
 * Run: node scripts/pool_availability.mjs
 */
import { getTopCandidates } from "../tools/screening.js";
import { projectDeployEV } from "../services/paperTrading.js";
import { config } from "../config.js";

const hybrid = config.hybridScreening;
const slots = hybrid?.stable && hybrid?.meme
  ? [
      { name: "stable", ov: hybrid.stable, tf: parseInt(hybrid.stable.timeframe) || 30 },
      { name: "meme",   ov: hybrid.meme,   tf: parseInt(hybrid.meme.timeframe) || 5 },
    ]
  : [{ name: "default", ov: null, tf: parseInt(config.screening.timeframe) || 5 }];

const bb = config.strategy.defaultBinsBelow;
const cap = config.management.maxBreakEvenHours;
let totalCands = 0, totalPass = 0, totalHighFee = 0;

for (const slot of slots) {
  let res;
  try {
    res = await getTopCandidates({ limit: 10, screeningOverrides: slot.ov });
  } catch (e) {
    console.log(`\n=== ${slot.name} slot — screening failed: ${e.message} ===`);
    continue;
  }
  const cands = res?.candidates || res?.pools || [];
  console.log(`\n=== ${slot.name} slot (${slot.tf}m) — ${cands.length} candidates pass screening filters ===`);
  console.log(`pool                 | fee_24h | vol    | gate  | break-even`);
  for (const c of cands) {
    const raw = c.fee_active_tvl_ratio ?? c.fee_tvl_ratio;
    const fee24h = raw != null ? Number(raw) * (1440 / slot.tf) : null;
    const ev = projectDeployEV({ amount_sol: 1, fee_rate_24h: fee24h, bins_below: bb, bin_step: c.bin_step ?? 100, maxBreakEvenHours: cap });
    totalCands++;
    if (ev.pass) totalPass++;
    if ((fee24h ?? 0) >= 10) totalHighFee++;
    const be = Number.isFinite(ev.break_even_hours) ? ev.break_even_hours.toFixed(0) + "h" : "inf";
    console.log(
      `${String(c.name || c.pool || "?").slice(0, 20).padEnd(20)} | ${(fee24h != null ? fee24h.toFixed(1) : "?").padStart(6)}% | ${String(c.volatility ?? "?").padStart(6)} | ${(ev.pass ? "PASS " : "block")} | ${be}`,
    );
  }
}

console.log(`\n── SUMMARY ──`);
console.log(`Candidates passing screening filters : ${totalCands}`);
console.log(`...that also PASS the IL gate (+EV)   : ${totalPass}  (${totalCands ? ((100 * totalPass) / totalCands).toFixed(0) : 0}%)`);
console.log(`...with fee >= 10%/24h (ideal recipe) : ${totalHighFee}`);
console.log(`Gate cap: ${cap}h break-even | default bins_below: ${bb}`);
