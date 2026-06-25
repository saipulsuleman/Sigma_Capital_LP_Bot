/**
 * Auto-tune sweep — simulatePosition model sanity tests.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { simulatePosition, sweepScenario } from "../scripts/autotune.mjs";

describe("simulatePosition (autotune model)", () => {
  test("zero volatility + zero drift → stays in range, earns fee, no IL, net positive", () => {
    // σ=0, μ=0 → price never moves → in-range the whole max hold → big fee, no oor_down
    const r = simulatePosition({ binsBelow: 12, feeRate24h: 10, sigmaDaily: 0, muDaily: 0, binStep: 100, amountSol: 1.0, rand: () => 0.5 });
    assert.equal(r.exit, "max_hold", "no downward exit when price never moves");
    assert.ok(r.net > 0, "fee over a full hold beats tx cost");
    assert.ok(r.inRangeHours > 0, "accrues in-range hours");
  });

  test("high volatility + negative drift → exits oor_down with IL, net negative", () => {
    const r = simulatePosition({ binsBelow: 12, feeRate24h: 10, sigmaDaily: 2.0, muDaily: -0.1, binStep: 100, amountSol: 1.0, rand: makeSeq() });
    assert.equal(r.exit, "oor_down", "volatile down-drift crashes through the range");
    assert.ok(r.net < 0, "conversion/IL loss exceeds the small fee earned");
  });

  test("net is always finite", () => {
    for (const sigma of [0.1, 0.5, 1.2, 2.4]) {
      const r = simulatePosition({ binsBelow: 10, feeRate24h: 5, sigmaDaily: sigma, muDaily: -0.05, binStep: 100, rand: makeSeq() });
      assert.ok(Number.isFinite(r.net), `net finite for σ=${sigma}`);
    }
  });

  test("sweepScenario returns rows for each bins_below and picks a best", () => {
    const res = sweepScenario("test", { feeRate24h: 8, sigmaDaily: 0.5, muDaily: 0, binStep: 100 }, [8, 12, 20], 300);
    assert.equal(res.rows.length, 3);
    assert.ok(res.best && [8, 12, 20].includes(res.best.bb));
    for (const r of res.rows) assert.ok(Number.isFinite(r.mean) && r.win >= 0 && r.win <= 100);
  });
});

// deterministic-ish RNG so the stochastic tests don't flake
function makeSeq() {
  let s = 0x12345678;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
