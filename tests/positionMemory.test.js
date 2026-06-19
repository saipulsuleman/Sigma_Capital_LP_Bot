/**
 * T21: 4-Tier Memory System — positionMemory service tests
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { openDb, applySchema, runMigrations } from "../db/db.js";
import { getHotPositions, queryPositionMemory, archiveOldPositions } from "../services/positionMemory.js";

function makeTmpDb() {
  const p = path.join(os.tmpdir(), `sigma-memory-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(p);
  applySchema(db);
  runMigrations(db);
  return db;
}

/** Insert a closed position with a given closed_at offset (hours ago). */
function insertPosition(db, { id, pool_name, pnl_usd = 1.0, hours_ago = 1, status = "active" } = {}) {
  db.prepare(`
    INSERT INTO positions (id, pool, pool_name, pnl_usd, closed_at, deployed_at, raw, status)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?), '{}', ?)
  `).run(id, `pool_${id}`, pool_name ?? `Pool_${id}`, pnl_usd, `-${hours_ago} hours`, `-${hours_ago + 1} hours`, status);
}

// ─── Migration ────────────────────────────────────────────────────────────────

describe("runMigrations (T21)", () => {
  test("adds status column if not already present", () => {
    const db = makeTmpDb();
    // Column should already exist (from schema + migration)
    const row = db.prepare("SELECT status FROM positions LIMIT 1").get();
    // No rows yet, but query succeeds — column exists
    assert.equal(row, undefined);
  });

  test("is idempotent — calling twice does not throw", () => {
    const db = makeTmpDb();
    assert.doesNotThrow(() => runMigrations(db));
    assert.doesNotThrow(() => runMigrations(db));
  });

  test("default status is active for new positions", () => {
    const db = makeTmpDb();
    insertPosition(db, { id: "p1", pool_name: "TEST-SOL" });
    const row = db.prepare("SELECT status FROM positions WHERE id = 'p1'").get();
    assert.equal(row.status, "active");
  });
});

// ─── getHotPositions ──────────────────────────────────────────────────────────

describe("getHotPositions (T21)", () => {
  test("returns empty array when no closed positions exist", () => {
    const db = makeTmpDb();
    const result = getHotPositions(db);
    assert.deepEqual(result, []);
  });

  test("returns last N closed positions ordered newest first", () => {
    const db = makeTmpDb();
    insertPosition(db, { id: "a", pool_name: "AAA-SOL", hours_ago: 10 });
    insertPosition(db, { id: "b", pool_name: "BBB-SOL", hours_ago: 5 });
    insertPosition(db, { id: "c", pool_name: "CCC-SOL", hours_ago: 1 });

    const result = getHotPositions(db, 3);
    assert.equal(result.length, 3);
    assert.equal(result[0].pool_name, "CCC-SOL"); // newest first
    assert.equal(result[2].pool_name, "AAA-SOL"); // oldest last
  });

  test("respects limit — returns at most N positions", () => {
    const db = makeTmpDb();
    for (let i = 0; i < 8; i++) {
      insertPosition(db, { id: `p${i}`, hours_ago: i + 1 });
    }
    const result = getHotPositions(db, 5);
    assert.equal(result.length, 5);
  });

  test("excludes archived positions", () => {
    const db = makeTmpDb();
    insertPosition(db, { id: "active1", pool_name: "ACTIVE-SOL", hours_ago: 2 });
    insertPosition(db, { id: "archived1", pool_name: "OLD-SOL", hours_ago: 5, status: "archived" });

    const result = getHotPositions(db, 10);
    assert.equal(result.length, 1);
    assert.equal(result[0].pool_name, "ACTIVE-SOL");
  });

  test("includes required fields in output", () => {
    const db = makeTmpDb();
    insertPosition(db, { id: "x", pool_name: "X-SOL", pnl_usd: 2.5, hours_ago: 3 });
    const [pos] = getHotPositions(db, 1);
    const requiredFields = ["pool_name", "pnl_usd", "closed_at", "deployed_at", "close_reason"];
    for (const field of requiredFields) {
      assert.ok(field in pos, `field ${field} should be present`);
    }
  });
});

// ─── queryPositionMemory ──────────────────────────────────────────────────────

describe("queryPositionMemory (T21)", () => {
  test("returns all non-archived positions when no filters given", () => {
    const db = makeTmpDb();
    insertPosition(db, { id: "q1", hours_ago: 10 });
    insertPosition(db, { id: "q2", hours_ago: 20 });

    const result = queryPositionMemory(db);
    assert.equal(result.length, 2);
  });

  test("filters by pool_name (partial match)", () => {
    const db = makeTmpDb();
    insertPosition(db, { id: "f1", pool_name: "BONK-SOL", hours_ago: 5 });
    insertPosition(db, { id: "f2", pool_name: "WIF-SOL", hours_ago: 6 });

    const result = queryPositionMemory(db, { pool_name: "BONK" });
    assert.equal(result.length, 1);
    assert.equal(result[0].pool_name, "BONK-SOL");
  });

  test("filters outcome=win returns only profitable positions", () => {
    const db = makeTmpDb();
    insertPosition(db, { id: "w1", pnl_usd: 2.5, hours_ago: 2 });
    insertPosition(db, { id: "l1", pnl_usd: -1.0, hours_ago: 3 });

    const wins = queryPositionMemory(db, { outcome: "win" });
    assert.ok(wins.every((p) => p.pnl_usd > 0), "all results should be wins");
  });

  test("filters outcome=loss returns only losing positions", () => {
    const db = makeTmpDb();
    insertPosition(db, { id: "w2", pnl_usd: 2.5, hours_ago: 2 });
    insertPosition(db, { id: "l2", pnl_usd: -1.0, hours_ago: 3 });

    const losses = queryPositionMemory(db, { outcome: "loss" });
    assert.ok(losses.every((p) => p.pnl_usd <= 0), "all results should be losses");
  });

  test("filters by hours_back — excludes older positions", () => {
    const db = makeTmpDb();
    insertPosition(db, { id: "recent", hours_ago: 5 });
    insertPosition(db, { id: "old", hours_ago: 100 });

    const result = queryPositionMemory(db, { hours_back: 24 });
    assert.equal(result.length, 1);
    assert.ok(result[0].pool_name?.includes("recent") || result[0].pool_name === "Pool_recent");
  });

  test("respects limit parameter", () => {
    const db = makeTmpDb();
    for (let i = 0; i < 10; i++) {
      insertPosition(db, { id: `lim${i}`, hours_ago: i + 1 });
    }
    const result = queryPositionMemory(db, { limit: 3 });
    assert.equal(result.length, 3);
  });

  test("excludes archived positions", () => {
    const db = makeTmpDb();
    insertPosition(db, { id: "a1", status: "active", hours_ago: 5 });
    insertPosition(db, { id: "arc1", status: "archived", hours_ago: 200 });

    const result = queryPositionMemory(db);
    assert.equal(result.length, 1);
  });
});

// ─── archiveOldPositions ──────────────────────────────────────────────────────

describe("archiveOldPositions (T21)", () => {
  test("returns 0 when no positions are old enough", () => {
    const db = makeTmpDb();
    insertPosition(db, { id: "fresh", hours_ago: 10 });
    const count = archiveOldPositions(db, 90);
    assert.equal(count, 0);
  });

  test("archives positions closed longer than threshold", () => {
    const db = makeTmpDb();
    const daysAgo = 91 * 24; // 91 days in hours
    insertPosition(db, { id: "old1", hours_ago: daysAgo });
    insertPosition(db, { id: "old2", hours_ago: daysAgo + 10 });

    const count = archiveOldPositions(db, 90);
    assert.equal(count, 2);

    const rows = db.prepare("SELECT status FROM positions WHERE id IN ('old1', 'old2')").all();
    assert.ok(rows.every((r) => r.status === "archived"));
  });

  test("does not re-archive already-archived positions", () => {
    const db = makeTmpDb();
    const daysAgo = 92 * 24;
    insertPosition(db, { id: "pre_archived", hours_ago: daysAgo, status: "archived" });

    const count = archiveOldPositions(db, 90);
    assert.equal(count, 0); // already archived → no change
  });

  test("only archives closed positions (closed_at IS NOT NULL)", () => {
    const db = makeTmpDb();
    // Insert an "open" position (no closed_at) that is otherwise old
    db.prepare(`
      INSERT INTO positions (id, pool, raw, status, deployed_at)
      VALUES ('open1', 'pool_open', '{}', 'active', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-9999 hours'))
    `).run();

    const count = archiveOldPositions(db, 1); // threshold: 1 day
    assert.equal(count, 0); // open position not archived
  });

  test("is idempotent — running twice archives same count total", () => {
    const db = makeTmpDb();
    const daysAgo = 95 * 24;
    insertPosition(db, { id: "idem1", hours_ago: daysAgo });

    const first = archiveOldPositions(db, 90);
    const second = archiveOldPositions(db, 90);
    assert.equal(first, 1);
    assert.equal(second, 0); // already archived
  });
});
