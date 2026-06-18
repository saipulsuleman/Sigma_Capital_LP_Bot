/**
 * Pool metadata sanitization before LLM prompt injection.
 *
 * Token names and descriptions come from on-chain data and are untrusted.
 * Strip control chars and angle brackets to neutralize prompt injection attempts.
 */

const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/g;
const ANGLE_BRACKET_RE = /[<>]/g;

function clean(value, maxLen) {
  if (value == null) return value;
  return String(value)
    .replace(CONTROL_CHAR_RE, " ")
    .replace(ANGLE_BRACKET_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

export function sanitizeName(value)        { return clean(value, 50); }
export function sanitizeSymbol(value)      { return clean(value, 20); }
export function sanitizeDescription(value) { return clean(value, 200); }
export function sanitizeNarrative(value)   { return clean(value, 500); }

/**
 * Sanitize a pool/token metadata object in-place (returns new object).
 * Applies per-field length limits and strips injection-risk characters.
 */
export function sanitizeMetadata(meta) {
  if (!meta || typeof meta !== "object") return meta;
  const out = { ...meta };
  if (out.name        != null) out.name        = sanitizeName(out.name);
  if (out.pool_name   != null) out.pool_name   = sanitizeName(out.pool_name);
  if (out.symbol      != null) out.symbol      = sanitizeSymbol(out.symbol);
  if (out.description != null) out.description = sanitizeDescription(out.description);
  if (out.narrative   != null) out.narrative   = sanitizeNarrative(out.narrative);
  return out;
}
