import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRepo } from '../../../src/store/init.mjs';

export function tempDir(prefix = 'memento-intake-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function makeRepo({ remote = false, prefix = 'memento-intake-repo-' } = {}) {
  const parent = tempDir(prefix);
  const repo = join(parent, 'repo');
  let remotePath = null;
  if (remote) {
    remotePath = join(parent, 'remote.git');
    execFileSync('git', ['init', '--bare', '--quiet', remotePath], {
      windowsHide: true,
      stdio: 'ignore',
    });
  }
  const result = await initRepo({ dir: repo, remote: remotePath });
  if (!result.ok) throw new Error(`init failed: ${result.code}`);
  return { parent, repo, remote: remotePath };
}

export function writeConfig(agentDir, { repoPath, tokenFile, remote = null }) {
  mkdirSync(join(agentDir, 'memento'), { recursive: true });
  writeFileSync(
    join(agentDir, 'memento', 'config.json'),
    `${JSON.stringify({ repoPath, tokenFile, remote })}\n`,
  );
}

export function makeContext({
  hasUI = true,
  agentDir = '',
  sessionFile = 'owned/session.jsonl',
  sessionId = 'fake-session',
} = {}) {
  const notifications = [];
  return {
    hasUI,
    agentDir,
    notifications,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId,
    },
    ui: {
      notify(text, level) {
        notifications.push({ text, level });
      },
    },
  };
}

export function createFakePi({
  sessionKind = 'interactive',
  sessionFile = 'owned/session.jsonl',
  hasUI = true,
  agentDir = '',
  sessionId = 'fake-session',
} = {}) {
  const calls = { on: [], registerTool: [], registerCommand: [] };
  const handlers = new Map();
  const ctx = makeContext({ hasUI, agentDir, sessionFile, sessionId });
  const pi = {
    sessionKind,
    on(name, handler) {
      calls.on.push([name, handler]);
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    registerTool(definition) {
      calls.registerTool.push(definition);
    },
    registerCommand(name, definition) {
      calls.registerCommand.push([name, definition]);
    },
  };
  return {
    pi,
    ctx,
    calls,
    handlers,
    ctxWith(sessionId, overrides = {}) {
      return makeContext({
        hasUI,
        agentDir,
        sessionFile,
        sessionId,
        ...overrides,
      });
    },
    async emit(name, event = {}, handlerCtx = ctx) {
      const results = [];
      for (const handler of handlers.get(name) ?? []) {
        results.push(await handler(event, handlerCtx));
      }
      return results;
    },
  };
}

export function removeDirs(directories) {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
}
