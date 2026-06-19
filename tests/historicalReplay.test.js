/**
 * T23: Historical Replay Pipeline — historicalReplay service tests
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { openDb, applySchema, runMigrations } from "../db/db.js";
import {
  recordBacktest,
  updateBacktestOutcome,
  queryBacktests,
  getBacktestSummary,
  majorityVote,
} from "../services/historicalReplay.js";

function makeTmpDb() {
  const p = path.join(os.tmpdir(), `sigma-bt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(p);
  applySchema(db);
  runMigrations(db);
  return db;
}

function insertBt(db, overrides = {}) {
  return recordBacktest(db, {
    pool_address: overrides.pool_address ?? "poolA",
    pool_name: overrides.pool_name ?? "TEST-SOL",
    snapshot_date: overrides.snapshot_date ?? "2026-01-01",
    decision: overrides.decision ?? "deploy",
    decision_reason: overrides.decision_reason ?? "good fee/tvl",
    majority_count: overrides.majority_count ?? 2,
    fee_apy_7d: overrides.fee_apy_7d ?? null,
    oor_within_24h: overrides.oor_within_24h ?? null,
    actual_outcome: overrides.actual_outcome ?? "unknown",
  });
}

// ─── Schema ──────────────────────────────────────────────────────────────────

describe("backtests schema (T23)", () => {
  test("table exists after applySchema", () => {
    const db = makeTmpDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='backtests'").get();
    assert.ok(row, "backtests table should exist");
  });

  test("required columns exist", () => {
    const db = makeTmpDb();
    const cols = db.prepare("PRAGMA table_info(backtests)").all().map((r) => r.name);
    for (const col of ["id", "pool_address", "snapshot_date", "decision", "majority_count", "actual_outcome"]) {
      assert.ok(cols.includes(col), `column ${col} should exist`);
    }
  });
});

// ─── recordBacktest ───────────────────────────────────────────────────────────

describe("recordBacktest (T23)", () => {
  test("inserts and returns an id", () => {
    const db = makeTmpDb();
    const id = insertBt(db);
    assert.ok(id.startsWith("bt_"), "id should start with bt_");
    const row = db.prepare("SELECT * FROM backtests WHERE id = ?").get(id);
    assert.ok(row, "row should exist");
  });

  test("stores correct fields", () => {
    const db = makeTmpDb();
    const id = recordBacktest(db, {
      pool_address: "poolXYZ",
      pool_name: "BONK-SOL",
      snapshot_date: "2026-03-15",
      decision: "skip",
      decision_reason: "low volume",
      majority_count: 3,
      actual_outcome: "unknown",
    });
    const row = db.prepare("SELECT * FROM backtests WHERE id = ?").get(id);
    assert.equal(row.pool_address, "poolXYZ");
    assert.equal(row.pool_name, "BONK-SOL");
    assert.equal(row.snapshot_date, "2026-03-15");
    assert.equal(row.decision, "skip");
    assert.equal(row.majority_count, 3);
    assert.equal(row.actual_outcome, "unknown");
  });

  test("default actual_outcome is 'unknown'", () => {
    const db = makeTmpDb();
    const id = recordBacktest(db, {
      pool_address: "p1", snapshot_date: "2026-01-01", decision: "deploy",
    });
    const row = db.prepare("SELECT actual_outcome FROM backtests WHERE id = ?").get(id);
    assert.equal(row.actual_outcome, "unknown");
  });
});

// ─── updateBacktestOutcome ────────────────────────────────────────────────────

describe("updateBacktestOutcome (T23)", () => {
  test("sets outcome to 'win' when fee_apy_7d > 0 and no OOR", () => {
    const db = makeTmpDb();
    const id = insertBt(db);
    updateBacktestOutcome(db, id, { fee_apy_7d: 3.5, oor_within_24h: 0 });
    const row = db.prepare("SELECT * FROM backtests WHERE id = ?").get(id);
    assert.equal(row.actual_outcome, "win");
    assert.ok(Math.abs(row.fee_apy_7d - 3.5) < 0.001);
  });

  test("sets outcome to 'loss' when OOR within 24h", () => {
    const db = makeTmpDb();
    const id = insertBt(db);
    updateBacktestOutcome(db, id, { fee_apy_7d: 2.0, oor_within_24h: 1 });
    const row = db.prepare("SELECT * FROM backtests WHERE id = ?").get(id);
    assert.equal(row.actual_outcome, "loss");
    assert.equal(row.oor_within_24h, 1);
  });

  test("sets outcome to 'loss' when fee_apy_7d is 0", () => {
    const db = makeTmpDb();
    const id = insertBt(db);
    updateBacktestOutcome(db, id, { fee_apy_7d: 0, oor_within_24h: 0 });
    const row = db.prepare("SELECT * FROM backtests WHERE id = ?").get(id);
    assert.equal(row.actual_outcome, "loss");
  });
});

// ─── queryBacktests ───────────────────────────────────────────────────────────

describe("queryBacktests (T23)", () => {
  test("returns all rows when no filters given", () => {
    const db = makeTmpDb();
    insertBt(db, { decision: "deploy", pool_name: "AAA-SOL" });
    insertBt(db, { decision: "skip",   pool_name: "BBB-SOL" });
    assert.equal(queryBacktests(db).length, 2);
  });

  test("filters by decision", () => {
    const db = makeTmpDb();
    insertBt(db, { decision: "deploy" });
    insertBt(db, { decision: "skip" });
    const deploys = queryBacktests(db, { decision: "deploy" });
    assert.equal(deploys.length, 1);
    assert.equal(deploys[0].decision, "deploy");
  });

  test("filters by pool_name (partial match)", () => {
    const db = makeTmpDb();
    insertBt(db, { pool_name: "BONK-SOL" });
    insertBt(db, { pool_name: "WIF-SOL" });
    const result = queryBacktests(db, { pool_name: "BONK" });
    assert.equal(result.length, 1);
  });

  test("filters by actual_outcome", () => {
    const db = makeTmpDb();
    const id1 = insertBt(db);
    const id2 = insertBt(db);
    updateBacktestOutcome(db, id1, { fee_apy_7d: 2.0, oor_within_24h: 0 }); // win
    updateBacktestOutcome(db, id2, { fee_apy_7d: 0,   oor_within_24h: 1 }); // loss
    assert.equal(queryBacktests(db, { actual_outcome: "win" }).length, 1);
    assert.equal(queryBacktests(db, { actual_outcome: "loss" }).length, 1);
  });
});

// ─── getBacktestSummary ───────────────────────────────────────────────────────

describe("getBacktestSummary (T23)", () => {
  test("returns zeros when no data", () => {
    const db = makeTmpDb();
    const s = getBacktestSummary(db);
    assert.equal(s.total, 0);
    assert.equal(s.win_rate, null);
  });

  test("counts deploy and skip decisions correctly", () => {
    const db = makeTmpDb();
    insertBt(db, { decision: "deploy" });
    insertBt(db, { decision: "deploy" });
    insertBt(db, { decision: "skip" });
    const s = getBacktestSummary(db);
    assert.equal(s.deploy_decisions, 2);
    assert.equal(s.skip_decisions, 1);
  });

  test("win_rate is null when no outcomes resolved", () => {
    const db = makeTmpDb();
    insertBt(db, { actual_outcome: "unknown" });
    const s = getBacktestSummary(db);
    assert.equal(s.win_rate, null);
  });

  test("win_rate computed correctly from resolved outcomes", () => {
    const db = makeTmpDb();
    const id1 = insertBt(db);
    const id2 = insertBt(db);
    const id3 = insertBt(db);
    updateBacktestOutcome(db, id1, { fee_apy_7d: 3.0, oor_within_24h: 0 }); // win
    updateBacktestOutcome(db, id2, { fee_apy_7d: 1.0, oor_within_24h: 0 }); // win
    updateBacktestOutcome(db, id3, { fee_apy_7d: 0,   oor_within_24h: 1 }); // loss
    const s = getBacktestSummary(db);
    assert.ok(Math.abs(s.win_rate - 2/3) < 0.001, "win rate should be ~0.667");
    assert.equal(s.wins, 2);
    assert.equal(s.losses, 1);
  });
});

// ─── majorityVote ─────────────────────────────────────────────────────────────

describe("majorityVote (T23)", () => {
  test("2 deploys out of 3 → deploy", () => {
    const { decision, majority_count } = majorityVote(["deploy", "deploy", "skip"]);
    assert.equal(decision, "deploy");
    assert.equal(majority_count, 2);
  });

  test("all 3 deploy → deploy with majority_count=3", () => {
    const { decision, majority_count } = majorityVote(["deploy", "deploy", "deploy"]);
    assert.equal(decision, "deploy");
    assert.equal(majority_count, 3);
  });

  test("all 3 skip → skip", () => {
    const { decision } = majorityVote(["skip", "skip", "skip"]);
    assert.equal(decision, "skip");
  });

  test("2 skips out of 3 → skip", () => {
    const { decision, majority_count } = majorityVote(["deploy", "skip", "skip"]);
    assert.equal(decision, "skip");
    assert.equal(majority_count, 2);
  });

  test("single run → uses that decision", () => {
    const { decision } = majorityVote(["deploy"]);
    assert.equal(decision, "deploy");
  });
});
