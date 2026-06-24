import fs from "fs";
import path from "path";
import { getDb } from "../db/db.js";
import { repoPath } from "../repo-root.js";
import { log } from "../logger.js";
import { agentLoop } from "../agent.js";
import { config } from "../config.js";

const SKILLS_ACTIVE  = repoPath("skills/active");
const SKILLS_PENDING = repoPath("skills/pending");

/**
 * Load approved skill files (skills/active/*.md) as a compact prompt block.
 * Returns null when there are none. Injected into the SCREENER/MANAGER system
 * prompt so human-approved skills actually influence decisions — without this the
 * REVIEW → approve → skills/active feedback loop was open (skills written, never read).
 *
 * @param {object} opts
 * @param {number} [opts.max=5]      - newest N skill files
 * @param {number} [opts.charCap=400] - chars per skill
 */
export function loadActiveSkills({ max = 5, charCap = 400 } = {}) {
  if (!fs.existsSync(SKILLS_ACTIVE)) return null;
  let files;
  try {
    files = fs.readdirSync(SKILLS_ACTIVE).filter((f) => f.endsWith(".md")).sort().reverse().slice(0, max);
  } catch { return null; }
  if (files.length === 0) return null;
  const snippets = [];
  for (const f of files) {
    try {
      const txt = fs.readFileSync(path.join(SKILLS_ACTIVE, f), "utf8").trim();
      if (txt) snippets.push(txt.slice(0, charCap));
    } catch { /* skip unreadable file */ }
  }
  return snippets.length ? snippets.join("\n\n") : null;
}

export async function runReviewAgent() {
  log("review", "REVIEW Agent triggered — analysing last closes");

  try {
    const db = getDb();

    // Last 10 closed positions — paper_positions in DRY_RUN, live positions otherwise
    const isDryRun = process.env.DRY_RUN === "true";
    const positions = isDryRun
      ? db.prepare(`
          SELECT pool_name,
                 position_type      AS strategy,
                 simulated_pnl_sol * 145 AS pnl_usd,
                 exit_reason        AS close_reason,
                 exit_time          AS closed_at,
                 amount_sol
          FROM paper_positions
          WHERE status = 'closed'
          ORDER BY exit_time DESC
          LIMIT 10
        `).all()
      : db.prepare(`
          SELECT pool_name, pnl_usd, pnl_pct, strategy, close_reason, closed_at
          FROM positions
          ORDER BY closed_at DESC
          LIMIT 10
        `).all();

    // Up to 5 most-recent active skill files (400 chars each for context)
    const activeSkillSnippets = [];
    if (fs.existsSync(SKILLS_ACTIVE)) {
      const files = fs.readdirSync(SKILLS_ACTIVE)
        .filter(f => f.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, 5);
      for (const f of files) {
        try {
          const txt = fs.readFileSync(path.join(SKILLS_ACTIVE, f), "utf8");
          activeSkillSnippets.push(`--- ${f} ---\n${txt.slice(0, 400)}`);
        } catch (e) { log("review_warn", `Could not read skill file ${f}: ${e.message}`); }
      }
    }

    const positionSummary = positions.length === 0
      ? "No closed positions in database yet."
      : positions.map(p => {
          const pnlStr = p.pnl_usd != null ? `$${Number(p.pnl_usd).toFixed(2)}` : "?";
          const pctStr = p.pnl_pct != null ? ` (${Number(p.pnl_pct).toFixed(1)}%)` : "";
          return `- ${p.pool_name || "Unknown"}: PnL ${pnlStr}${pctStr}, ` +
            `strategy=${p.strategy || "unknown"}, reason=${p.close_reason || "unknown"}, ` +
            `date=${(p.closed_at || "").slice(0, 10)}`;
        }).join("\n");

    const skillSummary = activeSkillSnippets.length === 0
      ? "No active skills yet — this is the first REVIEW cycle."
      : activeSkillSnippets.join("\n\n");

    const today = new Date().toISOString().slice(0, 10);
    const prompt = [
      "You are the REVIEW agent for Sigma Capital LP Bot, an autonomous DLMM liquidity provider on Solana.",
      "Your job: analyse the recent closed positions and existing skill files, then write exactly ONE new skill file.",
      "Do not call any tools. Output only the skill file content, nothing else.",
      "",
      `Date: ${today}`,
      "",
      "Recent closed positions (last 10):",
      positionSummary,
      "",
      "Existing active skills:",
      skillSummary,
      "",
      "Write exactly ONE new skill file using this format:",
      "---",
      "name: skill_<short_slug>",
      "type: pattern|risk|timing|exit",
      "confidence: 0.0-1.0",
      `created_at: ${today}`,
      "---",
      "",
      "## Observation",
      "[1-2 sentences: what pattern do you notice in the closed positions?]",
      "",
      "## Rule",
      "[1 actionable sentence the bot should apply when screening or managing positions]",
      "",
      "## Evidence",
      "[bullet points citing specific positions from the data above]",
    ].join("\n");

    const model = config.llm?.managementModel ?? null;
    const skillContent = await agentLoop(prompt, 1, [], "GENERAL", model, 512);

    // Write to skills/pending/
    if (!fs.existsSync(SKILLS_PENDING)) fs.mkdirSync(SKILLS_PENDING, { recursive: true });
    const ts = Date.now();
    const filename = `skill_${ts}.md`;
    fs.writeFileSync(path.join(SKILLS_PENDING, filename), skillContent, "utf8");

    // Record in SQLite skills table
    db.prepare(
      "INSERT INTO skills (id, filename, status) VALUES (?, ?, 'pending') ON CONFLICT(filename) DO NOTHING"
    ).run(`review_${ts}`, filename);

    log("review", `REVIEW skill written → skills/pending/${filename}`);

    // Telegram notification for T16 approval flow
    try {
      const { sendMessage } = await import("../telegram.js");
      const preview = skillContent.slice(0, 280).replace(/\n/g, " ");
      await sendMessage(
        `REVIEW: new skill generated.\nFile: ${filename}\nPreview: ${preview}\n\nApprove: /approve_skill ${filename}`
      );
    } catch (e) { log("review_warn", `Telegram skill notify failed — skill ${filename} awaits manual approval: ${e.message}`); }
  } catch (e) {
    log("review_error", `REVIEW Agent failed: ${e.message}`);
    try {
      const { sendMessage } = await import("../telegram.js");
      await sendMessage(`REVIEW Agent failed: ${e.message}`);
    } catch {}
  }
}
