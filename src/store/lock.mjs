import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const STALE_MS = 5 * 60 * 1000;
export const LOCK_FILES = Object.freeze({ sync: 'sync.lock', write: 'write.lock' });
export const RERUN_NAME = 'rerun';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const FIRST_DELAY_MS = 10;
const MAX_DELAY_MS = 500;
const MAX_ATTEMPTS = 200;

function nowMs(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value.getTime() : Number(value);
}

function defaultKill(pid, signal) {
  return process.kill(pid, signal);
}

function lockFileName(name) {
  if (name === 'sync' || name === 'write') return LOCK_FILES[name];
  if (name === 'sync.lock' || name === 'write.lock') return name;
  throw new Error(`unknown memento lock: ${name}`);
}

export function lockDir(repoPath) {
  return join(repoPath, '.git', 'memento');
}

export function lockPath(repoPath, name) {
  return join(lockDir(repoPath), lockFileName(name));
}

export function rerunPath(repoPath) {
  return join(lockDir(repoPath), RERUN_NAME);
}

export function isPidAlive(pid, kill = defaultKill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function readLock(path) {
  let raw;
  let info;
  try {
    raw = await readFile(path, 'utf8');
    info = await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let record = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.pid)) record = parsed;
  } catch {
    record = null;
  }
  return { raw, record, mtimeMs: info.mtimeMs };
}

function isStale(view, { now, staleMs, kill }) {
  const { record, mtimeMs } = view;
  if (!record) return nowMs(now) - mtimeMs > staleMs;
  const started = Date.parse(record.startedAt);
  const startedMs = Number.isFinite(started) ? started : mtimeMs;
  if (nowMs(now) - startedMs > staleMs) return true;
  return !isPidAlive(record.pid, kill);
}

async function restoreTombstone(tombstone, path) {
  try {
    await rename(tombstone, path);
    return true;
  } catch {
    return false;
  }
}

async function takeOver(path, observedRaw, ownerPid) {
  const tombstone = `${path}.stale-${ownerPid}-${randomUUID()}`;
  try {
    await rename(path, tombstone);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'retry';
    throw error;
  }
  const current = await readFile(tombstone, 'utf8').catch(() => null);
  if (current !== observedRaw) {
    await restoreTombstone(tombstone, path);
    return 'busy';
  }
  await unlink(tombstone).catch(() => {});
  return 'stolen';
}

export async function acquire(repoPath, name, options = {}) {
  const target = lockPath(repoPath, name);
  const sleep = options.scheduler?.sleep ?? options.sleep ?? ((ms) => delay(ms));
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? STALE_MS;
  const kill = options.kill ?? defaultKill;
  const pid = options.pid ?? process.pid;
  const hostname = options.hostname ?? osHostname();
  const sessionId = options.sessionId ?? process.env.SENPI_SESSION_ID ?? '';
  const waitMs = Math.max(0, Number(options.waitMs ?? 0));
  const startedAt = new Date(nowMs(now)).toISOString();
  const raw = `${JSON.stringify({ pid, startedAt, hostname, sessionId })}\n`;
  const record = { pid, startedAt, hostname, sessionId };
  const deadline = nowMs(now) + waitMs;
  let pause = FIRST_DELAY_MS;
  let stolen = false;

  async function busyResult() {
    if (lockFileName(name) !== LOCK_FILES.sync) return { rerun: false };
    try {
      await setRerunFlag(repoPath);
      return { rerun: true };
    } catch (error) {
      return { rerun: false, rerunError: String(error?.message ?? error) };
    }
  }

  await mkdir(dirname(target), { recursive: true });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await writeFile(target, raw, { flag: 'wx' });
      return { ok: true, name, path: target, raw, record, stolen };
    } catch (error) {
      if (!RETRY_CODES.has(error?.code) && error?.code !== 'EEXIST') throw error;
    }

    const observed = await readLock(target);
    let busy = false;
    if (observed === null) {
      busy = false;
    } else if (isStale(observed, { now, staleMs, kill })) {
      const outcome = await takeOver(target, observed.raw, pid);
      if (outcome === 'stolen') {
        stolen = true;
        continue;
      }
      busy = outcome !== 'retry';
    } else {
      busy = true;
    }

    if (!busy) continue;
    const remaining = deadline - nowMs(now);
    if (remaining <= 0) return { ok: false, busy: true, name, path: target, ...(await busyResult()) };
    const wait = Math.min(pause, remaining);
    await sleep(wait);
    pause = Math.min(pause * 2, MAX_DELAY_MS);
  }
  return { ok: false, busy: true, name, path: target, ...(await busyResult()) };
}

export async function release(handle) {
  if (!handle?.path || typeof handle.raw !== 'string') return false;
  const observed = await readLock(handle.path).catch(() => null);
  if (!observed || observed.raw !== handle.raw) return false;
  try {
    await unlink(handle.path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function withLock(repoPath, name, optionsOrRun, maybeRun) {
  const options = typeof optionsOrRun === 'function' ? {} : optionsOrRun;
  const run = typeof optionsOrRun === 'function' ? optionsOrRun : maybeRun;
  const handle = await acquire(repoPath, name, options);
  if (!handle.ok) return handle;
  try {
    return await run(handle);
  } finally {
    await release(handle);
  }
}

export async function setRerunFlag(repoPath) {
  const target = rerunPath(repoPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${new Date().toISOString()}\n`, 'utf8');
}

export async function hasRerunFlag(repoPath) {
  return existsSync(rerunPath(repoPath));
}

export async function clearRerunFlag(repoPath) {
  try {
    await unlink(rerunPath(repoPath));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
