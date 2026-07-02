/**
 * Historical backtest (v1) — prove/disprove profitability against REAL price history.
 *
 * For each pool the bot actually screened/deployed (real fee rate + bin_step from the DB),
 * fetch the REAL hourly price path from GeckoTerminal (free, no key), replay the single-sided
 * strategy to find the REAL exit (oor_down when price falls below the range, else 168h
 * max-hold), and compute NET PnL with the validated cost model (simulatedExitCosts).
 *
 * This is more rigorous than paper trading: paper uses the bot's current-bin checks; this
 * uses the actual historical price movement to determine the real exit bin and timing.
 *
 * Known simplification (optimistic bias, note when reading results): fee rate is held at the
 * entry snapshot (entry_fee_rate_24h), so fee decay isn't modeled. v2 should derive a
 * time-varying fee from OHLCV volume.
 *
 * Run: node scripts/backtest_historical.mjs
 */
import { openDb } from "../db/db.js";
import { simulatedExitCosts, projectDeployEV } from "../services/paperTrading.js";
import { config } from "../config.js";

const MAX_HOLD_H = 168;
const AMOUNT_SOL = 1.0;
const GECKO = "https://api.geckoterminal.com/api/v2/networks/solana/pools";
const GATE_CAP = config.management?.maxBreakEvenHours ?? 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch hourly candles ending at `beforeTs`, with retry/backoff on 429. Returns [[ts,o,h,l,c,v],...]. */
async function fetchOhlcv(pool, beforeTs, limit = MAX_HOLD_H + 2) {
  const url = `${GECKO}/${pool}/ohlcv/hour?aggregate=1&limit=${limit}` + (beforeTs ? `&before_timestamp=${beforeTs}` : "");
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (r.ok) { const j = await r.json(); return j?.data?.attributes?.ohlcv_list ?? []; }
    if (r.status === 429) { await sleep(12000 * (attempt + 1)); continue; } // backoff on rate limit
    throw new Error(`HTTP ${r.status}`);
  }
  throw new Error("HTTP 429 (gave up after retries)");
}

/** Replay one position over a real price path. candles: ascending by time, from entry forward. */
function replay(candles, { binsBelow, binStep, feeRate24h }) {
  if (candles.length < 2) return null;
  const r = 1 + (binStep || 100) / 10000;
  const lnStep = Math.log(r);
  const entryPrice = candles[0][4]; // close of entry hour
  if (!(entryPrice > 0)) return null;
  const hourlyFee = AMOUNT_SOL * (feeRate24h / 100 / 24);
  let inRangeHours = 0;

  for (let i = 1; i < candles.length && i <= MAX_HOLD_H; i++) {
    const price = candles[i][4];
    if (!(price > 0)) continue;
    const offset = Math.log(price / entryPrice) / lnStep; // bins relative to entry (neg = below)
    if (offset <= 0 && offset >= -binsBelow) inRangeHours++;
    if (offset < -binsBelow) {
      const exitBin = Math.round(offset);
      const costs = simulatedExitCosts({ amount_sol: AMOUNT_SOL, entry_bin: 0, bins_below: binsBelow, entry_bin_step: binStep }, `oor_down:bin=${exitBin}`);
      return { net: hourlyFee * inRangeHours - costs.total, exit: "oor_down", hours: i, inRangeHours };
    }
  }
  // max_hold: charge IL for where the price actually ENDED. A position that drifted below entry
  // but never pierced the range bottom is still partially converted to token = real unrealized IL.
  // Book it via the conversion formula at the final offset (matches v2 / range sweep); an
  // at/above-entry hold keeps SOL intact (no IL).
  const lastIdx = Math.min(candles.length - 1, MAX_HOLD_H);
  const finalPrice = candles[lastIdx]?.[4];
  const finalOffset = finalPrice > 0 ? Math.log(finalPrice / entryPrice) / lnStep : 0;
  const reason = finalOffset < 0 ? `oor_down:bin=${Math.round(finalOffset)}` : "max_hold_exceeded";
  const costs = simulatedExitCosts({ amount_sol: AMOUNT_SOL, entry_bin: 0, bins_below: binsBelow, entry_bin_step: binStep }, reason);
  return { net: hourlyFee * inRangeHours - costs.total, exit: finalOffset < 0 ? "max_hold_down" : "max_hold", hours: lastIdx, inRangeHours };
}

const db = openDb("db/sigma.db");
// Real pools the bot screened/deployed, with a usable fee rate and bins.
const pools = db.prepare(`
  SELECT pool_name, pool_address,
         COALESCE(entry_bin_step, 100) AS bin_step,
         entry_fee_rate_24h AS fee, bins_below, entry_time
  FROM paper_positions
  WHERE entry_fee_rate_24h IS NOT NULL AND entry_fee_rate_24h > 0
    AND bins_below > 0 AND pool_address IS NOT NULL
  GROUP BY pool_address
`).all();

console.log(`Backtest v1 — ${pools.length} real pools, REAL GeckoTerminal price paths, validated cost model.\n`);
console.log("pool                 | fee%   | bb | gate  | exit       | hold | NET SOL");

let n = 0, wins = 0, sumNet = 0, fetchErr = 0;
const results = [];
for (const p of pools) {
  await sleep(5000); // GeckoTerminal free tier — conservative spacing
  // entry hour: use the bot's actual entry_time; fetch the window covering entry → +168h
  const entryTs = p.entry_time ? Math.floor(new Date(p.entry_time).getTime() / 1000) : null;
  const beforeTs = entryTs ? entryTs + (MAX_HOLD_H + 1) * 3600 : null;
  let candles;
  try {
    candles = await fetchOhlcv(p.pool_address, beforeTs);
  } catch (e) { fetchErr++; console.log(`${(p.pool_name||"?").slice(0,20).padEnd(20)} | fetch err: ${e.message}`); continue; }
  if (!candles.length) { fetchErr++; continue; }
  // candles are newest-first; keep those >= entryTs, then ascending
  let asc = candles.slice().sort((a, b) => a[0] - b[0]);
  if (entryTs) asc = asc.filter((c) => c[0] >= entryTs - 3600);
  const res = replay(asc, { binsBelow: p.bins_below, binStep: p.bin_step, feeRate24h: p.fee });
  if (!res) continue;
  const ev = projectDeployEV({ amount_sol: AMOUNT_SOL, fee_rate_24h: p.fee, bins_below: p.bins_below, bin_step: p.bin_step, maxBreakEvenHours: GATE_CAP });
  n++; sumNet += res.net; if (res.net > 0) wins++;
  results.push({ ...p, ...res, gate: ev.pass });
  console.log(`${(p.pool_name||"?").slice(0,20).padEnd(20)} | ${p.fee.toFixed(1).padStart(5)} | ${String(p.bins_below).padStart(2)} | ${(ev.pass?"PASS ":"block")} | ${res.exit.padEnd(10)} | ${String(res.hours).padStart(3)}h | ${(res.net>=0?"+":"")}${res.net.toFixed(4)}`);
}

const agg = (rows) => {
  const w = rows.filter(r=>r.net>0).length, s = rows.reduce((a,r)=>a+r.net,0);
  return { n: rows.length, wr: rows.length?(100*w/rows.length).toFixed(0):0, w, sum: s, avg: rows.length?s/rows.length:0 };
};
const all = agg(results);
const gated = agg(results.filter(r=>r.gate)); // only pools the CURRENT bot would actually deploy

console.log(`\n── VERDICT ── (fetch errors: ${fetchErr})`);
console.log(`ALL replayed         : n=${all.n} | win-rate ${all.wr}% (${all.w}/${all.n}) | total ${all.sum>=0?"+":""}${all.sum.toFixed(4)} SOL | avg ${all.avg>=0?"+":""}${all.avg.toFixed(4)}`);
console.log(`GATE-PASS only (real): n=${gated.n} | win-rate ${gated.wr}% (${gated.w}/${gated.n}) | total ${gated.sum>=0?"+":""}${gated.sum.toFixed(4)} SOL | avg ${gated.avg>=0?"+":""}${gated.avg.toFixed(4)}`);
console.log(`\nGATE-PASS = pools the current bot (fee gate, ${GATE_CAP}h break-even) would actually deploy.`);
console.log(`NOTE: fee held at entry snapshot (no decay) = optimistic. Small sample (bot's real pools).`);
