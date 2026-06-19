import { getDb } from "../db/db.js";

export const DAILY_BUDGET_USD = 5.0;
export const LOW_SOL_THRESHOLD = 0.05;

// DeepSeek pricing per million tokens (approximate)
const MODEL_PRICING = {
  "deepseek-chat":     { input: 0.27, output: 1.10 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
};

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function estimateCost(model, tokensIn, tokensOut) {
  const p = MODEL_PRICING[model] ?? MODEL_PRICING["deepseek-chat"];
  return (tokensIn / 1_000_000) * p.input + (tokensOut / 1_000_000) * p.output;
}

export function recordUsage(model, tokensIn, tokensOut, db = getDb()) {
  if (!tokensIn && !tokensOut) return;
  const date = todayUtc();
  const cost = estimateCost(model, tokensIn, tokensOut);
  db.prepare(`
    INSERT INTO daily_usage (date, model, tokens_in, tokens_out, cost_usd)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date, model) DO UPDATE SET
      tokens_in  = tokens_in  + excluded.tokens_in,
      tokens_out = tokens_out + excluded.tokens_out,
      cost_usd   = cost_usd   + excluded.cost_usd
  `).run(date, model, tokensIn ?? 0, tokensOut ?? 0, cost);
}

export function getDailyUsage(date = todayUtc(), db = getDb()) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(tokens_in),0) as tokens_in,
           COALESCE(SUM(tokens_out),0) as tokens_out,
           COALESCE(SUM(cost_usd),0.0) as cost_usd
    FROM daily_usage WHERE date = ?
  `).get(date);
  return { date, tokens_in: Number(row.tokens_in), tokens_out: Number(row.tokens_out), cost_usd: Number(row.cost_usd) };
}

export function checkBudget(db = getDb()) {
  const usage = getDailyUsage(todayUtc(), db);
  if (usage.cost_usd >= DAILY_BUDGET_USD) {
    return {
      allowed: false,
      reason: `Daily token budget exceeded: $${usage.cost_usd.toFixed(4)} >= $${DAILY_BUDGET_USD}`,
      usage,
    };
  }
  return { allowed: true, usage };
}
