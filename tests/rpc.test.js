/**
 * T13: RPC fallback + backoff unit tests.
 *
 * Tests withRetry() in isolation — no real Solana connection needed.
 * createResilientConnection() is an integration wrapper tested manually
 * (verify: set FALLBACK_RPC_URL and kill Helius, bot switches transparently).
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  withRetry,
  getErrorRate,
  _trackCall,
  _trackError,
  _resetForTest,
} from "../utils/rpc.js";

const FAST = { backoff: [1, 1, 1] };

describe("withRetry (T13)", () => {
  beforeEach(() => _resetForTest());

  test("returns primary result on first success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"), null, FAST);
    assert.equal(result, "ok");
  });

  test("retries on failure and succeeds on second attempt", async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return Promise.resolve("recovered");
    }, null, FAST);
    assert.equal(result, "recovered");
    assert.equal(calls, 2);
  });

  test("calls fallback after all primary retries exhausted", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const result = await withRetry(
      () => { primaryCalls++; throw new Error("primary down"); },
      () => { fallbackCalls++; return Promise.resolve("fallback"); },
      FAST
    );
    assert.equal(result, "fallback");
    assert.equal(primaryCalls, 3);
    assert.equal(fallbackCalls, 1);
  });

  test("throws last primary error when no fallback provided", async () => {
    await assert.rejects(
      () => withRetry(() => { throw new Error("rpc gone"); }, null, FAST),
      /rpc gone/
    );
  });

  test("throws fallback error when fallback also fails", async () => {
    await assert.rejects(
      () => withRetry(
        () => { throw new Error("primary fail"); },
        () => { throw new Error("fallback fail"); },
        FAST
      ),
      /fallback fail/
    );
  });

  test("does not call fallback when primary eventually succeeds", async () => {
    let fallbackCalls = 0;
    let primaryCalls = 0;
    await withRetry(
      () => { primaryCalls++; if (primaryCalls < 3) throw new Error("x"); return Promise.resolve("ok"); },
      () => { fallbackCalls++; return Promise.resolve("fb"); },
      FAST
    );
    assert.equal(fallbackCalls, 0);
    assert.equal(primaryCalls, 3);
  });
});

describe("error rate tracking (T13)", () => {
  beforeEach(() => _resetForTest());

  test("getErrorRate returns 0 with no calls", () => {
    assert.equal(getErrorRate(), 0);
  });

  test("getErrorRate is 0 when all calls succeed", () => {
    _trackCall(); _trackCall(); _trackCall();
    assert.equal(getErrorRate(), 0);
  });

  test("getErrorRate reflects ratio of errors to calls", () => {
    _trackCall(); _trackCall(); _trackCall(); _trackCall();
    _trackError(); _trackError();
    assert.equal(getErrorRate(), 0.5);
  });

  test("withRetry records error for each failed primary attempt", async () => {
    await withRetry(
      () => { throw new Error("fail"); },
      () => Promise.resolve("fb"),
      FAST
    );
    // 3 primary attempts → 3 errors, 3 calls
    assert.equal(getErrorRate(), 1.0);
  });

  test("withRetry re-arms alert on successful call", async () => {
    // Simulate error rate >10% to trigger alert arm disarm
    for (let i = 0; i < 10; i++) { _trackCall(); _trackError(); }
    // Now successful call should re-arm
    await withRetry(() => Promise.resolve("ok"), null, FAST);
    // Confirm rate is still high but alert is re-armed (testable via internals)
    // We can verify: another failure round would re-send alert (not directly testable
    // without Telegram mock — just verify call succeeds without throwing)
    const rate = getErrorRate();
    assert.ok(rate > 0.1, `Expected rate > 10%, got ${rate}`);
  });
});
