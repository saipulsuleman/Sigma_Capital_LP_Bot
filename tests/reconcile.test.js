/**
 * T11: Blockchain reconciliation unit tests.
 *
 * All tests use injected dependencies — no real RPC, no state.json I/O.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reconcilePositions } from "../services/reconcile.js";

// ─── Test helpers ─────────────────────────────────────────────────

function mockDeps({ openPositions = [], chainAddresses = [], alertSpy = null } = {}) {
  return {
    fetchFromChain: false,
    activeAddresses: chainAddresses,
    _getTrackedPositions: (openOnly) => (openOnly ? openPositions : openPositions),
    _syncOpenPositions: () => {},
    _sendAlert: alertSpy ?? (async () => {}),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("reconcilePositions (T11)", () => {
  test("returns reconciled=0 immediately when no local positions exist", async () => {
    const result = await reconcilePositions(mockDeps({ openPositions: [] }));
    assert.equal(result.reconciled, 0);
    assert.deepEqual(result.autoClosed, []);
  });

  test("returns reconciled=0 when all local positions are on chain", async () => {
    let alertCalled = false;
    const result = await reconcilePositions(
      mockDeps({
        openPositions: [{ position: "addr_abc123" }],
        chainAddresses: ["addr_abc123"],
        alertSpy: async () => { alertCalled = true; },
      })
    );
    assert.equal(result.reconciled, 0);
    assert.deepEqual(result.autoClosed, []);
    assert.equal(alertCalled, false, "No alert expected when state matches chain");
  });

  test("detects one ghost position not found on chain", async () => {
    let alertMsg = null;
    const result = await reconcilePositions(
      mockDeps({
        openPositions: [{ position: "ghost_address_1" }],
        chainAddresses: [],
        alertSpy: async (msg) => { alertMsg = msg; },
      })
    );
    assert.equal(result.reconciled, 1);
    assert.deepEqual(result.autoClosed, ["ghost_address_1"]);
    assert.ok(alertMsg !== null, "Alert should be sent for ghost position");
    assert.ok(alertMsg.includes("1 local position"), "Alert should mention count");
  });

  test("detects multiple ghost positions, alive position excluded", async () => {
    let alertMsg = null;
    const result = await reconcilePositions(
      mockDeps({
        openPositions: [
          { position: "ghost_111" },
          { position: "ghost_222" },
          { position: "alive_333" },
        ],
        chainAddresses: ["alive_333"],
        alertSpy: async (msg) => { alertMsg = msg; },
      })
    );
    assert.equal(result.reconciled, 2);
    assert.ok(result.autoClosed.includes("ghost_111"));
    assert.ok(result.autoClosed.includes("ghost_222"));
    assert.ok(!result.autoClosed.includes("alive_333"), "On-chain position must not be in autoClosed");
    assert.ok(alertMsg !== null, "Alert should be sent");
  });

  test("no alert sent when _sendAlert is null and telegram disabled", async () => {
    // When _sendAlert=null and isEnabled()=false in real env, alert is skipped.
    // Here we verify the function doesn't throw even without an alert handler.
    const result = await reconcilePositions({
      fetchFromChain: false,
      activeAddresses: [],
      _getTrackedPositions: () => [{ position: "ghost_no_tg" }],
      _syncOpenPositions: () => {},
      _sendAlert: null,
    });
    assert.equal(result.reconciled, 1);
  });

  test("defaults activeAddresses to [] when fetchFromChain=false and none provided", async () => {
    const result = await reconcilePositions({
      fetchFromChain: false,
      activeAddresses: null,  // explicitly null → defaults to []
      _getTrackedPositions: () => [{ position: "pos_will_ghost" }],
      _syncOpenPositions: () => {},
      _sendAlert: async () => {},
    });
    assert.equal(result.reconciled, 1, "Null activeAddresses treated as empty → position is ghost");
    assert.deepEqual(result.autoClosed, ["pos_will_ghost"]);
  });
});
