/**
 * T12: Capital allocation guard unit tests (D6).
 *
 * Tests:
 * 1. Config values match the D8 spec (2 positions, 0.15 SOL/position, 0.1 SOL reserve)
 * 2. checkAllocation rejects a 3rd position when 2 are already open
 * 3. checkAllocation rejects a deploy when SOL balance is below minimum required
 * 4. checkAllocation allows deploy when all constraints are satisfied
 * 5. checkAllocation skips SOL check in DRY_RUN mode
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkAllocation } from "../utils/allocation.js";

// ─── Config fixture (matches D8 values) ──────────────────────────

const TEST_CFG = {
  risk: { maxPositions: 2 },
  management: { deployAmountSol: 0.15, gasReserve: 0.1 },
};

// ─── Config value assertions ──────────────────────────────────────

describe("Capital allocation config (T12 / D8)", () => {
  test("user-config.example.json has maxPositions=2", async () => {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const uc = require("../user-config.example.json");
    assert.equal(uc.maxPositions, 2, "maxPositions must be 2 (D8: 2 × 0.15 + 0.1 reserve = 0.40 SOL < 0.50 go-live)");
  });

  test("user-config.example.json has deployAmountSol=0.15", async () => {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const uc = require("../user-config.example.json");
    assert.equal(uc.deployAmountSol, 0.15, "deployAmountSol must be 0.15 SOL per position");
  });

  test("user-config.example.json has gasReserve=0.1", async () => {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const uc = require("../user-config.example.json");
    assert.equal(uc.gasReserve, 0.1, "gasReserve must be 0.1 SOL (minSolReserve)");
  });

  test("D8 math: 2 positions × 0.15 + 0.1 reserve fits within 0.5 SOL go-live", () => {
    const uc = { maxPositions: 2, deployAmountSol: 0.15, gasReserve: 0.1 };
    const worstCase = uc.maxPositions * uc.deployAmountSol + uc.gasReserve;
    assert.ok(worstCase <= 0.5, `Worst-case capital (${worstCase} SOL) must fit within 0.50 SOL go-live`);
  });
});

// ─── checkAllocation logic ────────────────────────────────────────

describe("checkAllocation (T12)", () => {
  test("allows deploy when 0 positions open and sufficient SOL", () => {
    const result = checkAllocation({ openCount: 0, solBalance: 0.5, cfg: TEST_CFG });
    assert.equal(result.allowed, true);
  });

  test("allows deploy when 1 position open and sufficient SOL", () => {
    const result = checkAllocation({ openCount: 1, solBalance: 0.35, cfg: TEST_CFG });
    assert.equal(result.allowed, true);
  });

  test("rejects 3rd position when 2 are already open (D6 test 1)", () => {
    const result = checkAllocation({ openCount: 2, solBalance: 1.0, cfg: TEST_CFG });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("Max positions"), `Expected reason about max positions, got: ${result.reason}`);
  });

  test("rejects deploy when SOL balance is 0.14 (below 0.25 minimum) (D6 test 2)", () => {
    const result = checkAllocation({ openCount: 0, solBalance: 0.14, cfg: TEST_CFG });
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("Insufficient SOL"), `Expected SOL reason, got: ${result.reason}`);
  });

  test("rejects deploy when SOL balance is exactly at reserve (no room for deploy)", () => {
    const result = checkAllocation({ openCount: 0, solBalance: 0.1, cfg: TEST_CFG });
    assert.equal(result.allowed, false);
  });

  test("allows deploy when SOL balance is exactly at minimum required (0.25)", () => {
    const minRequired = TEST_CFG.management.deployAmountSol + TEST_CFG.management.gasReserve; // 0.25
    const result = checkAllocation({ openCount: 0, solBalance: minRequired, cfg: TEST_CFG });
    assert.equal(result.allowed, true);
  });

  test("skips SOL check in DRY_RUN mode — allows deploy with 0 SOL", () => {
    const result = checkAllocation({ openCount: 0, solBalance: 0.0, cfg: TEST_CFG, isDryRun: true });
    assert.equal(result.allowed, true, "DRY_RUN should bypass the SOL balance guard");
  });

  test("still enforces position count in DRY_RUN mode", () => {
    const result = checkAllocation({ openCount: 2, solBalance: 0.0, cfg: TEST_CFG, isDryRun: true });
    assert.equal(result.allowed, false, "Max position count must be enforced even in DRY_RUN");
  });
});
