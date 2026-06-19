/**
 * T14: Daily token budget + SOL guard unit tests.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { openDb, applySchema } from "../db/db.js";
import { recordUsage, getDailyUsage, checkBudget, DAILY_BUDGET_USD, LOW_SOL_THRESHOLD } from "../utils/budget.js";

function makeTmpDb() {
  const tmp = path.join(os.tmpdir(), `sigma-budget-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(tmp);
  applySchema(db);
  return db;
}

describe("recordUsage + getDailyUsage (T14)", () => {
  test("records tokens and accumulates on same date+model", () => {
    const db = makeTmpDb();
    const today = new Date().toISOString().slice(0, 10);
    recordUsage("deepseek-chat", 1000, 200, db);
    recordUsage("deepseek-chat", 500, 100, db);
    const usage = getDailyUsage(today, db);
    assert.equal(usage.tokens_in, 1500);
    assert.equal(usage.tokens_out, 300);
  });

  test("records cost estimate (non-zero for non-zero tokens)", () => {
    const db = makeTmpDb();
    const today = new Date().toISOString().slice(0, 10);
    recordUsage("deepseek-chat", 1_000_000, 0, db);
    const usage = getDailyUsage(today, db);
    // deepseek-chat input = $0.27/M → 1M tokens = $0.27
    assert.ok(usage.cost_usd > 0.25 && usage.cost_usd < 0.30,
      `Expected cost ~$0.27, got $${usage.cost_usd}`);
  });

  test("tracks separate models independently", () => {
    const db = makeTmpDb();
    const today = new Date().toISOString().slice(0, 10);
    recordUsage("deepseek-chat",     1000, 0, db);
    recordUsage("deepseek-reasoner", 2000, 0, db);
    const usage = getDailyUsage(today, db);
    assert.equal(usage.tokens_in, 3000);
  });

  test("getDailyUsage returns zeros when no records exist", () => {
    const db = makeTmpDb();
    const usage = getDailyUsage("1970-01-01", db);
    assert.equal(usage.tokens_in, 0);
    assert.equal(usage.cost_usd, 0);
  });

  test("skips no-op call when both token counts are 0", () => {
    const db = makeTmpDb();
    const today = new Date().toISOString().slice(0, 10);
    recordUsage("deepseek-chat", 0, 0, db);
    const usage = getDailyUsage(today, db);
    assert.equal(usage.cost_usd, 0);
  });
});

describe("checkBudget (T14)", () => {
  test("allows when cost is below daily limit", () => {
    const db = makeTmpDb();
    recordUsage("deepseek-chat", 100, 10, db);
    const result = checkBudget(db);
    assert.equal(result.allowed, true);
    assert.ok(result.usage.cost_usd < DAILY_BUDGET_USD);
  });

  test("blocks when cost meets or exceeds daily limit", () => {
    const db = makeTmpDb();
    // 5M input tokens at $0.27/M = $1.35, need ~18.5M to hit $5
    // Simpler: inject directly via multiple large calls
    for (let i = 0; i < 20; i++) {
      recordUsage("deepseek-chat", 1_000_000, 1_000_000, db);
    }
    const result = checkBudget(db);
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("Daily token budget exceeded"), result.reason);
    assert.ok(result.usage.cost_usd >= DAILY_BUDGET_USD);
  });

  test("result includes usage stats", () => {
    const db = makeTmpDb();
    const result = checkBudget(db);
    assert.ok("usage" in result);
    assert.ok("tokens_in" in result.usage);
    assert.ok("cost_usd" in result.usage);
  });
});

describe("constants (T14)", () => {
  test("DAILY_BUDGET_USD is 5.0", () => {
    assert.equal(DAILY_BUDGET_USD, 5.0);
  });

  test("LOW_SOL_THRESHOLD is 0.05", () => {
    assert.equal(LOW_SOL_THRESHOLD, 0.05);
  });
});
