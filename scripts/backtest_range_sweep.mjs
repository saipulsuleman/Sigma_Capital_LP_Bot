/**
 * Range sweep — narrow vs wide bins_below, A/B on the SAME real data.
 *
 * Tests the v2 backtest's key finding (survival/range-width, not fee, separates winners from
 * losers) by replaying every entry at several bins_below values on one OHLCV fetch per pool.
 * Narrower range → exits oor_down sooner (fewer fee-hours) BUT far smaller IL per exit. This
 * measures that tradeoff directly: which range maximizes gate-pass net + win-rate, and is it
 * robust to dropping the single best pool?
 *
 * Reuses the validated cost model (simulatedExitCosts / projectDeployEV) and v2's capped fee
 * model. Read-only, no DB writes, no accumulator store.
 *
 * Run: node scripts/backtest_range_sweep.mjs
 */
import { simulatedExitCosts, projectDeployEV, DEFAULT_MAX_BREAK_EVEN_HOURS } from "../services/paperTrading.js";
import { discoverPools } from "../tools/screening.js";
import { config } from "../config.js";

const RANGES = [64, 80, 100, 120, 140];   // bins_below values to compare (wider sweep — narrow was monotonically worse)
const MAX_HOLD_H = 168;
const ENTRY_STRIDE_H = 24;
const HIST_LIMIT = 1000;
const AMOUNT_SOL = 1.0;
const GECKO = "https://api.geckoterminal.com/api/v2/networks/solana/pools";
const GATE_CAP = config.management?.maxBreakEvenHours ?? DEFAULT_MAX_BREAK_EVEN_HOURS;
const FEE_SCALE_CAP = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOhlcv(pool, limit = HIST_LIMIT) {
  const url = `${GECKO}/${pool}/ohlcv/hour?aggregate=1&limit=${limit}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (r.ok) { const j = await r.json(); return j?.data?.attributes?.ohlcv_list ?? []; }
    if (r.status === 429) { await sleep(12000 * (attempt + 1)); continue; }
    throw new Error(`HTTP ${r.status}`);
  }
  throw new Error("HTTP 429 (gave up)");
}

function trailing24hVolume(asc, end) {
  let sum = 0;
  for (let i = Math.max(0, end - 23); i <= end; i++) sum += Number(asc[i]?.[5]) || 0;
  return sum;
}

/** Replay one entry at a given binsBelow. Same capped-fee model as v2. */
function replayEntry(asc, startIdx, binsBelow, { binStep, feeRate24hNow, vol24hNow }) {
  const entryPrice = asc[startIdx]?.[4];
  if (!(entryPrice > 0) || !(vol24hNow > 0)) return null;
  const r = 1 + (binStep || 100) / 10000;
  const lnStep = Math.log(r);
  const baselineHourlyFee = AMOUNT_SOL * (feeRate24hNow / 100 / 24);
  const avgHourlyVolNow = vol24hNow / 24;
  const vol24hEntry = trailing24hVolume(asc, startIdx);
  const feeRate24hEntry = feeRate24hNow * Math.min(FEE_SCALE_CAP, Math.max(0, vol24hEntry / vol24hNow));

  let feeSol = 0, inRangeHours = 0;
  const lastIdx = Math.min(asc.length - 1, startIdx + MAX_HOLD_H);
  for (let i = startIdx + 1; i <= lastIdx; i++) {
    const price = asc[i]?.[4];
    if (!(price > 0)) continue;
    const offset = Math.log(price / entryPrice) / lnStep;
    if (offset <= 0 && offset >= -binsBelow) {
      inRangeHours++;
      const ratio = avgHourlyVolNow > 0 ? Math.min(FEE_SCALE_CAP, Math.max(0, (Number(asc[i]?.[5]) || 0) / avgHourlyVolNow)) : 0;
      feeSol += baselineHourlyFee * ratio;
    }
    if (offset < -binsBelow) {
      const costs = simulatedExitCosts({ amount_sol: AMOUNT_SOL, entry_bin: 0, bins_below: binsBelow, entry_bin_step: binStep }, `oor_down:bin=${Math.round(offset)}`);
      return { feeRate24hEntry, net: feeSol - costs.total, exit: "oor_down", hours: i - startIdx, inRangeHours };
    }
  }
  // max_hold: charge IL for where the price actually ENDED. A wide single-sided position that drifted
  // below entry but never pierced the range bottom is still partially converted to token = real
  // unrealized IL. Booking it (via the same conversion formula at the final offset) closes the gap
  // where widening the range hides IL by turning oor_down exits into IL-free max_hold exits.
  const finalPrice = asc[lastIdx]?.[4];
  const finalOffset = finalPrice > 0 ? Math.log(finalPrice / entryPrice) / lnStep : 0;
  const reason = finalOffset < 0 ? `oor_down:bin=${Math.round(finalOffset)}` : "max_hold_exceeded";
  const costs = simulatedExitCosts({ amount_sol: AMOUNT_SOL, entry_bin: 0, bins_below: binsBelow, entry_bin_step: binStep }, reason);
  return { feeRate24hEntry, net: feeSol - costs.total, exit: finalOffset < 0 ? "max_hold_down" : "max_hold", hours: lastIdx - startIdx, inRangeHours };
}

async function buildUniverse() {
  const h = config.hybridScreening;
  const slots = h?.stable && h?.meme ? [{ t: "stable", o: h.stable }, { t: "meme", o: h.meme }] : [{ t: "single", o: null }];
  const byPool = new Map();
  for (const s of slots) {
    const tfMin = parseInt(s.o?.timeframe ?? config.screening.timeframe) || 5;
    let res;
    try { res = await discoverPools({ page_size: 50, screeningOverrides: s.o }); }
    catch (e) { console.log(`  discover ${s.t} failed: ${e.message}`); continue; }
    for (const p of res.pools || []) {
      if (!p.pool || byPool.has(p.pool)) continue;
      const feeRate24h = p.fee_active_tvl_ratio != null ? Number(p.fee_active_tvl_ratio) * (1440 / tfMin) : null;
      if (!(feeRate24h > 0)) continue;
      byPool.set(p.pool, { pool: p.pool, name: p.name, bin_step: p.bin_step ?? 100, feeRate24h });
    }
    await sleep(5000);
  }
  return [...byPool.values()];
}

(async () => {
  console.log("Range sweep — narrow vs wide bins_below on the same real data…");
  const universe = await buildUniverse();
  console.log(`Universe: ${universe.length} pools. Ranges: ${RANGES.join(", ")} bins_below. Gate cap ${GATE_CAP}h.\n`);

  // gated[bb] = array of { poolAddr, net, inRangeHours }
  const gated = Object.fromEntries(RANGES.map((bb) => [bb, []]));
  let pools = 0, fetchErr = 0;

  for (const u of universe) {
    await sleep(5000);
    let candles;
    try { candles = await fetchOhlcv(u.pool); }
    catch (e) { fetchErr++; console.log(`${(u.name || "?").slice(0, 18).padEnd(18)} fetch err: ${e.message}`); continue; }
    if (!candles || candles.length < ENTRY_STRIDE_H + 2) { fetchErr++; continue; }
    const asc = candles.slice().sort((a, b) => a[0] - b[0]);
    const vol24hNow = trailing24hVolume(asc, asc.length - 1);
    if (!(vol24hNow > 0)) { fetchErr++; continue; }
    pools++;
    const lastEntry = asc.length - 1 - ENTRY_STRIDE_H;
    for (let t = 0; t <= lastEntry; t += ENTRY_STRIDE_H) {
      for (const bb of RANGES) {
        const res = replayEntry(asc, t, bb, { binStep: u.bin_step, feeRate24hNow: u.feeRate24h, vol24hNow });
        if (!res || res.net == null) continue;
        const ev = projectDeployEV({ amount_sol: AMOUNT_SOL, fee_rate_24h: res.feeRate24hEntry, bins_below: bb, bin_step: u.bin_step, maxBreakEvenHours: GATE_CAP });
        if (ev.pass) gated[bb].push({ poolAddr: u.pool, net: res.net, inRangeHours: res.inRangeHours });
      }
    }
  }

  console.log(`\nPools fetched: ${pools}, fetch errors: ${fetchErr}\n`);
  console.log("bins_below | gate n | pools | win% | net SOL    | avg net   | drop-top net | avg in-range");
  for (const bb of RANGES) {
    const rows = gated[bb];
    const n = rows.length;
    const w = rows.filter((r) => r.net > 0).length;
    const net = rows.reduce((a, r) => a + r.net, 0);
    const distinct = new Set(rows.map((r) => r.poolAddr)).size;
    const inR = n ? rows.reduce((a, r) => a + r.inRangeHours, 0) / n : 0;
    // drop-top-pool robustness
    const byPool = {};
    for (const r of rows) byPool[r.poolAddr] = (byPool[r.poolAddr] || 0) + r.net;
    const top = Object.entries(byPool).sort((a, b) => b[1] - a[1])[0];
    const exTop = top ? net - top[1] : net;
    console.log(
      `${String(bb).padStart(10)} | ${String(n).padStart(6)} | ${String(distinct).padStart(5)} | ${(n ? (100 * w / n).toFixed(0) : "0").padStart(3)}% | ${(net >= 0 ? "+" : "") + net.toFixed(4).padStart(8)} | ${(n ? net / n : 0) >= 0 ? "+" : ""}${(n ? net / n : 0).toFixed(4)} | ${(exTop >= 0 ? "+" : "") + exTop.toFixed(4).padStart(8)} | ${inR.toFixed(0)}h`,
    );
  }
  console.log(`\nReading: higher win% + positive net that SURVIVES drop-top = better range. Narrow trades fee-hours for smaller IL.`);
})();
