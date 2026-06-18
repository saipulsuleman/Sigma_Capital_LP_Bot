/**
 * T9: SQLite migration unit tests.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, applySchema, getCounter, setCounter, getMeta } from "../db/db.js";
import { runMigration, buildPaths } from "../scripts/migrate.js";

// ─── Temp directory isolation ─────────────────────────────────────

let tmpDir;

function mkTmp() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sigma-migrate-test-"));
}

function rmTmp() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function tmpPath(name) {
  return path.join(tmpDir, name);
}

function writeTmp(name, content) {
  fs.writeFileSync(tmpPath(name), JSON.stringify(content, null, 2));
}

function tmpPaths(overrides = {}) {
  return buildPaths({
    lessonsPath: tmpPath("lessons.json"),
    decisionLogPath: tmpPath("decision-log.json"),
    dbPath: tmpPath("sigma.db"),
    ...overrides,
  });
}

// ─── Schema tests ─────────────────────────────────────────────────

describe("applySchema (T9)", () => {
  beforeEach(mkTmp);
  afterEach(rmTmp);

  test("creates all required tables", () => {
    const db = openDb(tmpPath("test.db"));
    applySchema(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map((r) => r.name);

    for (const expected of ["positions", "decisions", "lessons", "skills", "counters", "daily_usage", "meta"]) {
      assert.ok(tables.includes(expected), `Missing table: ${expected}`);
    }
    db.close();
  });

  test("is idempotent — applying schema twice does not error", () => {
    const db = openDb(tmpPath("test.db"));
    applySchema(db);
    assert.doesNotThrow(() => applySchema(db));
    db.close();
  });
});

// ─── Counter tests ────────────────────────────────────────────────

describe("counter helpers (T9)", () => {
  let db;

  beforeEach(() => {
    mkTmp();
    db = openDb(tmpPath("counters.db"));
    applySchema(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    rmTmp();
  });

  test("getCounter returns 0 for unknown key", () => {
    assert.equal(getCounter("nonexistent", db), 0);
  });

  test("setCounter + getCounter round-trips correctly", () => {
    setCounter("consecutive_api_errors", 3, db);
    assert.equal(getCounter("consecutive_api_errors", db), 3);
  });

  test("consecutive_api_errors and closes_since_review are independent", () => {
    setCounter("consecutive_api_errors", 5, db);
    setCounter("closes_since_review", 2, db);
    assert.equal(getCounter("consecutive_api_errors", db), 5);
    assert.equal(getCounter("closes_since_review", db), 2);
    // Resetting one must not affect the other
    setCounter("consecutive_api_errors", 0, db);
    assert.equal(getCounter("closes_since_review", db), 2);
  });
});

// ─── Migration tests ──────────────────────────────────────────────

describe("runMigration (T9)", () => {
  beforeEach(mkTmp);
  afterEach(rmTmp);

  test("fresh migration with no JSON files creates DB with 0 rows and counters", () => {
    const paths = tmpPaths();
    const result = runMigration(paths);

    assert.ok(!result.skipped);
    assert.equal(result.positions, 0);
    assert.equal(result.lessons, 0);
    assert.equal(result.decisions, 0);

    const db = openDb(paths.dbPath);
    assert.equal(getMeta("migration_version", db), "1");
    assert.equal(getCounter("consecutive_api_errors", db), 0);
    assert.equal(getCounter("closes_since_review", db), 0);
    db.close();
  });

  test("migrates lessons.json performance data to positions table", () => {
    const samplePerf = [
      {
        position: "pos_abc123",
        pool: "pool_def456",
        pool_name: "SOL-USDC",
        strategy: "bid_ask",
        pnl_usd: 12.5,
        pnl_pct: 2.5,
        amount_sol: 0.5,
        fees_earned_usd: 3.0,
        close_reason: "take_profit",
        recorded_at: "2026-06-01T10:00:00Z",
      },
    ];
    writeTmp("lessons.json", { lessons: [], performance: samplePerf });

    const paths = tmpPaths();
    const result = runMigration(paths);

    assert.equal(result.positions, 1);

    const db = openDb(paths.dbPath);
    const row = db.prepare("SELECT * FROM positions WHERE id = ?").get("pos_abc123");
    assert.ok(row, "position row should exist");
    assert.equal(row.pool, "pool_def456");
    assert.equal(row.pool_name, "SOL-USDC");
    assert.equal(row.pnl_usd, 12.5);
    assert.equal(row.close_reason, "take_profit");
    db.close();
  });

  test("migrates lessons.json lessons array to lessons table", () => {
    const sampleLessons = [
      { id: "lesson_1", rule: "Avoid low-volume pools", confidence: 0.8, type: "avoidance", recorded_at: "2026-06-01T10:00:00Z" },
    ];
    writeTmp("lessons.json", { lessons: sampleLessons, performance: [] });

    const paths = tmpPaths();
    const result = runMigration(paths);

    assert.equal(result.lessons, 1);

    const db = openDb(paths.dbPath);
    const row = db.prepare("SELECT * FROM lessons WHERE id = ?").get("lesson_1");
    assert.ok(row, "lesson row should exist");
    assert.equal(row.rule, "Avoid low-volume pools");
    assert.equal(row.confidence, 0.8);
    db.close();
  });

  test("migrates decision-log.json to decisions table", () => {
    const sampleDecisions = [
      {
        id: "dec_001",
        ts: "2026-06-01T12:00:00Z",
        type: "deploy",
        actor: "SCREENER",
        pool: "pool_abc",
        pool_name: "TOKEN-SOL",
        summary: "Deployed to high-fee pool",
      },
    ];
    writeTmp("decision-log.json", { decisions: sampleDecisions });

    const paths = tmpPaths();
    const result = runMigration(paths);

    assert.equal(result.decisions, 1);

    const db = openDb(paths.dbPath);
    const row = db.prepare("SELECT * FROM decisions WHERE id = ?").get("dec_001");
    assert.ok(row, "decision row should exist");
    assert.equal(row.actor, "SCREENER");
    assert.equal(row.pool_name, "TOKEN-SOL");
    db.close();
  });

  test("is idempotent — second run skips and returns {skipped: true}", () => {
    writeTmp("lessons.json", { lessons: [], performance: [] });
    const paths = tmpPaths();

    runMigration(paths);
    const second = runMigration(paths);

    assert.equal(second.skipped, true);
  });

  test("creates .bak files for source JSON files", () => {
    writeTmp("lessons.json", { lessons: [], performance: [] });
    writeTmp("decision-log.json", { decisions: [] });
    const paths = tmpPaths();

    runMigration(paths);

    assert.ok(fs.existsSync(paths.lessonsBakPath), "lessons.json.bak should exist");
    assert.ok(fs.existsSync(paths.decisionLogBakPath), "decision-log.json.bak should exist");
  });

  test("rollback: deletes partial SQLite when verification fails", () => {
    // Patch: write invalid data that causes a row-count mismatch
    // We simulate failure by making positions have a duplicate id that gets ignored by INSERT OR IGNORE,
    // causing the count to be less than source length
    const samplePerf = [
      { position: "pos_dup", pool: "pool_a", pool_name: "A-SOL" },
      { position: "pos_dup", pool: "pool_b", pool_name: "B-SOL" }, // duplicate id → ignored
    ];
    writeTmp("lessons.json", { lessons: [], performance: samplePerf });
    const paths = tmpPaths();

    // Migration should fail because rowCount(1) < source(2)
    assert.throws(() => runMigration(paths), /Row count mismatch/);

    // DB file must be deleted (D9 rollback)
    assert.ok(!fs.existsSync(paths.dbPath), "Partial SQLite must be deleted on failure");
    // .bak files must be preserved
    assert.ok(fs.existsSync(paths.lessonsBakPath), ".bak must be preserved for retry");
  });
});
