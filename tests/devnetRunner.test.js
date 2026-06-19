/**
 * T22: Devnet Testing Harness — devnetRunner service tests
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { openDb, applySchema, runMigrations } from "../db/db.js";

// Dynamic imports with cache-busting for env-sensitive exports
let devnetModule;
before(async () => {
  devnetModule = await import(`../services/devnetRunner.js?v=${Date.now()}`);
});

function makeTmpDb() {
  const p = path.join(os.tmpdir(), `sigma-devnet-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(p);
  applySchema(db);
  runMigrations(db);
  return db;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

describe("devnet_runs schema (T22)", () => {
  test("table exists after applySchema", () => {
    const db = makeTmpDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='devnet_runs'").get();
    assert.ok(row, "devnet_runs table should exist");
  });

  test("required columns exist", () => {
    const db = makeTmpDb();
    const cols = db.prepare("PRAGMA table_info(devnet_runs)").all().map((r) => r.name);
    const required = ["id", "run_at", "cycle_id", "phase", "tx_signature", "success", "error_msg"];
    for (const col of required) {
      assert.ok(cols.includes(col), `column ${col} should exist`);
    }
  });
});

// ─── isDevnetMode ─────────────────────────────────────────────────────────────

describe("isDevnetMode (T22)", () => {
  const origNetwork = process.env.SOLANA_NETWORK;

  after(() => {
    if (origNetwork === undefined) delete process.env.SOLANA_NETWORK;
    else process.env.SOLANA_NETWORK = origNetwork;
  });

  test("returns false when SOLANA_NETWORK is not set", async () => {
    delete process.env.SOLANA_NETWORK;
    const mod = await import(`../services/devnetRunner.js?v=${Date.now()}-a`);
    assert.equal(mod.isDevnetMode(), false);
  });

  test("returns true when SOLANA_NETWORK=devnet", async () => {
    process.env.SOLANA_NETWORK = "devnet";
    const mod = await import(`../services/devnetRunner.js?v=${Date.now()}-b`);
    assert.equal(mod.isDevnetMode(), true);
  });

  test("returns false for non-devnet values", async () => {
    process.env.SOLANA_NETWORK = "mainnet-beta";
    const mod = await import(`../services/devnetRunner.js?v=${Date.now()}-c`);
    assert.equal(mod.isDevnetMode(), false);
  });
});

// ─── recordDevnetRun ──────────────────────────────────────────────────────────

describe("recordDevnetRun (T22)", () => {
  test("inserts a row and returns an id", () => {
    const db = makeTmpDb();
    const { recordDevnetRun } = devnetModule;
    const id = recordDevnetRun(db, {
      cycle_id: "cycle_001",
      phase: "deploy",
      pool_address: "poolABC",
      tx_signature: "sig123",
      deploy_amount: 0.15,
      gas_actual_sol: 0.000005,
      slippage_pct: 0.1,
      success: true,
    });
    assert.ok(id, "id should be returned");
    const row = db.prepare("SELECT * FROM devnet_runs WHERE id = ?").get(id);
    assert.ok(row, "row should exist in DB");
    assert.equal(row.cycle_id, "cycle_001");
    assert.equal(row.phase, "deploy");
    assert.equal(row.success, 1);
    assert.equal(row.tx_signature, "sig123");
  });

  test("records a failed run with error_msg", () => {
    const db = makeTmpDb();
    const { recordDevnetRun } = devnetModule;
    const id = recordDevnetRun(db, {
      cycle_id: "cycle_002",
      phase: "close",
      success: false,
      error_msg: "Transaction timed out",
    });
    const row = db.prepare("SELECT * FROM devnet_runs WHERE id = ?").get(id);
    assert.equal(row.success, 0);
    assert.equal(row.error_msg, "Transaction timed out");
  });

  test("null optional fields are stored as null", () => {
    const db = makeTmpDb();
    const { recordDevnetRun } = devnetModule;
    const id = recordDevnetRun(db, {
      cycle_id: "cycle_003",
      phase: "deploy",
      success: true,
    });
    const row = db.prepare("SELECT * FROM devnet_runs WHERE id = ?").get(id);
    assert.equal(row.tx_signature, null);
    assert.equal(row.gas_actual_sol, null);
    assert.equal(row.error_msg, null);
  });
});

// ─── getDevnetSummary ─────────────────────────────────────────────────────────

describe("getDevnetSummary (T22)", () => {
  test("returns zeros and gate_passed=false when no runs", () => {
    const db = makeTmpDb();
    const { getDevnetSummary } = devnetModule;
    const s = getDevnetSummary(db);
    assert.equal(s.total_phases, 0);
    assert.equal(s.complete_cycles, 0);
    assert.equal(s.gate_passed, false);
    assert.equal(s.last_run_at, null);
  });

  test("counts complete cycles (both deploy + close for same cycle_id)", () => {
    const db = makeTmpDb();
    const { recordDevnetRun, getDevnetSummary } = devnetModule;
    recordDevnetRun(db, { cycle_id: "c1", phase: "deploy", success: true });
    recordDevnetRun(db, { cycle_id: "c1", phase: "close", success: true });
    recordDevnetRun(db, { cycle_id: "c2", phase: "deploy", success: true }); // incomplete — no close

    const s = getDevnetSummary(db);
    assert.equal(s.complete_cycles, 1); // only c1 is complete
    assert.equal(s.total_phases, 3);
  });

  test("gate_passed is true when ≥10 complete successful cycles", () => {
    const db = makeTmpDb();
    const { recordDevnetRun, getDevnetSummary } = devnetModule;
    for (let i = 0; i < 10; i++) {
      recordDevnetRun(db, { cycle_id: `c${i}`, phase: "deploy", success: true });
      recordDevnetRun(db, { cycle_id: `c${i}`, phase: "close", success: true });
    }
    const s = getDevnetSummary(db);
    assert.equal(s.successful_cycles, 10);
    assert.equal(s.gate_passed, true);
  });

  test("gate_passed is false when cycles have failures", () => {
    const db = makeTmpDb();
    const { recordDevnetRun, getDevnetSummary } = devnetModule;
    for (let i = 0; i < 10; i++) {
      recordDevnetRun(db, { cycle_id: `c${i}`, phase: "deploy", success: true });
      recordDevnetRun(db, { cycle_id: `c${i}`, phase: "close", success: i < 9 }); // last one fails
    }
    const s = getDevnetSummary(db);
    assert.equal(s.complete_cycles, 10);
    assert.equal(s.successful_cycles, 9);
    assert.equal(s.gate_passed, false);
  });

  test("avg_gas_sol is computed correctly", () => {
    const db = makeTmpDb();
    const { recordDevnetRun, getDevnetSummary } = devnetModule;
    recordDevnetRun(db, { cycle_id: "g1", phase: "deploy", success: true, gas_actual_sol: 0.000004 });
    recordDevnetRun(db, { cycle_id: "g1", phase: "close",  success: true, gas_actual_sol: 0.000006 });

    const s = getDevnetSummary(db);
    assert.ok(Math.abs(s.avg_gas_sol - 0.000005) < 1e-9, "avg gas should be 0.000005");
  });

  test("failed_phases counts unsuccessful rows", () => {
    const db = makeTmpDb();
    const { recordDevnetRun, getDevnetSummary } = devnetModule;
    recordDevnetRun(db, { cycle_id: "f1", phase: "deploy", success: true });
    recordDevnetRun(db, { cycle_id: "f1", phase: "close", success: false, error_msg: "timeout" });

    const s = getDevnetSummary(db);
    assert.equal(s.successful_phases, 1);
    assert.equal(s.failed_phases, 1);
  });
});
