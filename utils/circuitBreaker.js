import { getDb, getMeta, setMeta } from "../db/db.js";
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
export function recordClose(db = getDb(), { pnl_usd = 0, current_sol = null, config = {} } = {}) {
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

  // Atomic: rolling 7d meta writes + circuit_breaker row update in one transaction
  // so a crash between them can't leave inconsistent state (e.g. rolling loss advanced but daily_loss not)
  db.transaction(() => {
    if (pnl_usd < 0) {
      // Rolling 7-day loss tracker — prevents $4.99/day bleed going undetected across UTC midnight resets
      const loss = Math.abs(pnl_usd);
      const nowEpoch = Math.floor(Date.now() / 1000);
      const SEVEN_DAYS = 7 * 24 * 3600;
      const startEpochStr = getMeta("rolling_7d_start_epoch", db);
      if (!startEpochStr || (nowEpoch - Number(startEpochStr)) > SEVEN_DAYS) {
        setMeta("rolling_7d_start_epoch", String(nowEpoch), db);
        setMeta("rolling_7d_loss_usd", loss.toFixed(4), db);
      } else {
        const prev = Number(getMeta("rolling_7d_loss_usd", db) ?? 0);
        setMeta("rolling_7d_loss_usd", (prev + loss).toFixed(4), db);
      }
    }
    upsertRow(db, { daily_loss_usd, consecutive_losses, date_utc: todayUtc() });
  })();

  if (wasTriggered) return { newly_triggered: false, reason: null };

  const check = checkCircuit(db, config, current_sol);
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
 * @param {number|null} current_sol — current portfolio SOL value for drawdown check; null = skip drawdown
 * @returns {{ triggered: boolean, reason: string|null }}
 */
export function checkCircuit(db = getDb(), config = {}, current_sol = null) {
  const row = getRow(db);
  if (!row) return { triggered: false, reason: null };

  if (Boolean(row.triggered)) {
    return { triggered: true, reason: row.trigger_reason ?? "unknown" };
  }

  const maxDailyLoss = config.maxDailyLossUsd ?? 5;
  const maxConsec    = config.maxConsecutiveLosses ?? 3;
  const maxDrawdown  = config.maxDrawdownPct ?? 20;

  if (row.daily_loss_usd >= maxDailyLoss) {
    return { triggered: true, reason: `daily_loss_usd ${row.daily_loss_usd.toFixed(2)} >= ${maxDailyLoss}` };
  }
  if (row.consecutive_losses >= maxConsec) {
    return { triggered: true, reason: `consecutive_losses ${row.consecutive_losses} >= ${maxConsec}` };
  }
  // Rolling 7-day loss check — catches $4.99/day bleed that resets daily bucket each UTC midnight
  const maxWeeklyLoss = config.maxWeeklyLossUsd ?? 25;
  const rollingLoss = Number(getMeta("rolling_7d_loss_usd", db) ?? 0);
  if (rollingLoss >= maxWeeklyLoss) {
    return { triggered: true, reason: `rolling_7d_loss_usd ${rollingLoss.toFixed(2)} >= ${maxWeeklyLoss}` };
  }
  // Drawdown check — only when both peak and current SOL are known
  if (row.peak_portfolio_sol != null && current_sol != null && row.peak_portfolio_sol > 0) {
    const drawdownPct = (row.peak_portfolio_sol - current_sol) / row.peak_portfolio_sol * 100;
    if (drawdownPct >= maxDrawdown) {
      return { triggered: true, reason: `drawdown ${drawdownPct.toFixed(1)}% >= ${maxDrawdown}% (peak=${row.peak_portfolio_sol.toFixed(3)} SOL)` };
    }
  }

  return { triggered: false, reason: null };
}

// Hook called asynchronously when circuit fires — registered from index.js to avoid circular dep
let _liquidationHook = null;
export function setLiquidationHook(fn) { _liquidationHook = fn; }

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
  if (_liquidationHook) {
    Promise.resolve().then(() => _liquidationHook()).catch((e) =>
      log("circuit_warn", `Auto-liquidation hook failed: ${e.stack || e.message}`)
    );
  }
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
