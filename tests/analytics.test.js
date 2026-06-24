/**
 * T24: Decision Analytics Dashboard — analytics service tests
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { openDb, applySchema, runMigrations } from "../db/db.js";
import { computeSharpe, getPaperAnalytics, getCombinedAnalytics } from "../services/analytics.js";

function makeTmpDb() {
  const p = path.join(os.tmpdir(), `sigma-analytics-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(p);
  applySchema(db);
  runMigrations(db);
  return db;
}

/** Insert a closed paper position. */
function insertPaperClosed(db, { id, pool_name = "TEST-SOL", pnl = 0.001, entry_hours_ago = 3, holding_hours = 2 } = {}) {
  const exitHoursAgo = entry_hours_ago - holding_hours;
  db.prepare(`
    INSERT INTO paper_positions
      (id, pool_address, pool_name, amount_sol, simulated_pnl_sol, simulated_fee_sol,
       entry_time, exit_time, status)
    VALUES (?, ?, ?, 0.15, ?, 0.0001,
      strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?),
      strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?),
      'closed')
  `).run(id, `pool_${id}`, pool_name, pnl, `-${entry_hours_ago} hours`, `-${exitHoursAgo} hours`);
}

// ─── computeSharpe ────────────────────────────────────────────────────────────

describe("computeSharpe (T24)", () => {
  test("returns null when fewer than 20 data points", () => {
    assert.equal(computeSharpe([0.01, 0.02, -0.01]), null);
  });

  test("returns null for exactly 19 data points", () => {
    assert.equal(computeSharpe(Array(19).fill(0.01)), null);
  });

  test("returns a number for 20+ data points", () => {
    const returns = Array(20).fill(0).map((_, i) => (i % 2 === 0 ? 0.01 : -0.005));
    const sharpe = computeSharpe(returns);
    assert.ok(typeof sharpe === "number", "should return a number");
    assert.ok(isFinite(sharpe), "should be finite");
  });

  test("returns null when std is 0 (all returns identical)", () => {
    const returns = Array(20).fill(0.01);
    assert.equal(computeSharpe(returns), null);
  });

  test("positive mean returns give positive Sharpe", () => {
    const returns = Array(20).fill(0).map(() => Math.random() * 0.01 + 0.005);
    const sharpe = computeSharpe(returns);
    assert.ok(sharpe == null || sharpe > 0, "positive mean should give positive Sharpe");
  });
});

// ─── getPaperAnalytics ────────────────────────────────────────────────────────

describe("getPaperAnalytics (T24)", () => {
  test("returns zeros/nulls when no closed positions", () => {
    const db = makeTmpDb();
    const a = getPaperAnalytics(db);
    assert.equal(a.closed_count, 0);
    assert.equal(a.win_rate, null);
    assert.equal(a.avg_pnl_sol, null);
    assert.equal(a.sharpe, null);
  });

  test("win_rate is calculated correctly", () => {
    const db = makeTmpDb();
    insertPaperClosed(db, { id: "w1", pnl: 0.01 });
    insertPaperClosed(db, { id: "w2", pnl: 0.02 });
    insertPaperClosed(db, { id: "l1", pnl: -0.01 });
    const a = getPaperAnalytics(db);
    assert.ok(Math.abs(a.win_rate - 2/3) < 0.001);
  });

  test("holding_histogram categorizes positions correctly", () => {
    const db = makeTmpDb();
    insertPaperClosed(db, { id: "h1", holding_hours: 0.5, entry_hours_ago: 1 });   // <1h
    insertPaperClosed(db, { id: "h2", holding_hours: 2,   entry_hours_ago: 5 });   // 1-4h
    insertPaperClosed(db, { id: "h3", holding_hours: 12,  entry_hours_ago: 15 });  // 4-24h
    insertPaperClosed(db, { id: "h4", holding_hours: 48,  entry_hours_ago: 60 });  // >24h
    const a = getPaperAnalytics(db);
    assert.equal(a.holding_histogram["<1h"],   1);
    assert.equal(a.holding_histogram["1-4h"],  1);
    assert.equal(a.holding_histogram["4-24h"], 1);
    assert.equal(a.holding_histogram[">24h"],  1);
  });

  test("top_losing_patterns identifies worst pool types", () => {
    const db = makeTmpDb();
    // Pool "SHITCOIN-SOL" loses consistently (2+ closes needed)
    insertPaperClosed(db, { id: "ls1", pool_name: "SHITCOIN-SOL", pnl: -0.05, entry_hours_ago: 5 });
    insertPaperClosed(db, { id: "ls2", pool_name: "SHITCOIN-SOL", pnl: -0.03, entry_hours_ago: 6 });
    // Pool "GOOD-SOL" wins
    insertPaperClosed(db, { id: "gd1", pool_name: "GOOD-SOL", pnl: 0.01, entry_hours_ago: 3 });
    insertPaperClosed(db, { id: "gd2", pool_name: "GOOD-SOL", pnl: 0.02, entry_hours_ago: 4 });

    const a = getPaperAnalytics(db);
    assert.equal(a.top_losing_patterns.length, 1);
    assert.equal(a.top_losing_patterns[0].pool_name, "SHITCOIN-SOL");
    assert.ok(a.top_losing_patterns[0].avg_pnl_sol < 0);
  });

  test("avg_pnl_sol is the arithmetic mean of simulated_pnl_sol", () => {
    const db = makeTmpDb();
    insertPaperClosed(db, { id: "p1", pnl: 0.02, entry_hours_ago: 5 });
    insertPaperClosed(db, { id: "p2", pnl: -0.01, entry_hours_ago: 6 });
    const a = getPaperAnalytics(db);
    assert.ok(Math.abs(a.avg_pnl_sol - 0.005) < 0.0001, "avg pnl should be 0.005");
  });

  test("excludes pre-fix `oor:` positions but counts new-format exits", () => {
    const db = makeTmpDb();
    const insertWithReason = (id, pnl, reason) => db.prepare(`
      INSERT INTO paper_positions
        (id, pool_address, pool_name, amount_sol, simulated_pnl_sol, simulated_fee_sol,
         entry_time, exit_time, exit_reason, status)
      VALUES (?, ?, ?, 1.0, ?, 0.0001,
        strftime('%Y-%m-%dT%H:%M:%SZ','now','-5 hours'),
        strftime('%Y-%m-%dT%H:%M:%SZ','now','-3 hours'), ?, 'closed')
    `).run(id, `pool_${id}`, "X-SOL", pnl, reason);

    // 2 buggy-era losses (old `oor:` format) — must be excluded from win-rate
    insertWithReason("old1", 0.000001, "oor:bin=-231");
    insertWithReason("old2", 0.000001, "oor:bin=-220");
    // 1 organic win under current logic — must be counted
    insertWithReason("new1", 0.05, "oor_down:bin=-469");

    const a = getPaperAnalytics(db);
    assert.equal(a.closed_count, 1, "only the new-format close counts");
    assert.equal(a.win_count, 1, "the organic close is a win (>0.006 SOL)");
    assert.equal(a.win_rate, 1, "win_rate ignores contaminated oor: rows");
  });
});

// ─── getCombinedAnalytics ─────────────────────────────────────────────────────

describe("getCombinedAnalytics (T24)", () => {
  test("returns null win rates when no data", () => {
    const db = makeTmpDb();
    const c = getCombinedAnalytics(db);
    assert.equal(c.paper_win_rate, null);
    assert.equal(c.backtest_win_rate, null);
    assert.equal(c.combined_trade_count, 0);
  });

  test("combined_trade_count is sum of paper closes and resolved backtests", () => {
    const db = makeTmpDb();
    insertPaperClosed(db, { id: "cp1", pnl: 0.01, entry_hours_ago: 3 });
    insertPaperClosed(db, { id: "cp2", pnl: -0.01, entry_hours_ago: 4 });
    // Add a resolved backtest
    db.prepare(`
      INSERT INTO backtests (id, pool_address, snapshot_date, decision, actual_outcome)
      VALUES ('bt1', 'poolA', '2026-01-01', 'deploy', 'win')
    `).run();

    const c = getCombinedAnalytics(db);
    assert.equal(c.combined_trade_count, 3); // 2 paper + 1 backtest
  });
});
