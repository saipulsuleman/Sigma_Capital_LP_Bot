import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoPath } from "../repo-root.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DB_PATH = repoPath("db/sigma.db");
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

// ─── Connection factory ───────────────────────────────────────────

export function openDb(dbPath = DEFAULT_DB_PATH) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  return db;
}

export function applySchema(db) {
  const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
  db.exec(sql);
}

/**
 * Additive migrations for existing DBs.
 * Each migration is idempotent — catches "duplicate column" errors silently.
 * Called after applySchema() so new DBs already have the columns.
 */
export function runMigrations(db) {
  const addColumns = [
    "ALTER TABLE positions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    "ALTER TABLE paper_positions ADD COLUMN entry_fee_rate_24h REAL",
    "ALTER TABLE paper_positions ADD COLUMN position_type TEXT DEFAULT 'meme'",
  ];
  for (const sql of addColumns) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
}

// ─── App-level singleton ──────────────────────────────────────────

let _db = null;

export function getDb() {
  if (!_db) {
    _db = openDb();
    applySchema(_db);
    runMigrations(_db);
  }
  return _db;
}

export function closeDb() {
  if (!_db) return;
  try { _db.close(); } catch {}
  _db = null;
}

// ─── Counter helpers ──────────────────────────────────────────────
// Use for: consecutive_api_errors, closes_since_review, closes_since_compound

export function getCounter(key, db = getDb()) {
  const row = db.prepare("SELECT value FROM counters WHERE key = ?").get(key);
  return row ? Number(row.value) : 0;
}

export function setCounter(key, value, db = getDb()) {
  db.prepare("INSERT OR REPLACE INTO counters(key, value) VALUES (?,?)").run(key, value);
}

export function incrementCounter(key, db = getDb()) {
  db.prepare(
    "INSERT INTO counters(key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1"
  ).run(key);
  const row = db.prepare("SELECT value FROM counters WHERE key = ?").get(key);
  return row ? Number(row.value) : 1;
}

export function resetCounter(key, db = getDb()) {
  setCounter(key, 0, db);
}

// ─── Meta helpers ─────────────────────────────────────────────────

export function getMeta(key, db = getDb()) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setMeta(key, value, db = getDb()) {
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?,?)").run(key, value == null ? null : String(value));
}
