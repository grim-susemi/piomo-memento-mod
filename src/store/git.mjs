import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

const MAX_BUFFER = 16 * 1024 * 1024;

let childObserver = null;

/**
 * Optional QA hook: receives spawn and exit events for every git child this
 * module starts. Production never sets it; observer failures are ignored so a
 * diagnostic can never change git behavior. Events are
 * { event: 'spawn', pid, at } and { event: 'exit', pid, code, signal, at }.
 */
export function observeChildProcesses(observer) {
  childObserver = typeof observer === 'function' ? observer : null;
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        if (error.stdout === undefined) error.stdout = stdout;
        if (error.stderr === undefined) error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    if (childObserver && Number.isInteger(child.pid) && child.pid > 0) {
      const pid = child.pid;
      try {
        childObserver({ event: 'spawn', pid, at: Date.now() });
      } catch {
        // diagnostics only; never break a git call
      }
      child.once('exit', (code, signal) => {
        try {
          childObserver({ event: 'exit', pid, code, signal, at: Date.now() });
        } catch {
          // diagnostics only; never break a git call
        }
      });
    }
  });
}

export const GIT_CONFIG = Object.freeze([
  '-c', 'user.name=memento',
  '-c', 'user.email=memento@local',
  '-c', 'core.quotepath=false',
  '-c', 'i18n.commitEncoding=utf-8',
]);

function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  };
}

export function indexLockPath(repoPath) {
  return join(repoPath, '.git', 'index.lock');
}

export function isIndexLocked(repoPath) {
  return existsSync(indexLockPath(repoPath));
}

export async function pathDirty(repoPath, path) {
  const result = await git(repoPath, ['status', '--porcelain', '--', safeRepoPath(path)]);
  if (!result.ok) return true;
  return result.stdout.trim().length > 0;
}

export async function git(repoPath, args, options = {}) {
  const execOptions = {
    cwd: repoPath,
    env: gitEnv(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? MAX_BUFFER,
  };
  if (options.timeoutMs && options.timeoutMs > 0) execOptions.timeout = options.timeoutMs;
  if (options.signal) execOptions.signal = options.signal;
  try {
    const { stdout, stderr } = await execFileAsync('git', args, execOptions);
    return { ok: true, code: 0, stdout, stderr };
  } catch (error) {
    const aborted = error?.code === 'ABORT_ERR' || error?.name === 'AbortError';
    const timedOut = error?.killed === true && !aborted;
    return {
      ok: false,
      code: typeof error?.code === 'number' ? error.code : String(error?.code ?? 'EXEC'),
      aborted,
      timedOut,
      signal: error?.signal ?? null,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
    };
  }
}

function safeRepoPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new TypeError('commit path must be a non-empty string');
  }
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new TypeError(`commit path must be repo-relative: ${path}`);
  }
  if (normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new TypeError(`commit path must stay inside the repo: ${path}`);
  }
  return normalized;
}

function commitText(message) {
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new TypeError('commit message must be a non-empty string');
  }
  return `${message.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n`;
}

export async function commitPaths(repoPath, paths, message, options = {}) {
  const files = paths.map(safeRepoPath);
  if (files.length === 0) return { ok: false, code: 'NO_PATHS' };
  if (isIndexLocked(repoPath)) return { ok: false, code: 'INDEX_LOCK', skipped: 'index-lock' };

  const text = commitText(message);
  const messageFile = join(repoPath, '.git', 'memento', `commit-${process.pid}-${randomUUID()}.tmp`);
  let prepStage = 'message-dir';
  try {
    await mkdir(dirname(messageFile), { recursive: true });
    prepStage = 'message-write';
    await writeFile(messageFile, text, 'utf8');
  } catch (error) {
    let cleanupError = null;
    try {
      await unlink(messageFile);
    } catch (cleanup) {
      if (cleanup?.code !== 'ENOENT') cleanupError = String(cleanup?.code ?? cleanup);
    }
    return {
      ok: false,
      code: 'COMMIT_PREP_FAILED',
      stage: prepStage,
      error: typeof error?.code === 'string' ? error.code : String(error?.message ?? error),
      ...(typeof error?.code === 'string' ? { errno: error.code } : {}),
      ...(cleanupError ? { cleanupError } : {}),
    };
  }
  try {
    const added = await git(repoPath, [...GIT_CONFIG, 'add', '--', ...files], options);
    if (!added.ok) {
      if (isIndexLocked(repoPath)) {
        return { ...added, ok: false, code: 'INDEX_LOCK', skipped: 'index-lock' };
      }
      return { ...added, ok: false, code: 'ADD_FAILED' };
    }
    if (isIndexLocked(repoPath)) {
      return { ok: false, code: 'INDEX_LOCK', skipped: 'index-lock' };
    }
    const committed = await git(repoPath, [...GIT_CONFIG, 'commit', '--only', '-F', messageFile, '--', ...files], options);
    if (!committed.ok) {
      if (isIndexLocked(repoPath)) {
        return { ...committed, ok: false, code: 'INDEX_LOCK', skipped: 'index-lock' };
      }
      if (/nothing to commit|no changes added to commit/i.test(`${committed.stdout}${committed.stderr}`)) {
        const dirtyPaths = [];
        for (const file of files) {
          if (await pathDirty(repoPath, file)) dirtyPaths.push(file);
        }
        if (dirtyPaths.length > 0) {
          return { ...committed, ok: false, code: 'COMMIT_FAILED', uncommitted: true, dirtyPaths };
        }
        return { ok: true, changed: false, code: 0, hash: null };
      }
      return { ...committed, ok: false, code: 'COMMIT_FAILED' };
    }
    const head = await git(repoPath, ['rev-parse', 'HEAD'], options);
    return {
      ok: true,
      changed: true,
      code: 0,
      hash: head.ok ? head.stdout.trim() : null,
      stdout: committed.stdout,
      stderr: committed.stderr,
    };
  } finally {
    await unlink(messageFile).catch(() => {});
  }
}

export async function hasRemote(repoPath, remote = 'origin') {
  const result = await git(repoPath, ['remote', 'get-url', remote]);
  return result.ok && result.stdout.trim().length > 0;
}

export async function push(repoPath, options = {}) {
  const remote = options.remote ?? 'origin';
  const branch = options.branch ?? 'main';
  if (!(await hasRemote(repoPath, remote))) {
    return { ok: true, code: 0, skipped: 'no-remote' };
  }
  return git(repoPath, ['push', remote, branch], {
    timeoutMs: options.timeoutMs ?? 15_000,
    signal: options.signal,
  });
}

export async function unpushedCount(repoPath, options = {}) {
  const remote = options.remote ?? 'origin';
  const branch = options.branch ?? 'main';
  if (!(await hasRemote(repoPath, remote))) return 0;
  const tracking = await git(repoPath, ['rev-list', '--count', `${remote}/${branch}..HEAD`]);
  if (tracking.ok) {
    const count = Number(tracking.stdout.trim());
    if (Number.isFinite(count)) return count;
  }
  const all = await git(repoPath, ['rev-list', '--count', 'HEAD']);
  if (!all.ok) return 0;
  const count = Number(all.stdout.trim());
  return Number.isFinite(count) ? count : 0;
}

export async function initGitRepo(repoPath) {
  return git(repoPath, ['init', '-b', 'main']);
}

export async function addRemote(repoPath, url) {
  return git(repoPath, ['remote', 'add', 'origin', url]);
}

export async function head(repoPath) {
  return git(repoPath, ['rev-parse', 'HEAD']);
}
