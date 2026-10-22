import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBoardApi } from './api.mjs';
import { loadConfig, resolveAgentDir } from './config.mjs';
import { setSyncNow } from './intake/capture.mjs';
import { createIntake } from './intake/register.mjs';
import { createReceipts } from './receipts.mjs';
import { runSync } from './sync/run.mjs';
import { setRerunFlag } from './store/lock.mjs';

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

function sessionStartKey(ctx) {
  let id = '';
  let file = '';
  try { id = ctx?.sessionManager?.getSessionId?.() ?? ''; } catch {}
  try { file = ctx?.sessionManager?.getSessionFile?.() ?? ''; } catch {}
  let normalized = '';
  try { normalized = file ? normalizeSessionPath(resolve(file)) : ''; } catch {}
  return JSON.stringify([id, normalized]);
}

function sameEffectiveConfig(left, right) {
  if (!left || !right || left.state !== right.state) return false;
  return ['agentDir', 'configPath', 'repoPath', 'tokenFile', 'remote']
    .every((key) => (left[key] ?? null) === (right[key] ?? null));
}

function configStartKey(config) {
  return JSON.stringify([
    config?.state ?? null, config?.agentDir ?? null, config?.configPath ?? null,
    config?.repoPath ?? null, config?.tokenFile ?? null, config?.remote ?? null,
  ]);
}

export default function extension(pi, factoryOptions = {}) {
  if (!pi || pi.sessionKind !== 'interactive') return undefined;
  const client = factoryOptions && typeof factoryOptions === 'object' && factoryOptions.client
    ? factoryOptions.client
    : null;
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
  let intake = null;
  let syncController = null;
  let syncCtx = null;
  let activeStartKey = null;
  let boardApi = null;

  // The board API belongs to this runtime instance. It is published only in a
  // configured lead session and removed only while the slot holds its own object.
  const releaseApi = () => {
    if (!boardApi) return;
    boardApi.abort();
    boardApi.unpublish();
    boardApi = null;
  };

  const mountApi = () => {
    releaseApi();
    if (!config || config.state !== 'configured') return null;
    boardApi = createBoardApi({
      config,
      receipts,
      ...(client ? { client } : {}),
    });
    boardApi.publish();
    return boardApi;
  };

  const abortSync = () => {
    if (!syncController) {
      activeStartKey = null;
      return;
    }
    syncController.controller.abort();
    syncController = null;
    activeStartKey = null;
  };

  // One in-flight sync per process; a second request joins the first. The sync
  // starts on a lifecycle event and is never awaited by the handler.
  const startSync = (reason, { force = false, key = null } = {}) => {
    if (!force && !shouldSync(reason)) return null;
    if (syncController) return syncController.promise;
    if (!config || config.state !== 'configured') return null;
    const controller = new AbortController();
    const promise = runSync({
      reason: force ? 'command' : (reason ?? 'startup'),
      signal: controller.signal,
      config,
      ctx: syncCtx,
      receipts,
      ...(client ? { client } : {}),
    }).catch((error) => {
      receipts.append({ event: 'sync-failed', error: String(error?.name ?? 'error') });
      return { ok: false, reason: 'error' };
    });
    syncController = { controller, promise };
    activeStartKey = key;
    promise
      .finally(() => {
        if (syncController?.promise === promise) {
          syncController = null;
          activeStartKey = null;
        }
      })
      .catch(() => {});
    return promise;
  };

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

  pi.on('session_start', async (event, ctx) => {
    if (!isCurrent()) return;
    const next = sessionIdentity(pi, ctx);
    if (next !== 'lead') {
      // Any identity that is not proven lead revokes this runtime's write work.
      // A child also releases the registration; an unknown identity keeps it for
      // a later retry, which is not lead-write permission.
      identity = next;
      config = null;
      syncCtx = null;
      abortSync();
      releaseApi();
      setSyncNow(null);
      intake?.resetSession('');
      if (next === 'child') releaseSlot();
      return;
    }
    identity = 'lead';
    const agentDirArg = typeof ctx?.agentDir === 'string' && ctx.agentDir.length > 0
      ? ctx.agentDir
      : undefined;
    const nextConfig = loadConfig({ agentDir: agentDirArg });
    const nextSessionKey = sessionStartKey(ctx);
    if (syncController && activeStartKey && shouldSync(event?.reason)
      && (event?.reason ?? 'startup') === 'startup'
      && activeStartKey.reason === 'startup'
      && sameEffectiveConfig(config, nextConfig)
      && activeStartKey.session === nextSessionKey
      && activeStartKey.config === configStartKey(nextConfig)) {
      try {
        await setRerunFlag(config.repoPath);
        receipts.append({ event: 'sync-rerun-requested' });
      } catch (error) {
        receipts.append({ event: 'sync-rerun-failed', error: String(error?.code ?? error?.message ?? error) });
      }
      return;
    }
    syncCtx = ctx;
    abortSync();
    runtime.reloadConfig(agentDirArg);
    if (!config || config.state !== 'configured') {
      // Same owned teardown as an unproven identity: no stale syncNow callback or
      // API may outlive a configured -> unconfigured transition.
      syncCtx = null;
      abortSync();
      releaseApi();
      setSyncNow(null);
      return;
    }
    mountApi();
    const sessionId = ctx?.sessionManager?.getSessionId?.() ?? '';
    if (!intake) intake = createIntake({ getConfig: () => config, receipts, isActive: () => identity === 'lead' });
    if (event?.reason === 'reload') intake.setSessionId(sessionId);
    else intake.resetSession(sessionId);
    intake.register(pi);
    setSyncNow(() => startSync('command', { force: true }) ?? Promise.resolve({ ok: false, reason: 'not-started' }));
    const startKey = {
      session: nextSessionKey,
      config: configStartKey(config),
      reason: event?.reason ?? 'startup',
    };
    if (event?.reason !== 'reload') startSync(event?.reason, { key: startKey });
  });

  pi.on('session_shutdown', async () => {
    // Own-instance cleanup first: aborting this runtime's API continuations and
    // removing only its own published object is safe even for a stale instance.
    releaseApi();
    abortSync();
    if (!isCurrent()) return;
    identity = 'inactive';
    config = null;
    setSyncNow(null);
    intake?.resetSession('');
    releaseSlot();
  });

  return runtime;
}
