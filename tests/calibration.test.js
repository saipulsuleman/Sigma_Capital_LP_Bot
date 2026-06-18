/**
 * T8: Regression guard for fee/TVL threshold calibration.
 *
 * minFeeActiveTvlRatio must scale with the configured timeframe.
 * A hardcoded 0.05 with the default 5m timeframe yields only ~1 pool from the
 * Meteora discovery API — the bot would almost never find a trade. The correct
 * 5m value (from screening-scales.js) is 0.02, which yields ~3 pools.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

describe("minFeeActiveTvlRatio calibration (T8)", () => {
  test("config.js does not use hardcoded 0.05 for minFeeActiveTvlRatio default", () => {
    const src = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
    // Should NOT have `?? 0.05` as the fallback for minFeeActiveTvlRatio
    assert.ok(
      !src.includes("minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05"),
      "minFeeActiveTvlRatio default must not be hardcoded 0.05 — it must scale with timeframe"
    );
  });

  test("config.js references TIMEFRAME_SCREENING_SCALES for the default", () => {
    const src = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
    assert.ok(
      src.includes("TIMEFRAME_SCREENING_SCALES"),
      "config.js must reference TIMEFRAME_SCREENING_SCALES for minFeeActiveTvlRatio default"
    );
  });

  test("screening-scales.js has correct 5m threshold (0.02, not 0.05)", async () => {
    const { TIMEFRAME_SCREENING_SCALES } = await import("../screening-scales.js");
    assert.equal(
      TIMEFRAME_SCREENING_SCALES["5m"].minFeeActiveTvlRatio,
      0.02,
      "5m threshold should be 0.02 — calibrated from real API: 0.02 yields ~3 pools vs 0.05 yielding ~1"
    );
  });

  test("screening-scales.js thresholds scale monotonically with timeframe", async () => {
    const { TIMEFRAME_SCREENING_SCALES } = await import("../screening-scales.js");
    // Longer timeframes should require higher absolute fee/TVL (cumulative over more time)
    const order = ["5m", "30m", "1h", "4h", "24h"];
    for (let i = 0; i < order.length - 1; i++) {
      const a = TIMEFRAME_SCREENING_SCALES[order[i]].minFeeActiveTvlRatio;
      const b = TIMEFRAME_SCREENING_SCALES[order[i + 1]].minFeeActiveTvlRatio;
      assert.ok(
        a <= b,
        `${order[i]}=${a} should be <= ${order[i + 1]}=${b} (thresholds must scale with timeframe)`
      );
    }
  });
});
