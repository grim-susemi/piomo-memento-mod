import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_TIMEOUT_MS = 15_000;

export function tempDir(prefix = 'memento-store-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeRepo(prefix = 'memento-store-repo-') {
  const directory = tempDir(prefix);
  mkdirSync(join(directory, '.git'), { recursive: true });
  return directory;
}

function childStderr(child) {
  child.__stderr = '';
  child.stderr?.on('data', (chunk) => {
    child.__stderr += chunk.toString('utf8');
  });
  return child;
}

export function spawnLockChild(repo, name, mode = 'hold', waitMs = 0) {
  return childStderr(fork(
    join(HERE, 'lock-child.mjs'),
    [mode, repo, name, String(waitMs)],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true },
  ));
}

export function spawnCrashChild(repo, kind, id = '') {
  return childStderr(fork(
    join(HERE, 'crash-child.mjs'),
    [kind, repo, id],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true },
  ));
}

function messageError(child, label) {
  const detail = child.__stderr ? `\nchild stderr:\n${child.__stderr}` : '';
  return new Error(`${label}${detail}`);
}

export function waitForMessage(child, predicate, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(messageError(child, 'timed out waiting for child message'));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code) => {
      cleanup();
      reject(messageError(child, `child exited before the expected message (code ${code})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

export function waitForExit(child, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(messageError(child, 'timed out waiting for child exit'));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    child.on('exit', onExit);
  });
}

export function send(child, message) {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

export function stopChildren(children) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

export function removeDirs(directories) {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
}
