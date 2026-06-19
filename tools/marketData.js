import { log } from "../logger.js";

const BIRDEYE_BASE = "https://public-api.birdeye.so";
const DEXSCREENER_BASE = "https://api.dexscreener.com";

function getBirdeyeKey() {
  return process.env.BIRDEYE_API_KEY || null;
}

function getDexScreenerKey() {
  return process.env.DEXSCREENER_API_KEY || null;
}

async function fetchBirdeyeData(mint) {
  const key = getBirdeyeKey();
  if (!key) return null;

  try {
    const headers = { "X-API-KEY": key, "x-chain": "solana" };
    const [overviewRes, holdersRes] = await Promise.all([
      fetch(`${BIRDEYE_BASE}/defi/token_overview?address=${mint}`, { headers }),
      fetch(`${BIRDEYE_BASE}/v1/token/holder?address=${mint}&offset=0&limit=10`, { headers }),
    ]);

    const overview = overviewRes.ok ? await overviewRes.json() : null;
    const holdersData = holdersRes.ok ? await holdersRes.json() : null;

    const d = overview?.data;
    if (!d) return null;

    const top10Pct = holdersData?.data?.items?.slice(0, 10)
      .reduce((sum, h) => sum + (h.ui_amount / (d.supply || 1)) * 100, 0) ?? null;

    const price1hChange = d.priceChange1hPercent ?? null;
    const price4hChange = d.priceChange4hPercent ?? null;
    const volume24h = d.v24hUSD ?? null;

    return {
      volume_24h_usd: volume24h != null ? parseFloat(volume24h.toFixed(2)) : null,
      price_change_1h_pct: price1hChange != null ? parseFloat(price1hChange.toFixed(3)) : null,
      price_change_4h_pct: price4hChange != null ? parseFloat(price4hChange.toFixed(3)) : null,
      top10_holders_pct: top10Pct != null ? parseFloat(top10Pct.toFixed(2)) : null,
    };
  } catch (e) {
    log("market_warn", `Birdeye fetch failed for ${mint}: ${e.message}`);
    return null;
  }
}

async function fetchDexScreenerData(poolAddress) {
  try {
    const res = await fetch(`${DEXSCREENER_BASE}/latest/dex/pairs/solana/${poolAddress}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data?.pairs?.[0] ?? null;
    if (!pair) return null;

    const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : null;
    const ageHours = createdAt ? (Date.now() - createdAt.getTime()) / 3_600_000 : null;

    return {
      token_age_hours: ageHours != null ? parseFloat(ageHours.toFixed(1)) : null,
      is_trending: pair.boosts?.active != null ? pair.boosts.active > 0 : null,
      socials_count: pair.info?.socials?.length ?? 0,
    };
  } catch (e) {
    log("market_warn", `DexScreener fetch failed for ${poolAddress}: ${e.message}`);
    return null;
  }
}

/**
 * Tool: get_token_market_data
 * Fetches combined market intelligence from Birdeye and DexScreener.
 * Called by SCREENER before deploying to enrich context.
 * API keys are optional — missing keys return null for that source's fields.
 */
export async function getTokenMarketData({ pool_address, mint }) {
  if (!pool_address && !mint) throw new Error("pool_address or mint is required");

  const [birdeye, dexscreener] = await Promise.all([
    mint ? fetchBirdeyeData(mint) : Promise.resolve(null),
    pool_address ? fetchDexScreenerData(pool_address) : Promise.resolve(null),
  ]);

  return {
    pool_address: pool_address ?? null,
    mint: mint ?? null,
    // Birdeye
    volume_24h_usd: birdeye?.volume_24h_usd ?? null,
    price_change_1h_pct: birdeye?.price_change_1h_pct ?? null,
    price_change_4h_pct: birdeye?.price_change_4h_pct ?? null,
    top10_holders_pct: birdeye?.top10_holders_pct ?? null,
    // DexScreener
    token_age_hours: dexscreener?.token_age_hours ?? null,
    is_trending: dexscreener?.is_trending ?? null,
    socials_count: dexscreener?.socials_count ?? 0,
    // Source availability
    birdeye_available: birdeye != null,
    dexscreener_available: dexscreener != null,
  };
}
