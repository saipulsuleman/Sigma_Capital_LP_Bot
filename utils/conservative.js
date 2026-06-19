import { getCounter, incrementCounter, resetCounter } from "../db/db.js";

export const CONSERVATIVE_THRESHOLD = 3;

export function isConservativeMode(db = undefined) {
  return getCounter("consecutive_api_errors", db) >= CONSERVATIVE_THRESHOLD;
}

export function recordApiError(db = undefined) {
  incrementCounter("consecutive_api_errors", db);
}

export function recordApiSuccess(db = undefined) {
  resetCounter("consecutive_api_errors", db);
}
