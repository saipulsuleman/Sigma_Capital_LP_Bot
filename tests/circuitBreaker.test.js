/**
 * T20: Circuit Breaker — recordClose, checkCircuit, triggerCircuit, resetCircuit
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { openDb, applySchema } from "../db/db.js";
import {
  initCircuit,
  recordClose,
  checkCircuit,
  triggerCircuit,
  resetCircuit,
  resetDailyLoss,
  getCircuitStatus,
  updatePeak,
} from "../utils/circuitBreaker.js";

function makeTmpDb() {
  const p = path.join(os.tmpdir(), `sigma-circuit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(p);
  applySchema(db);
  return db;
}

const CFG = { maxDailyLossUsd: 5, maxConsecutiveLosses: 3, maxDrawdownPct: 20 };

// ─── initCircuit ──────────────────────────────────────────────────────────────

describe("initCircuit (T20)", () => {
  test("creates the sentinel row on first call", () => {
    const db = makeTmpDb();
    initCircuit(db);
    const row = db.prepare("SELECT * FROM circuit_breaker WHERE id = 1").get();
    assert.ok(row, "row should exist");
    assert.equal(row.triggered, 0);
    assert.equal(row.daily_loss_usd, 0.0);
    assert.equal(row.consecutive_losses, 0);
  });

  test("is idempotent — calling twice is safe", () => {
    const db = makeTmpDb();
    initCircuit(db);
    initCircuit(db);
    const rows = db.prepare("SELECT COUNT(*) as count FROM circuit_breaker").get();
    assert.equal(rows.count, 1);
  });
});

// ─── recordClose ──────────────────────────────────────────────────────────────

describe("recordClose (T20)", () => {
  test("increments consecutive_losses on a losing close", () => {
    const db = makeTmpDb();
    initCircuit(db);
    recordClose(db, { pnl_usd: -2.5, config: CFG });
    const row = db.prepare("SELECT * FROM circuit_breaker WHERE id = 1").get();
    assert.equal(row.consecutive_losses, 1);
    assert.ok(row.daily_loss_usd > 0);
  });

  test("resets consecutive_losses on a winning close", () => {
    const db = makeTmpDb();
    initCircuit(db);
    recordClose(db, { pnl_usd: -1, config: CFG });
    recordClose(db, { pnl_usd: -1, config: CFG });
    recordClose(db, { pnl_usd: +2, config: CFG }); // win → reset
    const row = db.prepare("SELECT * FROM circuit_breaker WHERE id = 1").get();
    assert.equal(row.consecutive_losses, 0);
  });

  test("triggers on 3 consecutive losses (maxConsecutiveLosses=3)", () => {
    const db = makeTmpDb();
    initCircuit(db);
    recordClose(db, { pnl_usd: -1, config: CFG });
    recordClose(db, { pnl_usd: -1, config: CFG });
    const { newly_triggered } = recordClose(db, { pnl_usd: -1, config: CFG });
    assert.equal(newly_triggered, true);
    const row = db.prepare("SELECT * FROM circuit_breaker WHERE id = 1").get();
    assert.equal(row.triggered, 1);
  });

  test("triggers when daily_loss_usd reaches maxDailyLossUsd", () => {
    const db = makeTmpDb();
    initCircuit(db);
    recordClose(db, { pnl_usd: -2, config: CFG });
    recordClose(db, { pnl_usd: -2, config: CFG });
    const { newly_triggered } = recordClose(db, { pnl_usd: -1.01, config: CFG }); // total = 5.01 >= 5
    assert.equal(newly_triggered, true);
  });

  test("does not double-trigger — newly_triggered stays false once triggered", () => {
    const db = makeTmpDb();
    initCircuit(db);
    recordClose(db, { pnl_usd: -3, config: CFG });
    recordClose(db, { pnl_usd: -1, config: CFG });
    recordClose(db, { pnl_usd: -1, config: CFG });
    // circuit is now triggered by consecutive_losses
    const { newly_triggered } = recordClose(db, { pnl_usd: -99, config: CFG });
    assert.equal(newly_triggered, false); // already triggered — not newly
  });
});

// ─── checkCircuit ─────────────────────────────────────────────────────────────

describe("checkCircuit (T20)", () => {
  test("returns triggered=false when no conditions met", () => {
    const db = makeTmpDb();
    initCircuit(db);
    const { triggered } = checkCircuit(db, CFG);
    assert.equal(triggered, false);
  });

  test("returns triggered=true when already flagged", () => {
    const db = makeTmpDb();
    initCircuit(db);
    triggerCircuit(db, "test");
    const { triggered, reason } = checkCircuit(db, CFG);
    assert.equal(triggered, true);
    assert.equal(reason, "test");
  });

  test("returns triggered=true when daily_loss_usd >= maxDailyLossUsd", () => {
    const db = makeTmpDb();
    initCircuit(db);
    db.prepare("UPDATE circuit_breaker SET daily_loss_usd = 5.0 WHERE id = 1").run();
    const { triggered } = checkCircuit(db, CFG);
    assert.equal(triggered, true);
  });

  test("returns triggered=false when daily_loss is just below threshold", () => {
    const db = makeTmpDb();
    initCircuit(db);
    db.prepare("UPDATE circuit_breaker SET daily_loss_usd = 4.99 WHERE id = 1").run();
    const { triggered } = checkCircuit(db, CFG);
    assert.equal(triggered, false);
  });

  test("returns triggered=true when consecutive_losses >= maxConsecutiveLosses", () => {
    const db = makeTmpDb();
    initCircuit(db);
    db.prepare("UPDATE circuit_breaker SET consecutive_losses = 3 WHERE id = 1").run();
    const { triggered } = checkCircuit(db, CFG);
    assert.equal(triggered, true);
  });
});

// ─── resetCircuit ─────────────────────────────────────────────────────────────

describe("resetCircuit (T20)", () => {
  test("clears triggered flag and resets consecutive_losses", () => {
    const db = makeTmpDb();
    initCircuit(db);
    triggerCircuit(db, "test");
    resetCircuit(db);
    const row = db.prepare("SELECT * FROM circuit_breaker WHERE id = 1").get();
    assert.equal(row.triggered, 0);
    assert.equal(row.trigger_reason, null);
    assert.equal(row.consecutive_losses, 0);
  });

  test("after reset, checkCircuit returns triggered=false", () => {
    const db = makeTmpDb();
    initCircuit(db);
    triggerCircuit(db, "test");
    resetCircuit(db);
    const { triggered } = checkCircuit(db, CFG);
    assert.equal(triggered, false);
  });
});

// ─── resetDailyLoss ──────────────────────────────────────────────────────────

describe("resetDailyLoss (T20)", () => {
  test("resets daily_loss_usd to 0", () => {
    const db = makeTmpDb();
    initCircuit(db);
    db.prepare("UPDATE circuit_breaker SET daily_loss_usd = 3.5 WHERE id = 1").run();
    resetDailyLoss(db);
    const row = db.prepare("SELECT * FROM circuit_breaker WHERE id = 1").get();
    assert.equal(row.daily_loss_usd, 0.0);
  });
});

// ─── updatePeak ──────────────────────────────────────────────────────────────

describe("updatePeak (T20)", () => {
  test("sets initial peak_portfolio_sol", () => {
    const db = makeTmpDb();
    initCircuit(db);
    updatePeak(db, 1.5);
    const row = db.prepare("SELECT peak_portfolio_sol FROM circuit_breaker WHERE id = 1").get();
    assert.equal(row.peak_portfolio_sol, 1.5);
  });

  test("peak only increases (never decreases)", () => {
    const db = makeTmpDb();
    initCircuit(db);
    updatePeak(db, 1.5);
    updatePeak(db, 0.8); // lower — should not update
    updatePeak(db, 2.0); // higher — should update
    const row = db.prepare("SELECT peak_portfolio_sol FROM circuit_breaker WHERE id = 1").get();
    assert.equal(row.peak_portfolio_sol, 2.0);
  });
});

// ─── getCircuitStatus ────────────────────────────────────────────────────────

describe("getCircuitStatus (T20)", () => {
  test("returns status object with all required fields", () => {
    const db = makeTmpDb();
    const status = getCircuitStatus(db);
    const required = ["triggered", "trigger_reason", "daily_loss_usd", "consecutive_losses", "peak_portfolio_sol", "triggered_at", "date_utc"];
    for (const field of required) {
      assert.ok(field in status, `field ${field} should be present`);
    }
  });

  test("initial status shows untriggered with zero losses", () => {
    const db = makeTmpDb();
    const status = getCircuitStatus(db);
    assert.equal(status.triggered, 0);
    assert.equal(status.daily_loss_usd, 0.0);
    assert.equal(status.consecutive_losses, 0);
  });
});
