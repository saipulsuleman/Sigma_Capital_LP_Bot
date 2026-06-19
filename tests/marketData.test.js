/**
 * T19: Data Enrichment — getTokenMarketData (Birdeye + DexScreener)
 * All tests use mocked fetch so no real API calls are made.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ── fetch mock infrastructure ────────────────────────────────────────────────

let fetchMock = null;

const originalFetch = globalThis.fetch;

function setupFetch(mockFn) {
  globalThis.fetch = mockFn;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// ── helper: make a minimal Birdeye overview response ─────────────────────────

function makeBirdeyeOverviewRes({ priceChange1h = 2.5, priceChange4h = -1.2, v24h = 150000 } = {}) {
  return {
    ok: true,
    json: async () => ({
      data: {
        priceChange1hPercent: priceChange1h,
        priceChange4hPercent: priceChange4h,
        v24hUSD: v24h,
        supply: 1_000_000,
      }
    })
  };
}

function makeBirdeyeHoldersRes(holderAmounts = [100000, 80000, 50000]) {
  return {
    ok: true,
    json: async () => ({
      data: {
        items: holderAmounts.map((ui_amount) => ({ ui_amount }))
      }
    })
  };
}

function makeDexScreenerRes({ pairCreatedAt = Date.now() - 5 * 3600000, boostsActive = 0, socialCount = 2 } = {}) {
  return {
    ok: true,
    json: async () => ({
      pairs: [{
        pairCreatedAt,
        boosts: { active: boostsActive },
        info: {
          websites: [],
          socials: Array.from({ length: socialCount }, (_, i) => ({ type: "twitter", url: `https://x.com/test${i}` }))
        }
      }]
    })
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getTokenMarketData (T19)", () => {
  afterEach(() => restoreFetch());

  test("throws when neither pool_address nor mint is provided", async () => {
    const { getTokenMarketData } = await import("../tools/marketData.js");
    await assert.rejects(() => getTokenMarketData({}), /pool_address or mint/i);
  });

  test("returns correct Birdeye fields when BIRDEYE_API_KEY is set", async () => {
    process.env.BIRDEYE_API_KEY = "test-key";
    delete process.env.DEXSCREENER_API_KEY;

    setupFetch(async (url) => {
      if (url.includes("token_overview")) return makeBirdeyeOverviewRes();
      if (url.includes("holder"))         return makeBirdeyeHoldersRes([100000, 80000]); // 18% top-2
      return { ok: false };
    });

    const { getTokenMarketData } = await import("../tools/marketData.js?v=birdeye1");
    const result = await getTokenMarketData({ mint: "mintA" });

    assert.equal(result.price_change_1h_pct, 2.5);
    assert.equal(result.price_change_4h_pct, -1.2);
    assert.equal(result.volume_24h_usd, 150000);
    assert.equal(result.birdeye_available, true);
    delete process.env.BIRDEYE_API_KEY;
  });

  test("returns correct DexScreener fields", async () => {
    delete process.env.BIRDEYE_API_KEY;

    setupFetch(async () => makeDexScreenerRes({ pairCreatedAt: Date.now() - 10 * 3600000, socialCount: 3 }));

    const { getTokenMarketData } = await import("../tools/marketData.js?v=dex1");
    const result = await getTokenMarketData({ pool_address: "poolA" });

    assert.ok(result.token_age_hours >= 9.9 && result.token_age_hours <= 10.1, "age should be ~10h");
    assert.equal(result.socials_count, 3);
    assert.equal(result.dexscreener_available, true);
    assert.equal(result.birdeye_available, false);
  });

  test("is_trending is true when boosts.active > 0", async () => {
    delete process.env.BIRDEYE_API_KEY;

    setupFetch(async () => makeDexScreenerRes({ boostsActive: 5 }));

    const { getTokenMarketData } = await import("../tools/marketData.js?v=trending1");
    const result = await getTokenMarketData({ pool_address: "poolB" });

    assert.equal(result.is_trending, true);
  });

  test("is_trending is false when boosts.active is 0", async () => {
    delete process.env.BIRDEYE_API_KEY;

    setupFetch(async () => makeDexScreenerRes({ boostsActive: 0 }));

    const { getTokenMarketData } = await import("../tools/marketData.js?v=trending0");
    const result = await getTokenMarketData({ pool_address: "poolC" });

    assert.equal(result.is_trending, false);
  });

  test("returns birdeye_available=false when BIRDEYE_API_KEY is missing", async () => {
    delete process.env.BIRDEYE_API_KEY;

    setupFetch(async () => makeDexScreenerRes());

    const { getTokenMarketData } = await import("../tools/marketData.js?v=nokey");
    const result = await getTokenMarketData({ pool_address: "poolD", mint: "mintD" });

    assert.equal(result.birdeye_available, false);
    assert.equal(result.volume_24h_usd, null);
    assert.equal(result.top10_holders_pct, null);
  });

  test("returns dexscreener_available=false when DexScreener API returns non-ok", async () => {
    delete process.env.BIRDEYE_API_KEY;
    setupFetch(async () => ({ ok: false }));

    const { getTokenMarketData } = await import("../tools/marketData.js?v=dexfail");
    const result = await getTokenMarketData({ pool_address: "poolE" });

    assert.equal(result.dexscreener_available, false);
    assert.equal(result.token_age_hours, null);
  });

  test("handles DexScreener empty pairs array gracefully", async () => {
    delete process.env.BIRDEYE_API_KEY;
    setupFetch(async () => ({ ok: true, json: async () => ({ pairs: [] }) }));

    const { getTokenMarketData } = await import("../tools/marketData.js?v=emptypairs");
    const result = await getTokenMarketData({ pool_address: "poolF" });

    assert.equal(result.dexscreener_available, false);
    assert.equal(result.token_age_hours, null);
  });

  test("handles fetch throwing (network error) without crashing", async () => {
    delete process.env.BIRDEYE_API_KEY;
    setupFetch(async () => { throw new Error("Network unreachable"); });

    const { getTokenMarketData } = await import("../tools/marketData.js?v=networkerr");
    const result = await getTokenMarketData({ pool_address: "poolG" });

    assert.equal(result.dexscreener_available, false);
    assert.equal(result.token_age_hours, null);
  });

  test("result includes pool_address and mint passthrough", async () => {
    delete process.env.BIRDEYE_API_KEY;
    setupFetch(async () => makeDexScreenerRes());

    const { getTokenMarketData } = await import("../tools/marketData.js?v=passthrough");
    const result = await getTokenMarketData({ pool_address: "poolH", mint: "mintH" });

    assert.equal(result.pool_address, "poolH");
    assert.equal(result.mint, "mintH");
  });
});
