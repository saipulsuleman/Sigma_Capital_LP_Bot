/**
 * T5: Verify MANAGER_TOOLS set contains get_wallet_positions.
 * T6: Verify model config does not reference MiniMax model IDs.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBlockedDuplicateCallIds } from "../agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("findBlockedDuplicateCallIds — same-response deploy-lock", () => {
  const ONCE = new Set(["deploy_position", "swap_token", "close_position"]);
  const call = (id, name) => ({ id, function: { name } });

  test("blocks the 2nd of two deploy_position calls in one response", () => {
    const blocked = findBlockedDuplicateCallIds(
      [call("a", "deploy_position"), call("b", "deploy_position")], ONCE);
    assert.equal(blocked.has("a"), false, "first deploy runs");
    assert.equal(blocked.has("b"), true, "second deploy blocked");
  });

  test("does not block a single deploy_position", () => {
    const blocked = findBlockedDuplicateCallIds([call("a", "deploy_position")], ONCE);
    assert.equal(blocked.size, 0);
  });

  test("does not block distinct once-per-session tools", () => {
    const blocked = findBlockedDuplicateCallIds(
      [call("a", "deploy_position"), call("b", "swap_token")], ONCE);
    assert.equal(blocked.size, 0);
  });

  test("does not block repeated non-once tools (read-only reads)", () => {
    const blocked = findBlockedDuplicateCallIds(
      [call("a", "get_active_bin"), call("b", "get_active_bin")], ONCE);
    assert.equal(blocked.size, 0);
  });

  test("blocks 2nd+ even with hermes-style name suffix", () => {
    const blocked = findBlockedDuplicateCallIds(
      [call("a", "deploy_position<extra"), call("b", "deploy_position")], ONCE);
    assert.equal(blocked.has("a"), false);
    assert.equal(blocked.has("b"), true);
  });

  test("handles null/empty input without throwing", () => {
    assert.equal(findBlockedDuplicateCallIds(null, ONCE).size, 0);
    assert.equal(findBlockedDuplicateCallIds([], ONCE).size, 0);
  });
});

describe("range strategy aligned with IL economics (source regression)", () => {
  test("MIN_SAFE_BINS_BELOW lowered to allow narrow (low-IL) ranges", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
    const m = src.match(/MIN_SAFE_BINS_BELOW\s*=\s*(\d+)/);
    assert.ok(m, "MIN_SAFE_BINS_BELOW must be defined");
    assert.ok(Number(m[1]) <= 12, `MIN_SAFE_BINS_BELOW should allow narrow ranges, got ${m[1]}`);
  });

  test("SCREENER prompt no longer advises maximizing bins_below", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "prompt.js"), "utf8");
    assert.ok(!/bias toward MAX bins_below/i.test(src), "prompt must not tell the LLM to maximize range (that maximizes IL)");
    assert.ok(/HIGH volatility/.test(src) && /NARROW range/i.test(src), "prompt must advise narrow range for volatile pools");
  });
});

describe("agent.js null-args guard (source regression)", () => {
  test("rejects non-object functionArgs before execution", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "agent.js"), "utf8");
    assert.ok(
      src.includes('typeof functionArgs !== "object"'),
      "agent.js must guard against null/non-object tool args"
    );
  });
});

describe("MANAGER_TOOLS (T5)", () => {
  test("agent.js MANAGER_TOOLS includes get_wallet_positions", async () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "agent.js"), "utf8");
    // Match the MANAGER_TOOLS Set definition line
    const match = src.match(/const MANAGER_TOOLS\s*=\s*new Set\(\[([^\]]+)\]\)/);
    assert.ok(match, "MANAGER_TOOLS Set definition should exist");
    const tools = match[1].split(",").map((s) => s.trim().replace(/"/g, ""));
    assert.ok(
      tools.includes("get_wallet_positions"),
      `MANAGER_TOOLS should include get_wallet_positions, got: [${tools.join(", ")}]`
    );
  });
});

describe("Model config (T6)", () => {
  test("user-config.example.json uses DeepSeek model IDs, not MiniMax", () => {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "user-config.example.json"), "utf8")
    );
    for (const field of ["managementModel", "screeningModel", "generalModel", "llmModel"]) {
      if (cfg[field] == null) continue;
      assert.ok(
        !cfg[field].includes("minimax"),
        `${field} should not reference minimax model: got "${cfg[field]}"`
      );
    }
  });

  test("user-config.example.json llmBaseUrl points to DeepSeek API", () => {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "user-config.example.json"), "utf8")
    );
    if (cfg.llmBaseUrl) {
      assert.ok(
        cfg.llmBaseUrl.includes("deepseek"),
        `llmBaseUrl should reference DeepSeek, got "${cfg.llmBaseUrl}"`
      );
    }
  });

  test("shouldUseLpAgentRelay regression: dlmm.js must not read config.api", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "tools", "dlmm.js"), "utf8");
    assert.ok(
      !src.includes("config.api.lpAgentRelayEnabled"),
      "dlmm.js must not reference removed config.api.lpAgentRelayEnabled"
    );
  });

  test("shouldUsePnlRecheck regression: index.js must not read config.api", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    assert.ok(
      !src.includes("config.api.lpAgentRelayEnabled"),
      "index.js must not reference removed config.api.lpAgentRelayEnabled"
    );
  });
});
