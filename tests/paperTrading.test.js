/**
 * T18: Paper Trading Mode — openPaperPosition, closePaperPosition, updatePaperPositions, getPaperStats
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { openDb, applySchema } from "../db/db.js";
import {
  PAPER_HOURLY_FEE_RATE,
  GAS_ROUND_TRIP_SOL,
  PRIORITY_FEE_ROUND_TRIP_SOL,
  SWAP_SLIPPAGE_PCT,
  DEFAULT_BIN_STEP_BPS,
  simulatedExitCosts,
  openPaperPosition,
  closePaperPosition,
  updatePaperPositions,
  getPaperStats,
} from "../services/paperTrading.js";

const TX_COST = GAS_ROUND_TRIP_SOL + PRIORITY_FEE_ROUND_TRIP_SOL;

function makeTmpDb() {
  const p = path.join(os.tmpdir(), `sigma-paper-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(p);
  applySchema(db);
  return db;
}

// ─── PAPER_HOURLY_FEE_RATE ────────────────────────────────────────────────────

describe("PAPER_HOURLY_FEE_RATE (T18)", () => {
  test("is 0.0002 (0.02% per hour)", () => {
    assert.equal(PAPER_HOURLY_FEE_RATE, 0.0002);
  });
});

// ─── openPaperPosition ────────────────────────────────────────────────────────

describe("openPaperPosition (T18)", () => {
  test("creates a record in paper_positions with status=open", () => {
    const db = makeTmpDb();
    const id = openPaperPosition(db, {
      pool_address: "pool111",
      pool_name: "SOL-USDC",
      entry_bin: 500,
      bins_below: 20,
      bins_above: 0,
      amount_sol: 0.15,
      strategy: "Spot",
    });
    const row = db.prepare("SELECT * FROM paper_positions WHERE id = ?").get(id);
    assert.ok(row, "record should exist");
    assert.equal(row.status, "open");
    assert.equal(row.pool_address, "pool111");
    assert.equal(row.pool_name, "SOL-USDC");
    assert.equal(row.entry_bin, 500);
    assert.equal(row.bins_below, 20);
    assert.equal(row.bins_above, 0);
    assert.equal(row.amount_sol, 0.15);
    assert.equal(row.simulated_fee_sol, 0);
    assert.equal(row.simulated_pnl_sol, 0);
    assert.ok(row.entry_time, "entry_time should be set");
    assert.equal(row.exit_time, null);
  });

  test("returns a unique id per call", () => {
    const db = makeTmpDb();
    const id1 = openPaperPosition(db, { pool_address: "pool222", amount_sol: 0.1 });
    const id2 = openPaperPosition(db, { pool_address: "pool333", amount_sol: 0.1 });
    assert.notEqual(id1, id2);
  });

  test("throws when pool_address is missing", () => {
    const db = makeTmpDb();
    assert.throws(() => openPaperPosition(db, { amount_sol: 0.1 }), /pool_address/i);
  });

  test("throws when amount_sol is zero or missing", () => {
    const db = makeTmpDb();
    assert.throws(() => openPaperPosition(db, { pool_address: "pool444", amount_sol: 0 }), /amount_sol/i);
  });

  test("allows null entry_bin (OOR check will be skipped)", () => {
    const db = makeTmpDb();
    const id = openPaperPosition(db, { pool_address: "pool555", amount_sol: 0.15, entry_bin: null });
    const row = db.prepare("SELECT entry_bin FROM paper_positions WHERE id = ?").get(id);
    assert.equal(row.entry_bin, null);
  });
});

// ─── closePaperPosition ───────────────────────────────────────────────────────

describe("closePaperPosition (T18)", () => {
  test("closes an open position and calculates fee based on holding time", () => {
    const db = makeTmpDb();
    const id = openPaperPosition(db, { pool_address: "pool-close-1", amount_sol: 0.15 });

    // Backdate entry_time by 2 hours; use strftime to keep ISO8601+Z format so Date() parses as UTC
    db.prepare("UPDATE paper_positions SET entry_time = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 hours') WHERE id = ?").run(id);

    const result = closePaperPosition(db, id, "oor:bin=480");
    assert.ok(result, "should return result");
    assert.equal(result.id, id);
    assert.equal(result.exit_reason, "oor:bin=480");

    // Expected fee: 0.15 SOL × 0.0002 × 2h = 0.00006 SOL
    assert.ok(result.simulated_fee_sol > 0, "fee should be positive");
    // Allow ±1 second of drift (0.15 * 0.0002 / 3600 ≈ 0.0000000083 SOL/sec)
    assert.ok(Math.abs(result.simulated_fee_sol - 0.15 * PAPER_HOURLY_FEE_RATE * 2) < 0.00001, "fee should be ~2h worth");
    // PnL is net of costs. Non-down exit (oor:) pays gas + priority only (no conversion/IL).
    assert.ok(Math.abs(result.simulated_pnl_sol - (result.simulated_fee_sol - TX_COST)) < 1e-9, "PnL = fee − gas − priority on non-down exit");

    const row = db.prepare("SELECT * FROM paper_positions WHERE id = ?").get(id);
    assert.equal(row.status, "closed");
    assert.ok(row.exit_time, "exit_time should be set");
  });

  test("returns null for non-existent id", () => {
    const db = makeTmpDb();
    const result = closePaperPosition(db, "nonexistent", "oor");
    assert.equal(result, null);
  });

  test("returns null for already-closed position", () => {
    const db = makeTmpDb();
    const id = openPaperPosition(db, { pool_address: "pool-close-2", amount_sol: 0.1 });
    closePaperPosition(db, id, "oor");
    const result = closePaperPosition(db, id, "oor"); // second close attempt
    assert.equal(result, null);
  });

  test("position closed immediately has near-zero fee", () => {
    const db = makeTmpDb();
    const id = openPaperPosition(db, { pool_address: "pool-close-3", amount_sol: 0.15 });
    const result = closePaperPosition(db, id, "oor");
    assert.ok(result.simulated_fee_sol >= 0, "fee must be non-negative");
    assert.ok(result.simulated_fee_sol < 0.0001, "fee should be tiny for immediate close");
  });

  test("uses real fee_rate_24h when provided — 2h hold at 9.69% fee/TVL", () => {
    const db = makeTmpDb();
    // Simulate ZERO-SOL style pool: 9.69% fee/TVL per 24h
    const id = openPaperPosition(db, { pool_address: "pool-realfee-1", amount_sol: 0.15, fee_rate_24h: 9.69 });
    db.prepare("UPDATE paper_positions SET entry_time = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 hours') WHERE id = ?").run(id);

    const result = closePaperPosition(db, id, "oor");
    // Expected: 0.15 × (9.69/100/24) × 2 = 0.15 × 0.004038 × 2 = 0.001211 SOL
    const expected = 0.15 * (9.69 / 100 / 24) * 2;
    assert.ok(Math.abs(result.simulated_fee_sol - expected) < 0.00001, `fee should use real rate: got ${result.simulated_fee_sol}, expected ~${expected.toFixed(6)}`);
    // Real rate (9.69%/24h) should yield ~20x more than constant (0.0002/hr)
    assert.ok(result.simulated_fee_sol > 0.15 * PAPER_HOURLY_FEE_RATE * 2, "real fee rate should exceed fallback constant");
  });

  test("falls back to PAPER_HOURLY_FEE_RATE when fee_rate_24h is null", () => {
    const db = makeTmpDb();
    const id = openPaperPosition(db, { pool_address: "pool-fallback-1", amount_sol: 0.15 }); // no fee_rate_24h
    db.prepare("UPDATE paper_positions SET entry_time = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 hours') WHERE id = ?").run(id);

    const result = closePaperPosition(db, id, "oor");
    const expected = 0.15 * PAPER_HOURLY_FEE_RATE * 2;
    assert.ok(Math.abs(result.simulated_fee_sol - expected) < 0.00001, "should use constant fallback when no real rate");
  });
});

// ─── updatePaperPositions ─────────────────────────────────────────────────────

describe("updatePaperPositions (T18)", () => {
  test("closes positions that went out of range", async () => {
    const db = makeTmpDb();
    openPaperPosition(db, {
      pool_address: "pool-oor-1",
      entry_bin: 500,
      bins_below: 20,
      bins_above: 0,
      amount_sol: 0.15,
    });

    // Current bin is below range (500 - 20 = 480, current = 479 = OOR)
    const mockGetActiveBin = async () => ({ binId: 479 });

    const closed = await updatePaperPositions(db, mockGetActiveBin);
    assert.equal(closed.length, 1, "one position should be closed");
    assert.equal(closed[0].pool_address, "pool-oor-1");

    const row = db.prepare("SELECT status FROM paper_positions WHERE pool_address='pool-oor-1'").get();
    assert.equal(row.status, "closed");
  });

  test("keeps positions that are still in range", async () => {
    const db = makeTmpDb();
    openPaperPosition(db, {
      pool_address: "pool-inrange-1",
      entry_bin: 500,
      bins_below: 20,
      bins_above: 0,
      amount_sol: 0.15,
    });

    // Current bin is at boundary (500 - 20 = 480, current = 480 = edge, still in range)
    const mockGetActiveBin = async () => ({ binId: 480 });

    const closed = await updatePaperPositions(db, mockGetActiveBin);
    assert.equal(closed.length, 0, "no positions should be closed");

    const row = db.prepare("SELECT status FROM paper_positions WHERE pool_address='pool-inrange-1'").get();
    assert.equal(row.status, "open");
  });

  test("skips positions with null entry_bin", async () => {
    const db = makeTmpDb();
    openPaperPosition(db, { pool_address: "pool-nobin-1", amount_sol: 0.15, entry_bin: null });

    const mockGetActiveBin = async () => ({ binId: 100 });
    const closed = await updatePaperPositions(db, mockGetActiveBin);
    assert.equal(closed.length, 0, "position with null entry_bin should not be closed");
  });

  test("returns empty array when no open positions", async () => {
    const db = makeTmpDb();
    const mockGetActiveBin = async () => ({ binId: 500 });
    const closed = await updatePaperPositions(db, mockGetActiveBin);
    assert.equal(closed.length, 0);
  });

  test("handles getActiveBin error gracefully without crashing", async () => {
    const db = makeTmpDb();
    openPaperPosition(db, {
      pool_address: "pool-err-1",
      entry_bin: 500,
      bins_below: 20,
      bins_above: 0,
      amount_sol: 0.1,
    });

    const mockGetActiveBin = async () => { throw new Error("RPC failed"); };
    // Should not throw — errors are caught and logged
    const closed = await updatePaperPositions(db, mockGetActiveBin);
    assert.equal(closed.length, 0, "error should be swallowed, no positions closed");

    const row = db.prepare("SELECT status FROM paper_positions WHERE pool_address='pool-err-1'").get();
    assert.equal(row.status, "open", "position should remain open after RPC error");
  });
});

// ─── getPaperStats ────────────────────────────────────────────────────────────

describe("getPaperStats (T18)", () => {
  test("returns zeros when no positions exist", () => {
    const db = makeTmpDb();
    const stats = getPaperStats(db);
    assert.equal(stats.open_count, 0);
    assert.equal(stats.closed_count, 0);
    assert.equal(stats.win_count, 0);
    assert.equal(stats.win_rate, null);
    assert.equal(stats.avg_pnl_sol, null);
    assert.equal(stats.total_fee_sol, null);
    assert.equal(stats.avg_holding_hours, null);
  });

  test("returns correct win rate (net of costs)", () => {
    const db = makeTmpDb();

    // 1 SOL positions so fees clearly clear the ~0.0064 SOL tx cost
    const id1 = openPaperPosition(db, { pool_address: "p1", amount_sol: 1.0, entry_bin: 500, bins_below: 20, bins_above: 0 });
    const id2 = openPaperPosition(db, { pool_address: "p2", amount_sol: 1.0, entry_bin: 500, bins_below: 20, bins_above: 0 });
    const id3 = openPaperPosition(db, { pool_address: "p3", amount_sol: 1.0, entry_bin: 500, bins_below: 20, bins_above: 0 });

    // 50%/24h over 2h on 1 SOL → fee ≈ 0.0417 SOL; net of ~0.0064 costs → clear WIN
    db.prepare("UPDATE paper_positions SET entry_fee_rate_24h=50.0, entry_time = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 hours') WHERE id IN (?, ?)").run(id1, id2);

    // Upward exit → SOL intact, no conversion/IL; net = fee − tx cost
    closePaperPosition(db, id1, "oor_up:bin=520");
    closePaperPosition(db, id2, "oor_up:bin=520");
    closePaperPosition(db, id3, "oor_up:bin=520"); // immediate close → fee ≈ 0 → net negative → loss

    const stats = getPaperStats(db);
    assert.equal(stats.closed_count, 3);
    assert.equal(stats.win_count, 2, "two funded positions net-positive; one immediate close net-negative");
    assert.ok(Math.abs(stats.win_rate - 2 / 3) < 0.01, "win rate should be ~66.7%");
  });

  test("returns correct open_count for open positions", () => {
    const db = makeTmpDb();
    openPaperPosition(db, { pool_address: "popen1", amount_sol: 0.1 });
    openPaperPosition(db, { pool_address: "popen2", amount_sol: 0.1 });
    const stats = getPaperStats(db);
    assert.equal(stats.open_count, 2);
    assert.equal(stats.closed_count, 0);
  });

  test("stats includes holding_histogram with correct fields", () => {
    const db = makeTmpDb();
    const stats = getPaperStats(db);
    assert.ok("holding_histogram" in stats, "holding_histogram field present");
    assert.ok("lt1h" in stats.holding_histogram, "lt1h field present");
    assert.ok("h1_4" in stats.holding_histogram, "h1_4 field present");
    assert.ok("h4_24" in stats.holding_histogram, "h4_24 field present");
    assert.ok("gt24h" in stats.holding_histogram, "gt24h field present");
  });

  test("stats has all required fields", () => {
    const db = makeTmpDb();
    const stats = getPaperStats(db);
    const requiredFields = ["open_count", "closed_count", "win_count", "win_rate", "avg_pnl_sol", "total_fee_sol", "avg_holding_hours", "holding_histogram"];
    for (const field of requiredFields) {
      assert.ok(field in stats, `field ${field} should be present`);
    }
  });
});

// ─── simulatedExitCosts — realistic cost model ───────────────────────────────────

describe("simulatedExitCosts (realistic costs + IL)", () => {
  test("non-down exit pays only gas + priority (no IL)", () => {
    const c = simulatedExitCosts({ amount_sol: 1.0, entry_bin: 500, bins_below: 20, entry_bin_step: 100 }, "oor_up:bin=520");
    assert.equal(c.il_loss, 0, "no conversion loss on upward exit");
    assert.equal(c.swap_slippage, 0, "no swap-back on upward exit");
    assert.ok(Math.abs(c.total - TX_COST) < 1e-9, "total = gas + priority");
  });

  test("max_hold exit (SOL intact) pays only gas + priority", () => {
    const c = simulatedExitCosts({ amount_sol: 1.0, entry_bin: 500, bins_below: 20, entry_bin_step: 100 }, "max_hold_exceeded");
    assert.equal(c.il_loss, 0);
    assert.ok(Math.abs(c.total - TX_COST) < 1e-9);
  });

  test("downward exit incurs conversion/IL loss + swap slippage", () => {
    // entry 500, bins_below 20 → minBin 480; exit at 479 (just below range)
    const c = simulatedExitCosts({ amount_sol: 1.0, entry_bin: 500, bins_below: 20, entry_bin_step: 100 }, "oor_down:bin=479");
    assert.ok(c.il_loss > 0, "principal converted to a cheaper token → real loss");
    assert.ok(c.swap_slippage > 0, "swapping token back to SOL costs slippage");
    assert.ok(c.total > TX_COST, "down exit costs more than just gas");
    // r=1.01, exponent=(479-500)+20/2=-11 → ratio=1.01^-11≈0.8963 → il≈0.1037
    assert.ok(Math.abs(c.il_loss - (1 - Math.pow(1.01, -11))) < 1e-6, "IL matches geometric-mean mark-to-market");
  });

  test("deeper downward exit → larger IL loss (monotonic)", () => {
    const shallow = simulatedExitCosts({ amount_sol: 1.0, entry_bin: 500, bins_below: 20, entry_bin_step: 100 }, "oor_down:bin=479");
    const deep    = simulatedExitCosts({ amount_sol: 1.0, entry_bin: 500, bins_below: 20, entry_bin_step: 100 }, "oor_down:bin=400");
    assert.ok(deep.il_loss > shallow.il_loss, "further price fall = bigger principal loss");
  });

  test("falls back to DEFAULT_BIN_STEP_BPS when entry_bin_step is null", () => {
    const withDefault  = simulatedExitCosts({ amount_sol: 1.0, entry_bin: 500, bins_below: 20, entry_bin_step: null }, "oor_down:bin=479");
    const withExplicit = simulatedExitCosts({ amount_sol: 1.0, entry_bin: 500, bins_below: 20, entry_bin_step: DEFAULT_BIN_STEP_BPS }, "oor_down:bin=479");
    assert.ok(Math.abs(withDefault.il_loss - withExplicit.il_loss) < 1e-12, "null bin_step uses the default");
  });

  test("IL scales with position size", () => {
    const small = simulatedExitCosts({ amount_sol: 0.15, entry_bin: 500, bins_below: 20, entry_bin_step: 100 }, "oor_down:bin=479");
    const large = simulatedExitCosts({ amount_sol: 1.0,  entry_bin: 500, bins_below: 20, entry_bin_step: 100 }, "oor_down:bin=479");
    assert.ok(Math.abs(large.il_loss / small.il_loss - (1.0 / 0.15)) < 1e-6, "IL is proportional to amount_sol");
  });
});

// ─── entry_bin_step persistence ──────────────────────────────────────────────────

describe("entry_bin_step storage (T-cost)", () => {
  test("openPaperPosition stores bin_step and closePaperPosition uses it for IL", () => {
    const db = makeTmpDb();
    const id = openPaperPosition(db, { pool_address: "binstep-1", amount_sol: 1.0, entry_bin: 500, bins_below: 20, bins_above: 0, bin_step: 100 });
    const row = db.prepare("SELECT entry_bin_step FROM paper_positions WHERE id = ?").get(id);
    assert.equal(row.entry_bin_step, 100);

    db.prepare("UPDATE paper_positions SET entry_fee_rate_24h=50.0, entry_time = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 hours') WHERE id = ?").run(id);
    const result = closePaperPosition(db, id, "oor_down:bin=479");
    // gross fee positive but net pnl reflects the conversion loss (likely negative for a deep drop)
    assert.ok(result.simulated_fee_sol > 0, "gross fee earned");
    const expectedCosts = simulatedExitCosts({ amount_sol: 1.0, entry_bin: 500, bins_below: 20, entry_bin_step: 100 }, "oor_down:bin=479");
    assert.ok(Math.abs(result.simulated_pnl_sol - (result.simulated_fee_sol - expectedCosts.total)) < 1e-6, "net pnl = gross fee − all costs");
  });
});
