import { Connection } from "@solana/web3.js";
import { log } from "../logger.js";

const BACKOFF_MS = [100, 200, 400];
const WINDOW_MS = 60 * 60 * 1000;

// Rolling window for error rate (1hr)
const _callTs = [];
const _errTs = [];
let _alertArmed = true;

export function _resetForTest() {
  _callTs.length = 0;
  _errTs.length = 0;
  _alertArmed = true;
}

function _prune() {
  const cut = Date.now() - WINDOW_MS;
  while (_callTs.length && _callTs[0] < cut) _callTs.shift();
  while (_errTs.length && _errTs[0] < cut) _errTs.shift();
}

export function _trackCall() { _callTs.push(Date.now()); _prune(); }
export function _trackError() { _errTs.push(Date.now()); _prune(); }

export function getErrorRate() {
  _prune();
  return _callTs.length ? _errTs.length / _callTs.length : 0;
}

async function _sendAlert(rate) {
  try {
    const { sendMessage } = await import("../telegram.js");
    await sendMessage(
      `⚠️ RPC error rate: ${(rate * 100).toFixed(0)}% in the last hour. ` +
      `Check Helius connectivity or set fallbackRpcUrl in user-config.json.`
    );
  } catch { /* Telegram not configured */ }
}

export async function withRetry(primaryFn, fallbackFn = null, { backoff = BACKOFF_MS } = {}) {
  let lastErr;
  for (let i = 0; i < backoff.length; i++) {
    try {
      _trackCall();
      const result = await primaryFn();
      _alertArmed = true;
      return result;
    } catch (err) {
      lastErr = err;
      _trackError();
      const rate = getErrorRate();
      if (rate > 0.1 && _alertArmed) {
        _alertArmed = false;
        _sendAlert(rate); // fire-and-forget
      }
      if (i < backoff.length - 1) await new Promise(r => setTimeout(r, backoff[i]));
    }
  }
  if (fallbackFn) {
    log("rpc", "Primary RPC exhausted — trying fallback");
    return fallbackFn();
  }
  throw lastErr;
}

let _primary = null;
let _fallback = null;

export function createResilientConnection(primaryUrl, fallbackUrl) {
  if (!_primary) _primary = new Connection(primaryUrl, "confirmed");
  if (fallbackUrl && !_fallback) _fallback = new Connection(fallbackUrl, "confirmed");

  const primary = _primary;
  const fallback = _fallback;

  return new Proxy(primary, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if (typeof val !== "function") return val;
      const fallbackProp = fallback && typeof fallback[prop] === "function"
        ? fallback[prop].bind(fallback)
        : null;
      return (...args) => withRetry(
        () => val.apply(target, args),
        fallbackProp ? () => fallbackProp(...args) : null
      );
    },
  });
}
