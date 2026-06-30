/**
 * Historical backtest (v2) — prove/disprove profitability against REAL price history,
 * fixing v1's three optimistic biases (see scripts/backtest_historical.mjs:12-14).
 *
 * v1 weaknesses → v2 fixes:
 *   1. Tiny biased universe (only pools the bot already deployed)
 *        → discoverPools() over both screening slots = the live universe the bot WOULD screen.
 *   2. Single entry point per pool
 *        → sample an entry every ENTRY_STRIDE_H hours across each pool's history (a distribution).
 *   3. Constant fee, no decay
 *        → fees accrue proportional to REAL per-hour OHLCV volume; entry fee rate scales by the
 *          pool's 24h volume at that entry vs now, so a volume collapse stops earning (realistic).
 *
 * Reuses v1's proven core: bin-offset replay, simulatedExitCosts + projectDeployEV (the validated
 * net-PnL cost model + IL gate). Standalone, offline — never touches live trading, no DB writes.
 *
 * Known simplifications (note when reading results):
 *   - Range = config.strategy.defaultBinsBelow for every entry (the canonical wide range the live
 *     IL-gate preview uses). The live bot lets the LLM vary bins_below; we hold it fixed so the
 *     backtest is deterministic and reproducible. bins_above = 0 (single-sided, as always).
 *   - Fill ≈ pool price (no MEV/sandwich modeling) — same optimistic bias v1 carries.
 *
 * Run: node scripts/backtest_historical_v2.mjs
 */
import { simulatedExitCosts, projectDeployEV, DEFAULT_MAX_BREAK_EVEN_HOURS } from "../services/paperTrading.js";
import { discoverPools } from "../tools/screening.js";
import { config } from "../config.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// Persistent accumulator: each run upserts entries keyed by `poolAddr:entryTs`, so re-running
// on different DAYS accumulates new pools (rotating universe) and new entry-hours (extending
// history) toward the ≥20-pool / ≥100-position significance bar — without double-counting.
const STORE_PATH = "data/backtest_v2_store.json";
const loadStore = () => { try { return JSON.parse(readFileSync(STORE_PATH, "utf8")); } catch { return {}; } };
const saveStore = (s) => { mkdirSync(dirname(STORE_PATH), { recursive: true }); writeFileSync(STORE_PATH, JSON.stringify(s, null, 0)); };

const MAX_HOLD_H = 168;          // forward window per entry (7 days)
const ENTRY_STRIDE_H = 24;       // sample a fresh entry every 24h of history
const HIST_LIMIT = 1000;         // hourly candles per pool (~41 days) in ONE request
const AMOUNT_SOL = 1.0;
const GECKO = "https://api.geckoterminal.com/api/v2/networks/solana/pools";
const GATE_CAP = config.management?.maxBreakEvenHours ?? DEFAULT_MAX_BREAK_EVEN_HOURS;
const BINS_BELOW = config.strategy.defaultBinsBelow;
const FEE_SCALE_CAP = 3;         // a single volume-spike day can't inflate entry fee >3x

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch hourly candles (most recent HIST_LIMIT), retry/backoff on 429. Returns [[ts,o,h,l,c,v],...]. */
async function fetchOhlcv(pool, limit = HIST_LIMIT) {
  const url = `${GECKO}/${pool}/ohlcv/hour?aggregate=1&limit=${limit}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (r.ok) { const j = await r.json(); return j?.data?.attributes?.ohlcv_list ?? []; }
    if (r.status === 429) { await sleep(12000 * (attempt + 1)); continue; } // backoff on rate limit
    throw new Error(`HTTP ${r.status}`);
  }
  throw new Error("HTTP 429 (gave up after retries)");
}

/** Sum of volume (index 5) over the 24 candles ending at index `end` (inclusive). */
function trailing24hVolume(asc, end) {
  let sum = 0;
  for (let i = Math.max(0, end - 23); i <= end; i++) sum += Number(asc[i]?.[5]) || 0;
  return sum;
}

/**
 * Replay ONE entry over the real forward price path with volume-weighted, capped fee accrual.
 * asc: full ascending candle array. startIdx: entry hour.
 *   feeRate24hNow / vol24hNow — the pool's matched "now" anchors. Per-hour fee = baseline hourly
 *   fee (AMOUNT×feeRate24hNow/100/24) × clamp(hourVolume/avgHourlyVolNow, 0, FEE_SCALE_CAP). Models
 *   volume decay while staying bounded (a fixed position can't capture unbounded fees as volume 100×'s).
 */
function replayEntry(asc, startIdx, { binStep, feeRate24hNow, vol24hNow }) {
  const entryPrice = asc[startIdx]?.[4];
  if (!(entryPrice > 0) || !(vol24hNow > 0)) return null;
  const r = 1 + (binStep || 100) / 10000;
  const lnStep = Math.log(r);
  // Baseline hourly fee = v1's constant rate. Each in-range hour scales it by how its REAL volume
  // compares to the recent average hour, CLAMPED to ≤FEE_SCALE_CAP. This models decay (quiet hour →
  // less fee) and modest spikes WITHOUT blowing up: a fixed position can't capture unbounded fees as
  // volume 100×'s (its liquidity share shrinks — we don't model that, so we cap instead).
  const baselineHourlyFee = AMOUNT_SOL * (feeRate24hNow / 100 / 24);
  const avgHourlyVolNow = vol24hNow / 24;

  // Entry-time 24h fee rate the bot WOULD have seen (drives the IL gate only): the pool's current
  // rate scaled by how active it was at this entry vs now. vol24hEntry uses the trailing window.
  const vol24hEntry = trailing24hVolume(asc, startIdx);
  const scale = Math.min(FEE_SCALE_CAP, Math.max(0, vol24hEntry / vol24hNow));
  const feeRate24hEntry = feeRate24hNow * scale;

  let feeSol = 0;
  let inRangeHours = 0;
  const lastIdx = Math.min(asc.length - 1, startIdx + MAX_HOLD_H);
  for (let i = startIdx + 1; i <= lastIdx; i++) {
    const price = asc[i]?.[4];
    if (!(price > 0)) continue;
    const offset = Math.log(price / entryPrice) / lnStep; // bins vs entry (neg = below)
    if (offset <= 0 && offset >= -BINS_BELOW) {
      inRangeHours++;
      const volRatio = avgHourlyVolNow > 0
        ? Math.min(FEE_SCALE_CAP, Math.max(0, (Number(asc[i]?.[5]) || 0) / avgHourlyVolNow))
        : 0;
      feeSol += baselineHourlyFee * volRatio;
    }
    if (offset < -BINS_BELOW) {
      const exitBin = Math.round(offset);
      const costs = simulatedExitCosts(
        { amount_sol: AMOUNT_SOL, entry_bin: 0, bins_below: BINS_BELOW, entry_bin_step: binStep },
        `oor_down:bin=${exitBin}`,
      );
      return { feeRate24hEntry, net: feeSol - costs.total, exit: "oor_down", hours: i - startIdx, inRangeHours };
    }
  }
  // max_hold: charge IL for where the price actually ENDED. A single-sided position that drifted
  // below entry but never pierced the range bottom is still partially converted to token = real
  // unrealized IL. Booking it (via the same conversion formula at the final offset) closes the gap
  // where widening the range hides IL by turning oor_down exits into IL-free max_hold exits.
  const finalPrice = asc[lastIdx]?.[4];
  const finalOffset = finalPrice > 0 ? Math.log(finalPrice / entryPrice) / lnStep : 0;
  const reason = finalOffset < 0 ? `oor_down:bin=${Math.round(finalOffset)}` : "max_hold_exceeded";
  const costs = simulatedExitCosts(
    { amount_sol: AMOUNT_SOL, entry_bin: 0, bins_below: BINS_BELOW, entry_bin_step: binStep },
    reason,
  );
  return { feeRate24hEntry, net: feeSol - costs.total, exit: finalOffset < 0 ? "max_hold_down" : "max_hold", hours: lastIdx - startIdx, inRangeHours };
}

/** Build the candidate universe: both screening slots, deduped, each tagged with its 24h fee rate. */
async function buildUniverse() {
  const hybrid = config.hybridScreening;
  const slots = hybrid?.stable && hybrid?.meme
    ? [{ type: "stable", o: hybrid.stable }, { type: "meme", o: hybrid.meme }]
    : [{ type: "single", o: null }];

  const byPool = new Map();
  for (const slot of slots) {
    const tfMin = parseInt(slot.o?.timeframe ?? config.screening.timeframe) || 5;
    let res;
    try {
      res = await discoverPools({ page_size: 50, screeningOverrides: slot.o });
    } catch (e) {
      console.log(`  discover ${slot.type} failed: ${e.message}`);
      continue;
    }
    for (const p of res.pools || []) {
      if (!p.pool || byPool.has(p.pool)) continue;
      const feeRate24h = p.fee_active_tvl_ratio != null ? Number(p.fee_active_tvl_ratio) * (1440 / tfMin) : null;
      if (feeRate24h == null || !(feeRate24h > 0)) continue;
      byPool.set(p.pool, {
        pool: p.pool, name: p.name, bin_step: p.bin_step ?? 100, slot: slot.type, feeRate24h,
      });
    }
    await sleep(5000);
  }
  return [...byPool.values()];
}

const agg = (rows) => {
  const w = rows.filter((r) => r.net > 0).length;
  const s = rows.reduce((a, r) => a + r.net, 0);
  const down = rows.filter((r) => r.exit === "oor_down").length;
  const hold = rows.length ? rows.reduce((a, r) => a + r.hours, 0) / rows.length : 0;
  return {
    n: rows.length,
    wr: rows.length ? (100 * w / rows.length).toFixed(0) : "0",
    w, sum: s, avg: rows.length ? s / rows.length : 0,
    oorDownPct: rows.length ? (100 * down / rows.length).toFixed(0) : "0",
    avgHold: hold.toFixed(0),
  };
};

(async () => {
  console.log(`Backtest v2 — building universe (both screening slots)…`);
  const universe = await buildUniverse();
  console.log(`Universe: ${universe.length} distinct pools. Range=${BINS_BELOW} bins_below, gate cap ${GATE_CAP}h.\n`);
  console.log("pool                 | slot   | fee24h% | entries | gatePass | net SOL (gate)");

  const results = [];
  const gated = [];
  let fetchErr = 0;
  let pools = 0;

  for (const u of universe) {
    await sleep(5000); // GeckoTerminal free tier — conservative spacing
    let candles;
    try { candles = await fetchOhlcv(u.pool); }
    catch (e) { fetchErr++; console.log(`${(u.name || "?").slice(0, 20).padEnd(20)} | fetch err: ${e.message}`); continue; }
    if (!candles || candles.length < ENTRY_STRIDE_H + 2) { fetchErr++; continue; }

    const asc = candles.slice().sort((a, b) => a[0] - b[0]);
    const vol24hNow = trailing24hVolume(asc, asc.length - 1);
    if (!(vol24hNow > 0)) { fetchErr++; continue; }
    pools++;

    let poolEntries = 0;
    let poolGatePass = 0;
    let poolGateNet = 0;
    // Sample entries; need at least a small forward window to be meaningful.
    const lastEntry = asc.length - 1 - ENTRY_STRIDE_H;
    for (let t = 0; t <= lastEntry; t += ENTRY_STRIDE_H) {
      const res = replayEntry(asc, t, { binStep: u.bin_step, feeRate24hNow: u.feeRate24h, vol24hNow });
      if (!res || res.net == null) continue;
      const row = { poolAddr: u.pool, pool: u.name, slot: u.slot, feeRate24h: u.feeRate24h, entryTs: asc[t][0], ...res };
      const ev = projectDeployEV({
        amount_sol: AMOUNT_SOL,
        fee_rate_24h: res.feeRate24hEntry,
        bins_below: BINS_BELOW,
        bin_step: u.bin_step,
        maxBreakEvenHours: GATE_CAP,
      });
      row.gate = ev.pass;
      results.push(row);
      poolEntries++;
      if (ev.pass) { gated.push(row); poolGatePass++; poolGateNet += res.net; }
    }
    console.log(
      `${(u.name || "?").slice(0, 20).padEnd(20)} | ${u.slot.padEnd(6)} | ${u.feeRate24h.toFixed(1).padStart(6)} | ${String(poolEntries).padStart(7)} | ${String(poolGatePass).padStart(8)} | ${(poolGateNet >= 0 ? "+" : "")}${poolGateNet.toFixed(4)}`,
    );
  }

  // ── This-run summary ──
  const all = agg(results);
  const g = agg(gated);
  console.log(`\n── THIS RUN ── (pools fetched: ${pools}, fetch errors: ${fetchErr})`);
  console.log(`ALL replayed   : n=${all.n} | win ${all.wr}% | total ${all.sum >= 0 ? "+" : ""}${all.sum.toFixed(4)} SOL`);
  console.log(`GATE-PASS only : n=${g.n} across ${new Set(gated.map((r) => r.poolAddr)).size} pools | win ${g.wr}% | total ${g.sum >= 0 ? "+" : ""}${g.sum.toFixed(4)} SOL`);

  // ── Upsert into persistent store (idempotent by poolAddr:entryTs) ──
  const store = loadStore();
  const runDate = new Date().toISOString().slice(0, 10);
  let added = 0;
  for (const r of results) {
    const key = `${r.poolAddr}:${r.entryTs}`;
    if (!(key in store)) added++;
    store[key] = { ...r, runDate: store[key]?.runDate ?? runDate };
  }
  saveStore(store);

  // ── Accumulated verdict over the FULL store ──
  const allRows = Object.values(store);
  const gatedRows = allRows.filter((r) => r.gate);
  const A = agg(allRows);
  const G = agg(gatedRows);
  const distinctAll = new Set(allRows.map((r) => r.poolAddr)).size;
  const distinctGated = new Set(gatedRows.map((r) => r.poolAddr)).size;

  // Drop-top-pool robustness: is gate-pass still +EV without its single best-contributing pool?
  const byPoolNet = {};
  for (const r of gatedRows) byPoolNet[r.poolAddr] = (byPoolNet[r.poolAddr] || 0) + r.net;
  const topPool = Object.entries(byPoolNet).sort((a, b) => b[1] - a[1])[0];
  const topPoolName = topPool ? (gatedRows.find((r) => r.poolAddr === topPool[0])?.pool ?? topPool[0].slice(0, 8)) : "n/a";
  const exTop = gatedRows.filter((r) => r.poolAddr !== (topPool?.[0]));
  const exTopNet = exTop.reduce((a, r) => a + r.net, 0);

  console.log(`\n══ ACCUMULATED (store: ${STORE_PATH}, +${added} new this run) ══`);
  console.log(`ALL replayed   : n=${A.n} across ${distinctAll} pools | win ${A.wr}% | total ${A.sum >= 0 ? "+" : ""}${A.sum.toFixed(4)} SOL | avg ${A.avg >= 0 ? "+" : ""}${A.avg.toFixed(4)} | oor_down ${A.oorDownPct}% | avg hold ${A.avgHold}h`);
  console.log(`GATE-PASS only : n=${G.n} across ${distinctGated} pools | win ${G.wr}% (${G.w}/${G.n}) | total ${G.sum >= 0 ? "+" : ""}${G.sum.toFixed(4)} SOL | avg ${G.avg >= 0 ? "+" : ""}${G.avg.toFixed(4)} | oor_down ${G.oorDownPct}% | avg hold ${G.avgHold}h`);
  console.log(`  ROBUSTNESS — drop top pool (${topPoolName}, ${topPool ? (topPool[1] >= 0 ? "+" : "") + topPool[1].toFixed(4) : "n/a"} SOL): gate-pass net ${exTopNet >= 0 ? "+" : ""}${exTopNet.toFixed(4)} SOL across ${exTop.length} pos / ${distinctGated - 1} pools`);

  const profile = (rows) => {
    if (!rows.length) return "n/a";
    const fee = rows.reduce((a, r) => a + r.feeRate24h, 0) / rows.length;
    const hold = rows.reduce((a, r) => a + r.inRangeHours, 0) / rows.length;
    return `avg fee24h ${fee.toFixed(1)}% | avg in-range ${hold.toFixed(0)}h`;
  };
  console.log(`  gate winners (${gatedRows.filter((r) => r.net > 0).length}): ${profile(gatedRows.filter((r) => r.net > 0))}`);
  console.log(`  gate losers  (${gatedRows.filter((r) => r.net <= 0).length}): ${profile(gatedRows.filter((r) => r.net <= 0))}`);

  const barMet = distinctGated >= 20 && G.n >= 100;
  console.log(`\nSuccess bar (design doc): ≥20 distinct gated pools, ≥100 positions → ${distinctGated} pools / ${G.n} positions ${barMet ? "✓ MET" : "✗ not yet — re-run on more days to accumulate"}.`);
  console.log(`VERDICT is only trustworthy once the bar is met AND drop-top-pool stays +EV. NOTE: no MEV/sandwich, fill ≈ pool price.`);
})();
