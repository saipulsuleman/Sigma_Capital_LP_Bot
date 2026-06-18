// LPAgent / agentmeridian.xyz integration — DISABLED in this fork.
// All functions return no-op stubs so tools that import them don't crash.
// Real Meteora execution uses the @meteora-ag/dlmm SDK directly (Fase 1+).

export function getAgentMeridianBase() {
  return "";
}

export function getAgentMeridianHeaders({ json = false } = {}) {
  const headers = {};
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

export function getAgentIdForRequests() {
  return "agent-local";
}

export async function agentMeridianJson(pathname) {
  throw new Error(`LPAgent disabled — ${pathname} not available in this fork`);
}
