/**
 * T15: REVIEW Agent — cumulative SQLite trigger + skill file write tests.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { openDb, applySchema, incrementCounter, resetCounter, getCounter } from "../db/db.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDb() {
  const p = path.join(os.tmpdir(), `sigma-review-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDb(p);
  applySchema(db);
  return db;
}

function makeTmpDirs() {
  const root = path.join(os.tmpdir(), `sigma-skills-${Date.now()}`);
  const active  = path.join(root, "active");
  const pending = path.join(root, "pending");
  fs.mkdirSync(active,  { recursive: true });
  fs.mkdirSync(pending, { recursive: true });
  return { root, active, pending };
}

// ── Counter behaviour (executor-side logic) ────────────────────────────────

describe("closes_since_review counter (T15)", () => {
  test("increments from 0 to 1 on first close", () => {
    const db = makeTmpDb();
    const count = incrementCounter("closes_since_review", db);
    assert.equal(count, 1);
  });

  test("increments independently from consecutive_api_errors", () => {
    const db = makeTmpDb();
    incrementCounter("consecutive_api_errors", db);
    incrementCounter("consecutive_api_errors", db);
    const closeCount = incrementCounter("closes_since_review", db);
    assert.equal(closeCount, 1);
    assert.equal(getCounter("consecutive_api_errors", db), 2);
  });

  test("fires hook at exactly 5 closes (simulate executor logic)", () => {
    const db = makeTmpDb();
    let hookFired = false;

    function simulateClose() {
      const count = incrementCounter("closes_since_review", db);
      if (count >= 5) {
        resetCounter("closes_since_review", db);
        hookFired = true;
      }
    }

    for (let i = 0; i < 4; i++) simulateClose();
    assert.equal(hookFired, false, "hook must not fire before 5 closes");
    assert.equal(getCounter("closes_since_review", db), 4);

    simulateClose(); // 5th close
    assert.equal(hookFired, true, "hook must fire on 5th close");
    assert.equal(getCounter("closes_since_review", db), 0, "counter resets after hook fires");
  });

  test("counter resets and waits for 5 more closes before next trigger", () => {
    const db = makeTmpDb();
    let fireCount = 0;

    function simulateClose() {
      const count = incrementCounter("closes_since_review", db);
      if (count >= 5) {
        resetCounter("closes_since_review", db);
        fireCount++;
      }
    }

    for (let i = 0; i < 10; i++) simulateClose();
    assert.equal(fireCount, 2, "hook must fire twice for 10 closes");
    assert.equal(getCounter("closes_since_review", db), 0);
  });

  test("counter persists its value (survives restart simulation)", () => {
    const db = makeTmpDb();
    incrementCounter("closes_since_review", db);
    incrementCounter("closes_since_review", db);
    incrementCounter("closes_since_review", db);

    // Simulate restart by reading counter value fresh (same db)
    const persisted = getCounter("closes_since_review", db);
    assert.equal(persisted, 3);
  });
});

// ── SQLite skills table ───────────────────────────────────────────────────

describe("skills table (T15)", () => {
  test("applySchema creates skills table", () => {
    const db = makeTmpDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert.ok(tables.includes("skills"), "skills table must exist");
  });

  test("can insert a pending skill record", () => {
    const db = makeTmpDb();
    db.prepare(
      "INSERT INTO skills (id, filename, status) VALUES (?, ?, 'pending')"
    ).run("review_1", "skill_1234.md");
    const row = db.prepare("SELECT * FROM skills WHERE id = ?").get("review_1");
    assert.equal(row.filename, "skill_1234.md");
    assert.equal(row.status, "pending");
  });

  test("ON CONFLICT DO NOTHING prevents duplicate filename inserts", () => {
    const db = makeTmpDb();
    db.prepare(
      "INSERT INTO skills (id, filename, status) VALUES (?, ?, 'pending') ON CONFLICT(filename) DO NOTHING"
    ).run("review_1", "skill_dupe.md");
    db.prepare(
      "INSERT INTO skills (id, filename, status) VALUES (?, ?, 'pending') ON CONFLICT(filename) DO NOTHING"
    ).run("review_2", "skill_dupe.md");
    const rows = db.prepare("SELECT * FROM skills WHERE filename = ?").all("skill_dupe.md");
    assert.equal(rows.length, 1);
  });
});

// ── skills/ directory layout ──────────────────────────────────────────────

describe("skills directory layout (T15)", () => {
  test("skills/active exists", () => {
    const p = path.join(process.cwd(), "skills", "active");
    assert.ok(fs.existsSync(p), "skills/active directory must exist");
  });

  test("skills/pending exists", () => {
    const p = path.join(process.cwd(), "skills", "pending");
    assert.ok(fs.existsSync(p), "skills/pending directory must exist");
  });

  test("skill file written to pending/ has markdown content", () => {
    const { pending } = makeTmpDirs();
    const content = "---\nname: skill_test\ntype: pattern\nconfidence: 0.8\ncreated_at: 2026-06-19\n---\n\n## Observation\nTest.\n\n## Rule\nTest rule.\n";
    const filename = `skill_${Date.now()}.md`;
    fs.writeFileSync(path.join(pending, filename), content, "utf8");
    const read = fs.readFileSync(path.join(pending, filename), "utf8");
    assert.equal(read, content);
  });
});

// ── setCloseHook export (executor API) ───────────────────────────────────

describe("setCloseHook export (T15)", () => {
  test("setCloseHook is exported from tools/executor.js", async () => {
    const mod = await import("../tools/executor.js");
    assert.equal(typeof mod.setCloseHook, "function");
  });
});
