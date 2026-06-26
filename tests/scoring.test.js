/**
 * scoreCandidate — ranking must be fee-dominant (validated: fee is the net-PnL driver).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scoreCandidate } from "../tools/screening.js";

describe("scoreCandidate ranking", () => {
  test("higher fee_active_tvl_ratio ranks higher even with lower organic", () => {
    const highFee = { fee_active_tvl_ratio: 0.04, organic_score: 60, volume_window: 10000, holders: 500 };
    const lowFee  = { fee_active_tvl_ratio: 0.008, organic_score: 95, volume_window: 50000, holders: 2000 };
    assert.ok(scoreCandidate(highFee) > scoreCandidate(lowFee),
      "fee should dominate the ranking, not organic");
  });

  test("between similar-fee pools, higher organic breaks the tie", () => {
    const a = { fee_active_tvl_ratio: 0.02, organic_score: 90, volume_window: 10000, holders: 500 };
    const b = { fee_active_tvl_ratio: 0.02, organic_score: 60, volume_window: 10000, holders: 500 };
    assert.ok(scoreCandidate(a) > scoreCandidate(b), "organic breaks ties at equal fee");
  });

  test("handles missing/null fields without throwing", () => {
    assert.equal(Number.isFinite(scoreCandidate({})), true);
    assert.equal(Number.isFinite(scoreCandidate({ fee_active_tvl_ratio: null, organic_score: null })), true);
  });
});
