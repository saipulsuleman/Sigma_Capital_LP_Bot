/**
 * T17: Conservative mode — consecutive_api_errors counter + mode detection tests.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { openDb, applySchema, setCounter, getCounter } from "../db/db.js";
import {
  isConservativeMode,
  recordApiError,
  recordApiSuccess,
  CONSERVATIVE_THRESHOLD,
} from "../utils/conservative.js";

function makeTmpDb() {
  const p = path.join(os.tmpdir(), `sigma-conservative-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(p);
  applySchema(db);
  return db;
}

describe("CONSERVATIVE_THRESHOLD (T17)", () => {
  test("threshold is 3", () => {
    assert.equal(CONSERVATIVE_THRESHOLD, 3);
  });
});

describe("isConservativeMode (T17)", () => {
  test("returns false when counter is 0", () => {
    const db = makeTmpDb();
    assert.equal(isConservativeMode(db), false);
  });

  test("returns false when counter is below threshold (2)", () => {
    const db = makeTmpDb();
    setCounter("consecutive_api_errors", 2, db);
    assert.equal(isConservativeMode(db), false);
  });

  test("returns true when counter equals threshold (3)", () => {
    const db = makeTmpDb();
    setCounter("consecutive_api_errors", CONSERVATIVE_THRESHOLD, db);
    assert.equal(isConservativeMode(db), true);
  });

  test("returns true when counter exceeds threshold", () => {
    const db = makeTmpDb();
    setCounter("consecutive_api_errors", 7, db);
    assert.equal(isConservativeMode(db), true);
  });
});

describe("recordApiError (T17)", () => {
  test("increments consecutive_api_errors by 1", () => {
    const db = makeTmpDb();
    recordApiError(db);
    assert.equal(getCounter("consecutive_api_errors", db), 1);
  });

  test("3 consecutive errors activate conservative mode (D5 test 1)", () => {
    const db = makeTmpDb();
    recordApiError(db);
    assert.equal(isConservativeMode(db), false, "after 1 error: not in conservative mode");
    recordApiError(db);
    assert.equal(isConservativeMode(db), false, "after 2 errors: not in conservative mode");
    recordApiError(db);
    assert.equal(isConservativeMode(db), true, "after 3 errors: must be in conservative mode");
  });

  test("counter accumulates correctly across multiple calls", () => {
    const db = makeTmpDb();
    for (let i = 0; i < 5; i++) recordApiError(db);
    assert.equal(getCounter("consecutive_api_errors", db), 5);
  });

  test("does not affect closes_since_review counter", () => {
    const db = makeTmpDb();
    setCounter("closes_since_review", 3, db);
    recordApiError(db);
    recordApiError(db);
    assert.equal(getCounter("closes_since_review", db), 3, "closes_since_review must be unchanged");
  });
});

describe("recordApiSuccess (T17)", () => {
  test("resets consecutive_api_errors to 0 (D5 test 2)", () => {
    const db = makeTmpDb();
    setCounter("consecutive_api_errors", 3, db);
    assert.equal(isConservativeMode(db), true);
    recordApiSuccess(db);
    assert.equal(getCounter("consecutive_api_errors", db), 0);
    assert.equal(isConservativeMode(db), false);
  });

  test("1 success after 3 errors exits conservative mode", () => {
    const db = makeTmpDb();
    recordApiError(db);
    recordApiError(db);
    recordApiError(db);
    assert.equal(isConservativeMode(db), true);
    recordApiSuccess(db);
    assert.equal(isConservativeMode(db), false);
    assert.equal(getCounter("consecutive_api_errors", db), 0);
  });

  test("success on a clean counter (0) stays at 0", () => {
    const db = makeTmpDb();
    recordApiSuccess(db);
    assert.equal(getCounter("consecutive_api_errors", db), 0);
    assert.equal(isConservativeMode(db), false);
  });

  test("does not affect closes_since_review counter", () => {
    const db = makeTmpDb();
    setCounter("consecutive_api_errors", 5, db);
    setCounter("closes_since_review", 2, db);
    recordApiSuccess(db);
    assert.equal(getCounter("closes_since_review", db), 2);
  });
});

describe("conservative.js exports (T17)", () => {
  test("isConservativeMode, recordApiError, recordApiSuccess are all functions", async () => {
    const mod = await import("../utils/conservative.js");
    assert.equal(typeof mod.isConservativeMode, "function");
    assert.equal(typeof mod.recordApiError, "function");
    assert.equal(typeof mod.recordApiSuccess, "function");
  });
});
