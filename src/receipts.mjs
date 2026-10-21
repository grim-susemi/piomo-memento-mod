import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveAgentDir } from './config.mjs';

export const RECEIPT_LOG = 'memento.jsonl';

export function receiptPathFor(agentDir) {
  return agentDir ? join(agentDir, 'logs', RECEIPT_LOG) : null;
}

// The token is checked in property names as well as string values, nested and
// inside arrays, before anything is serialized. A token that is not loaded
// (null) leaves entries untouched; the token itself is never logged.
function containsToken(value, token, seen = new WeakSet()) {
  if (typeof value === 'string') return value.includes(token);
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => containsToken(item, token, seen));
  for (const [key, item] of Object.entries(value)) {
    if (key.includes(token)) return true;
    if (containsToken(item, token, seen)) return true;
  }
  return false;
}

/**
 * Append-only JSONL receipts at <agentDir>/logs/memento.jsonl. `getToken` is
 * called per append. An entry carrying the token in any key or value is refused
 * whole: append returns false and writes no line. Failures are reported once
 * and never thrown to the caller.
 */
export function createReceipts({ agentDir = resolveAgentDir(), getToken = null } = {}) {
  const path = receiptPathFor(agentDir);
  let failureReported = false;
  return {
    path,
    append(entry) {
      if (!path) return false;
      let line;
      try {
        const token = typeof getToken === 'function' ? getToken() : null;
        const secret = typeof token === 'string' ? token.trim() : '';
        if (secret && containsToken(entry, secret)) return false;
        line = JSON.stringify({ at: new Date().toISOString(), ...entry });
      } catch (error) {
        if (!failureReported) {
          failureReported = true;
          console.error(`memento receipt write failed: ${error.message}`);
        }
        return false;
      }
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${line}\n`);
        return true;
      } catch (error) {
        if (!failureReported) {
          failureReported = true;
          console.error(`memento receipt write failed: ${error.message}`);
        }
        return false;
      }
    },
  };
}
