/**
 * T21 — 4-Tier Memory System: position memory service
 *
 * Tier 1 (Hot):    Last 5 closed positions — always in SCREENER prompt
 * Tier 2 (Skill):  skills/active/*.md — handled by existing T15/T16
 * Tier 3 (Cold):   Positions 6–90 days old — queryable via tool
 * Tier 4 (Forgotten): positions closed >90 days → status='archived'
 */

/**
 * Return the last N non-archived closed positions, ordered newest first.
 * Used for the Hot layer injected into every SCREENER prompt.
 *
 * @param {object} db  - DatabaseSync instance
 * @param {number} limit - Max positions to return (default 5)
 * @returns {Array<object>}
 */
export function getHotPositions(db, limit = 5) {
  return db
    .prepare(`
      SELECT pool_name, strategy, pnl_usd, pnl_pct, close_reason,
             amount_sol, deployed_at, closed_at, fees_earned_usd
      FROM positions
      WHERE status != 'archived'
        AND closed_at IS NOT NULL
      ORDER BY closed_at DESC
      LIMIT ?
    `)
    .all(limit);
}

/**
 * Query position memory with optional filters.
 * Returns top-5 matching non-archived positions ordered by closed_at DESC.
 *
 * @param {object} db
 * @param {{ pool_name?: string, outcome?: 'win'|'loss', hours_back?: number, limit?: number }} filters
 * @returns {Array<object>}
 */
export function queryPositionMemory(db, { pool_name, outcome, hours_back, limit = 5 } = {}) {
  const conditions = ["status != 'archived'", "closed_at IS NOT NULL"];
  const params = [];

  if (pool_name) {
    conditions.push("pool_name LIKE ?");
    params.push(`%${pool_name}%`);
  }

  if (outcome === "win") {
    conditions.push("pnl_usd > 0");
  } else if (outcome === "loss") {
    conditions.push("pnl_usd <= 0");
  }

  if (hours_back != null && hours_back > 0) {
    conditions.push("closed_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)")
    params.push(`-${hours_back} hours`);
  }

  params.push(Math.min(limit, 20));

  const sql = `
    SELECT pool_name, strategy, pnl_usd, pnl_pct, close_reason,
           amount_sol, deployed_at, closed_at, fees_earned_usd
    FROM positions
    WHERE ${conditions.join(" AND ")}
    ORDER BY closed_at DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(...params);
}

/**
 * Archive positions closed more than `days` days ago by setting status='archived'.
 * Called daily by the archive cron in index.js.
 *
 * @param {object} db
 * @param {number} days - Archive threshold (default 90)
 * @returns {number} - Count of rows archived
 */
export function archiveOldPositions(db, days = 90) {
  const result = db
    .prepare(`
      UPDATE positions
      SET status = 'archived'
      WHERE status = 'active'
        AND closed_at IS NOT NULL
        AND closed_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
    `)
    .run(`-${days} days`);
  return result.changes;
}
