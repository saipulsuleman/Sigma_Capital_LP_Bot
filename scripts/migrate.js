/**
 * One-time migration: JSON state files → SQLite.
 *
 * Backup-first safety protocol (D3 + D9):
 *   1. Copy source JSON files to .bak
 *   2. Create SQLite + apply schema
 *   3. Migrate data
 *   4. Verify row counts match source
 *   5. On success: write meta row (migration_version=1)
 *   6. On failure: close + DELETE partial SQLite, keep .bak for next retry
 *
 * Source JSON files are NOT deleted after migration because the existing
 * codebase (lessons.js, decision-log.js) still reads/writes them.
 * Those files will be updated to use SQLite in later tasks.
 * Run this script once before or during Fase 2 deployment.
 *
 * Usage: node scripts/migrate.js
 * Re-running is safe — skips if migration_version already set.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { repoPath } from "../repo-root.js";
import { openDb, applySchema, setMeta, getMeta, setCounter } from "../db/db.js";

// ─── Configurable paths (overridable for tests) ────────────────────

export function buildPaths({
  lessonsPath = repoPath("lessons.json"),
  decisionLogPath = repoPath("decision-log.json"),
  dbPath = repoPath("db/sigma.db"),
} = {}) {
  return {
    lessonsPath,
    decisionLogPath,
    dbPath,
    lessonsBakPath: lessonsPath + ".bak",
    decisionLogBakPath: decisionLogPath + ".bak",
  };
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function backup(srcPath, bakPath) {
  if (!fs.existsSync(srcPath)) return;
  fs.copyFileSync(srcPath, bakPath);
}

function rowCount(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get().n);
}

// ─── Main migration function ───────────────────────────────────────

export function runMigration(paths = buildPaths()) {
  const { lessonsPath, decisionLogPath, dbPath, lessonsBakPath, decisionLogBakPath } = paths;

  // Open or create DB to check if already migrated
  const db = openDb(dbPath);
  applySchema(db);

  if (getMeta("migration_version", db) === "1") {
    console.log("[migrate] Already migrated — skipping.");
    db.close();
    return { skipped: true };
  }

  // Step 1: backup source files
  backup(lessonsPath, lessonsBakPath);
  backup(decisionLogPath, decisionLogBakPath);
  console.log("[migrate] Backups created.");

  // Step 2: initialize required counters (idempotent)
  setCounter("consecutive_api_errors", 0, db);
  setCounter("closes_since_review", 0, db);

  // Step 3: load source data
  const lessonsData = readJson(lessonsPath, { lessons: [], performance: [] });
  const decisionData = readJson(decisionLogPath, { decisions: [] });

  const sourcePositions = Array.isArray(lessonsData.performance) ? lessonsData.performance : [];
  const sourceLessons   = Array.isArray(lessonsData.lessons)     ? lessonsData.lessons     : [];
  const sourceDecisions = Array.isArray(decisionData.decisions)  ? decisionData.decisions  : [];

  let ok = false;
  try {
    // Step 4: migrate in a single transaction
    db.exec("BEGIN");

    // positions (from lessons.json → performance)
    const insPos = db.prepare(`
      INSERT OR IGNORE INTO positions
        (id, position, pool, pool_name, strategy, pnl_usd, pnl_pct,
         range_efficiency, amount_sol, fees_earned_usd, close_reason,
         deployed_at, closed_at, raw)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const [i, p] of sourcePositions.entries()) {
      const id = p.position ?? `pos_migrated_${i}`;
      insPos.run(
        id,
        p.position ?? null,
        p.pool ?? "unknown",
        p.pool_name ?? null,
        p.strategy ?? null,
        p.pnl_usd ?? null,
        p.pnl_pct ?? null,
        p.range_efficiency ?? null,
        p.amount_sol ?? null,
        p.fees_earned_usd ?? null,
        p.close_reason ?? null,
        p.deployed_at ?? null,
        p.recorded_at ?? null,
        JSON.stringify(p),
      );
    }

    // lessons (from lessons.json → lessons)
    const insLesson = db.prepare(`
      INSERT OR IGNORE INTO lessons (id, rule, confidence, type, recorded_at, raw)
      VALUES (?,?,?,?,?,?)
    `);
    for (const [i, l] of sourceLessons.entries()) {
      insLesson.run(
        l.id ?? `lesson_migrated_${i}`,
        l.rule ?? null,
        l.confidence ?? null,
        l.type ?? null,
        l.recorded_at ?? null,
        JSON.stringify(l),
      );
    }

    // decisions (from decision-log.json → decisions)
    const insDec = db.prepare(`
      INSERT OR IGNORE INTO decisions
        (id, ts, type, actor, pool, pool_name, position, summary, reason, risks, metrics, rejected)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const d of sourceDecisions) {
      insDec.run(
        d.id ?? `dec_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        d.ts ?? new Date().toISOString(),
        d.type ?? null,
        d.actor ?? null,
        d.pool ?? null,
        d.pool_name ?? null,
        d.position ?? null,
        d.summary ?? null,
        d.reason ?? null,
        d.risks  ? JSON.stringify(d.risks)    : null,
        d.metrics ? JSON.stringify(d.metrics) : null,
        d.rejected ? JSON.stringify(d.rejected) : null,
      );
    }

    db.exec("COMMIT");

    // Step 5: verify row counts
    const dbPositions = rowCount(db, "positions");
    const dbLessons   = rowCount(db, "lessons");
    const dbDecisions = rowCount(db, "decisions");

    if (
      dbPositions < sourcePositions.length ||
      dbLessons   < sourceLessons.length   ||
      dbDecisions < sourceDecisions.length
    ) {
      throw new Error(
        `Row count mismatch after migration: ` +
        `positions ${dbPositions}/${sourcePositions.length}, ` +
        `lessons ${dbLessons}/${sourceLessons.length}, ` +
        `decisions ${dbDecisions}/${sourceDecisions.length}`
      );
    }

    // Step 6: mark complete
    setMeta("migration_version", "1", db);
    setMeta("migrated_at", new Date().toISOString(), db);
    ok = true;

    console.log(
      `[migrate] Done. positions=${dbPositions} lessons=${dbLessons} decisions=${dbDecisions}`
    );

    db.close();
    return { positions: dbPositions, lessons: dbLessons, decisions: dbDecisions };

  } finally {
    if (!ok) {
      try { db.exec("ROLLBACK"); } catch {}
      try { db.close(); } catch {}
      // D9: delete the partial SQLite — next startup retries cleanly from .bak
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
        // Also remove WAL/SHM files left by WAL mode
        for (const ext of ["-wal", "-shm"]) {
          const f = dbPath + ext;
          if (fs.existsSync(f)) fs.unlinkSync(f);
        }
      }
      console.error("[migrate] FAILED — SQLite deleted. Bot will boot on JSON files. Retry on next start.");
    }
  }
}

// ─── CLI entry point ──────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("migrate.js")) {
  try {
    runMigration();
  } catch (err) {
    console.error("[migrate] Error:", err.message);
    process.exit(1);
  }
}
