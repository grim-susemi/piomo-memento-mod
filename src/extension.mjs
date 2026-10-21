import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, resolveAgentDir } from './config.mjs';
import { createReceipts } from './receipts.mjs';

export const REGISTRATION_KEY = Symbol.for('omo.memento.v1');
export const DISABLED_ENV = 'OMO_MEMENTO';
const CHILD_PATH = /(?:^|\/)senpi-task\/children(?:\/|$)/;
const SYNC_REASONS = new Set(['startup', 'new', 'resume']);

function normalizeSessionPath(file) {
  const normalized = file.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// A child path is conclusive before canonicalization, so a worker never runs
// lead behavior even when its file does not exist yet.
export function isChildSessionFile(file) {
  return typeof file === 'string' && file.length > 0 && CHILD_PATH.test(normalizeSessionPath(file));
}

/**
 * Lead, confirmed child, or unreadable identity. A non-child path whose
 * canonicalization fails unexpectedly is unknown, never lead.
 */
export function sessionIdentity(pi, ctx) {
  if (!pi || pi.sessionKind !== 'interactive') return 'child';
  if (ctx?.hasUI === false) return 'child';
  let file;
  try {
    file = ctx?.sessionManager?.getSessionFile?.();
  } catch {
    return 'unknown';
  }
  if (typeof file !== 'string' || file.length === 0) return 'lead';
  let absolute;
  try {
    absolute = resolve(file);
  } catch {
    return 'unknown';
  }
  if (isChildSessionFile(absolute)) return 'child';
  let canonical;
  try {
    canonical = normalizeSessionPath(realpathSync.native(absolute));
  } catch (error) {
    return error?.code === 'ENOENT' ? 'lead' : 'unknown';
  }
  return CHILD_PATH.test(canonical) ? 'child' : 'lead';
}

export function shouldSync(reason) {
  return reason === undefined || SYNC_REASONS.has(reason);
}

export default function extension(pi) {
  if (!pi || pi.sessionKind !== 'interactive') return undefined;
  const registration = globalThis[REGISTRATION_KEY] ??= {
    generation: 0, runtime: null, disabled: false,
  };
  if (process.env[DISABLED_ENV] === '0') {
    if (!registration.disabled) {
      registration.disabled = true;
      createReceipts({ agentDir: resolveAgentDir() }).append({ event: 'disabled-by-env' });
    }
    return undefined;
  }
  if (registration.runtime) return registration.runtime;

  const generation = ++registration.generation;
  const receipts = createReceipts();
  let identity = 'inactive';
  let config = null;

  const releaseSlot = () => {
    if (registration.runtime === runtime) registration.runtime = null;
  };
  const runtime = {
    generation,
    receipts,
    get identity() { return identity; },
    get active() { return identity === 'lead'; },
    get config() { return config; },
    getSessionStatus() { return identity; },
    reloadConfig(agentDir) {
      config = loadConfig({ agentDir });
      return config;
    },
  };
  registration.runtime = runtime;
  const isCurrent = () => registration.runtime === runtime;

  pi.on('session_start', async (_event, ctx) => {
    if (!isCurrent()) return;
    const next = sessionIdentity(pi, ctx);
    if (next !== 'lead') {
      identity = next;
      if (next === 'child') {
        config = null;
        releaseSlot();
      }
      return;
    }
    identity = 'lead';
    runtime.reloadConfig(typeof ctx?.agentDir === 'string' && ctx.agentDir.length > 0 ? ctx.agentDir : undefined);
  });

  pi.on('session_shutdown', async () => {
    if (!isCurrent()) return;
    identity = 'inactive';
    config = null;
    releaseSlot();
  });

  return runtime;
}
