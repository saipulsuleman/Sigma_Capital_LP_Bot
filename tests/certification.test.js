/**
 * T25: Go-Live Certification Checklist — certification service tests
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { openDb, applySchema, runMigrations, setMeta } from "../db/db.js";
import {
  runCertification,
  markConservativeModeTested,
  markCircuitBreakerTested,
} from "../services/certification.js";
import { recordDevnetRun } from "../services/devnetRunner.js";

function makeTmpDb() {
  const p = path.join(os.tmpdir(), `sigma-cert-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(p);
  applySchema(db);
  runMigrations(db);
  return db;
}

/** Populate paper_positions with N closed positions that all win. */
function insertWinners(db, count, pool_name = "WIN-SOL") {
  for (let i = 0; i < count; i++) {
    db.prepare(`
      INSERT INTO paper_positions
        (id, pool_address, pool_name, amount_sol, simulated_pnl_sol, simulated_fee_sol,
         entry_time, exit_time, status)
      VALUES (?, ?, ?, 0.15, 0.010, 0.0001,
        strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?),
        strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?),
        'closed')
    `).run(`w_${i}_${Date.now()}`, `pool_w${i}`, pool_name, `-${i + 2} hours`, `-${i + 1} hours`);
  }
}

/** Add N complete successful devnet cycles. */
function insertDevnetCycles(db, count) {
  for (let i = 0; i < count; i++) {
    recordDevnetRun(db, { cycle_id: `dc${i}`, phase: "deploy", success: true });
    recordDevnetRun(db, { cycle_id: `dc${i}`, phase: "close",  success: true });
  }
}

const FULL_PASS_CONFIG = {
  paperWinRateMin: 0.5,
  sharpeMin: 0.5,
  devnetTxMin: 10,
  jestTestsMin: 80,
};

// ─── markConservativeModeTested / markCircuitBreakerTested ────────────────────

describe("mark tested flags (T25)", () => {
  test("markConservativeModeTested sets the meta flag", () => {
    const db = makeTmpDb();
    markConservativeModeTested(db);
    const { criteria } = runCertification(db, FULL_PASS_CONFIG);
    const c = criteria.find((x) => x.name === "conservative_mode_tested");
    assert.equal(c.actual, "yes");
  });

  test("markCircuitBreakerTested sets the meta flag", () => {
    const db = makeTmpDb();
    markCircuitBreakerTested(db);
    const { criteria } = runCertification(db, FULL_PASS_CONFIG);
    const c = criteria.find((x) => x.name === "circuit_breaker_tested");
    assert.equal(c.actual, "yes");
  });
});

// ─── runCertification ────────────────────────────────────────────────────────

describe("runCertification (T25)", () => {
  test("all_passed is false when no data at all", () => {
    const db = makeTmpDb();
    const { all_passed, criteria } = runCertification(db, FULL_PASS_CONFIG);
    assert.equal(all_passed, false);
    assert.ok(criteria.length >= 5, "should have at least 5 criteria");
  });

  test("paper_win_rate criterion: PENDING when no closed positions", () => {
    const db = makeTmpDb();
    const { criteria } = runCertification(db, FULL_PASS_CONFIG);
    const c = criteria.find((x) => x.name === "paper_win_rate");
    assert.equal(c.status, "PENDING");
  });

  test("paper_win_rate criterion: PASS when win rate >= threshold", () => {
    const db = makeTmpDb();
    insertWinners(db, 10); // 10 winners → 100% win rate
    const { criteria } = runCertification(db, FULL_PASS_CONFIG);
    const c = criteria.find((x) => x.name === "paper_win_rate");
    assert.equal(c.status, "PASS");
  });

  test("paper_win_rate criterion: FAIL when win rate < threshold", () => {
    const db = makeTmpDb();
    // 3 wins, 8 losses → ~27% win rate < 50%
    insertWinners(db, 3);
    for (let i = 0; i < 8; i++) {
      db.prepare(`
        INSERT INTO paper_positions
          (id, pool_address, pool_name, amount_sol, simulated_pnl_sol, simulated_fee_sol,
           entry_time, exit_time, status)
        VALUES (?, ?, 'LOSS-SOL', 0.15, -0.005, 0.0001,
          strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 hours'),
          strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hours'),
          'closed')
      `).run(`l_${i}`, `pool_l${i}`);
    }
    const { criteria } = runCertification(db, FULL_PASS_CONFIG);
    const c = criteria.find((x) => x.name === "paper_win_rate");
    assert.equal(c.status, "FAIL");
  });

  test("devnet_cycles criterion: FAIL when < devnetTxMin cycles", () => {
    const db = makeTmpDb();
    insertDevnetCycles(db, 5); // only 5, need 10
    const { criteria } = runCertification(db, FULL_PASS_CONFIG);
    const c = criteria.find((x) => x.name === "devnet_cycles");
    assert.equal(c.status, "FAIL");
  });

  test("devnet_cycles criterion: PASS when >= devnetTxMin cycles", () => {
    const db = makeTmpDb();
    insertDevnetCycles(db, 10);
    const { criteria } = runCertification(db, FULL_PASS_CONFIG);
    const c = criteria.find((x) => x.name === "devnet_cycles");
    assert.equal(c.status, "PASS");
  });

  test("jest_tests criterion: PENDING when no meta key set", () => {
    const db = makeTmpDb();
    const { criteria } = runCertification(db, FULL_PASS_CONFIG);
    const c = criteria.find((x) => x.name === "jest_tests");
    assert.equal(c.status, "PENDING");
  });

  test("jest_tests criterion: PASS when meta jest_test_count >= threshold", () => {
    const db = makeTmpDb();
    setMeta("jest_test_count", "100", db);
    const { criteria } = runCertification(db, FULL_PASS_CONFIG);
    const c = criteria.find((x) => x.name === "jest_tests");
    assert.equal(c.status, "PASS");
  });

  test("jest_tests criterion: FAIL when count < threshold", () => {
    const db = makeTmpDb();
    setMeta("jest_test_count", "50", db);
    const { criteria } = runCertification(db, FULL_PASS_CONFIG);
    const c = criteria.find((x) => x.name === "jest_tests");
    assert.equal(c.status, "FAIL");
  });

  test("all_passed requires all criteria to be PASS", () => {
    const db = makeTmpDb();
    insertWinners(db, 10);
    insertDevnetCycles(db, 10);
    setMeta("jest_test_count", "100", db);
    markConservativeModeTested(db);
    markCircuitBreakerTested(db);
    // sharpe waived (<20 closes), conservative+circuit tested

    const { all_passed, criteria } = runCertification(db, FULL_PASS_CONFIG);
    const failing = criteria.filter((c) => c.status === "FAIL");
    assert.equal(failing.length, 0, `Should have no failing: ${JSON.stringify(failing)}`);
    assert.equal(all_passed, true);
  });

  test("output includes all 6 criteria", () => {
    const db = makeTmpDb();
    const { criteria } = runCertification(db, FULL_PASS_CONFIG);
    const names = criteria.map((c) => c.name);
    const expected = ["paper_win_rate", "sharpe", "devnet_cycles", "jest_tests",
                      "conservative_mode_tested", "circuit_breaker_tested"];
    for (const name of expected) {
      assert.ok(names.includes(name), `criterion ${name} should be present`);
    }
  });
});
