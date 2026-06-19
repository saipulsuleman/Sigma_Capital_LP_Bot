import { getDb } from "../db/db.js";
import { log } from "../logger.js";

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function getRow(db) {
  return db.prepare("SELECT * FROM circuit_breaker WHERE id = 1").get() ?? null;
}

function upsertRow(db, fields) {
  const cols = Object.keys(fields).join(", ");
  const placeholders = Object.keys(fields).map(() => "?").join(", ");
  const updates = Object.keys(fields).map((k) => `${k} = excluded.${k}`).join(", ");
  db.prepare(`
    INSERT INTO circuit_breaker (id, ${cols}) VALUES (1, ${placeholders})
    ON CONFLICT(id) DO UPDATE SET ${updates}
  `).run(...Object.values(fields));
}

/**
 * Ensure the circuit_breaker row exists with defaults.
 * Also resets daily_loss_usd if the UTC date has rolled over.
 */
export function initCircuit(db = getDb()) {
  const row = getRow(db);
  const today = todayUtc();

  if (!row) {
    db.prepare(`
      INSERT OR IGNORE INTO circuit_breaker (id, date_utc)
      VALUES (1, ?)
    `).run(today);
    return;
  }

  if (row.date_utc !== today) {
    db.prepare(`
      UPDATE circuit_breaker SET daily_loss_usd = 0.0, date_utc = ? WHERE id = 1
    `).run(today);
    log("circuit", `Daily loss reset for new UTC day (${today})`);
  }
}

/**
 * Record a position close event. Updates daily_loss_usd and consecutive_losses.
 * If a trigger threshold is now exceeded, marks circuit as triggered.
 * @param {{ pnl_usd?: number, config?: object }} opts
 * @returns {{ newly_triggered: boolean, reason: string|null }}
 */
export function recordClose(db = getDb(), { pnl_usd = 0, config = {} } = {}) {
  initCircuit(db);
  const row = getRow(db);
  if (!row) return { newly_triggered: false, reason: null };

  const wasTriggered = Boolean(row.triggered);
  let daily_loss_usd = row.daily_loss_usd;
  let consecutive_losses = row.consecutive_losses;

  if (pnl_usd < 0) {
    daily_loss_usd += Math.abs(pnl_usd);
    consecutive_losses += 1;
  } else {
    consecutive_losses = 0;
  }

  upsertRow(db, { daily_loss_usd, consecutive_losses, date_utc: todayUtc() });

  if (wasTriggered) return { newly_triggered: false, reason: null };

  const check = checkCircuit(db, config);
  if (check.triggered) {
    triggerCircuit(db, check.reason);
    return { newly_triggered: true, reason: check.reason };
  }
  return { newly_triggered: false, reason: null };
}

/**
 * Check current state against config thresholds.
 * Does NOT modify the DB — read-only check.
 * @param {object} config — { maxDailyLossUsd, maxConsecutiveLosses, maxDrawdownPct }
 * @returns {{ triggered: boolean, reason: string|null }}
 */
export function checkCircuit(db = getDb(), config = {}) {
  const row = getRow(db);
  if (!row) return { triggered: false, reason: null };

  if (Boolean(row.triggered)) {
    return { triggered: true, reason: row.trigger_reason ?? "unknown" };
  }

  const maxDailyLoss = config.maxDailyLossUsd ?? 5;
  const maxConsec    = config.maxConsecutiveLosses ?? 3;

  if (row.daily_loss_usd >= maxDailyLoss) {
    return { triggered: true, reason: `daily_loss_usd ${row.daily_loss_usd.toFixed(2)} >= ${maxDailyLoss}` };
  }
  if (row.consecutive_losses >= maxConsec) {
    return { triggered: true, reason: `consecutive_losses ${row.consecutive_losses} >= ${maxConsec}` };
  }

  return { triggered: false, reason: null };
}

/**
 * Set triggered flag with a reason (called internally by recordClose or manually).
 */
export function triggerCircuit(db = getDb(), reason = "manual") {
  upsertRow(db, {
    triggered: 1,
    trigger_reason: reason,
    triggered_at: new Date().toISOString(),
    date_utc: todayUtc(),
  });
  log("circuit", `Circuit breaker TRIGGERED: ${reason}`);
}

/**
 * Clear the triggered flag. Called by /resume Telegram command.
 * Also resets consecutive_losses since the user made an explicit decision to resume.
 */
export function resetCircuit(db = getDb()) {
  db.prepare(`
    UPDATE circuit_breaker
    SET triggered = 0, trigger_reason = NULL, triggered_at = NULL, consecutive_losses = 0
    WHERE id = 1
  `).run();
  log("circuit", "Circuit breaker RESET (manual)");
}

/**
 * Manually reset daily loss (e.g. called at UTC midnight via cron).
 */
export function resetDailyLoss(db = getDb()) {
  db.prepare(`
    UPDATE circuit_breaker SET daily_loss_usd = 0.0, date_utc = ? WHERE id = 1
  `).run(todayUtc());
}

/**
 * Update peak_portfolio_sol (called after a successful deploy when SOL is known).
 */
export function updatePeak(db = getDb(), portfolio_sol) {
  const row = getRow(db);
  if (!row) return;
  const newPeak = row.peak_portfolio_sol != null
    ? Math.max(row.peak_portfolio_sol, portfolio_sol)
    : portfolio_sol;
  db.prepare("UPDATE circuit_breaker SET peak_portfolio_sol = ? WHERE id = 1").run(newPeak);
}

/**
 * Get full circuit breaker status for the /circuit_status Telegram command.
 */
export function getCircuitStatus(db = getDb()) {
  initCircuit(db);
  return getRow(db) ?? {
    triggered: 0, trigger_reason: null, daily_loss_usd: 0, consecutive_losses: 0,
    peak_portfolio_sol: null, triggered_at: null, date_utc: todayUtc(),
  };
}
