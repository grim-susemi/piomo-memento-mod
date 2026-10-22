import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiscordClient } from '../../../src/discord/client.mjs';
import { startFakeDiscord } from '../../../src/discord/fake-server.mjs';
import { STATUS_KEYS, STATUS_LABELS } from '../../../src/card/status.mjs';
import { createReceipts } from '../../../src/receipts.mjs';
import { initRepo } from '../../../src/store/init.mjs';
import { openStore } from '../../../src/store/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, 'child.mjs');
const TOKEN = 'synthetic-discord-token-0123456789';

export function tempDir(prefix = 'memento-sync-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function git(cwd, args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd, encoding, windowsHide: true });
}

export function remoteGit(remote, args, encoding = 'utf8') {
  return execFileSync('git', ['--git-dir', remote, ...args], { encoding, windowsHide: true });
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function makeClientWrapper(client, { perCallMs = 0, clock } = {}) {
  if (!perCallMs) return client;
  const wrapped = {};
  for (const [name, value] of Object.entries(client)) {
    if (typeof value !== 'function') {
      wrapped[name] = value;
      continue;
    }
    wrapped[name] = async (...args) => {
      clock.advance(perCallMs);
      return value(...args);
    };
  }
  return wrapped;
}

/**
 * One sync environment: temp data repo + bare origin + in-process fake Discord
 * + agent dir. Every directory and server is owned by the caller's afterEach.
 */
export async function makeSyncEnv({ remote = true, withForum = true } = {}) {
  const parent = tempDir();
  const repo = join(parent, 'repo');
  const bare = remote ? join(parent, 'remote.git') : null;
  if (bare) {
    execFileSync('git', ['init', '--bare', '--quiet', bare], { windowsHide: true, stdio: 'ignore' });
  }
  const init = await initRepo({ dir: repo, remote: bare });
  if (!init.ok) throw new Error(`init failed: ${init.code}`);

  const fake = await startFakeDiscord({ token: TOKEN });
  const agentDir = join(parent, 'agent');
  const tokenFile = join(parent, 'discord-token');
  writeFileSync(tokenFile, `${TOKEN}\n`);

  const plainClient = createDiscordClient({
    tokenFile,
    baseUrl: fake.baseUrl,
    clock: fake.clock,
  });
  const store = openStore(repo, { sleep: async () => {}, lockWaitMs: 500, now: fake.clock.now });
  const receipts = createReceipts({ agentDir });
  const env = {
    parent,
    repo,
    remote: bare,
    agentDir,
    tokenFile,
    fake,
    clock: fake.clock,
    plainClient,
    client: plainClient,
    store,
    receipts,
    tags: {},
    forumId: null,
    closed: false,

    async forum() {
      const forum = await plainClient.createForumChannel({
        guildId: fake.ids.guildId,
        name: '메멘토',
        tags: STATUS_KEYS.map((key) => STATUS_LABELS[key]),
      });
      if (!forum.ok) throw new Error(`forum creation failed: ${forum.status}`);
      env.forumId = forum.data.id;
      for (const tag of forum.data.available_tags) {
        const key = STATUS_KEYS.find((candidate) => STATUS_LABELS[candidate] === tag.name);
        env.tags[key] = tag.id;
      }
      return forum.data;
    },

    async syncState(overrides = {}) {
      const current = await store.readSyncState();
      if (!current.ok) throw new Error(`sync state missing: ${current.code}`);
      const state = {
        ...current.state,
        guildId: fake.ids.guildId,
        forumId: env.forumId,
        tagIds: { ...env.tags },
        ownerUserId: fake.ids.ownerUserId,
        botUserId: fake.ids.botUserId,
        clock: { offsetMs: 0, rttMs: 0, dateSkewMs: 0, measuredAt: new Date(fake.clock.now()).toISOString() },
        bases: {},
        starterCursor: 0,
        ...overrides,
      };
      const written = await store.writeSyncState(state);
      if (!written.ok) throw new Error(`state write failed: ${written.code}`);
      return state;
    },

    config(overrides = {}) {
      return {
        state: 'configured',
        reason: '',
        agentDir,
        configPath: join(agentDir, 'memento', 'config.json'),
        repoPath: repo,
        tokenFile,
        remote: bare,
        ...overrides,
      };
    },

    async run(options = {}) {
      const { runSync } = await import('../../../src/sync/run.mjs');
      return runSync({
        reason: 'startup',
        config: env.config(),
        store: env.store,
        client: env.client,
        receipts,
        now: fake.clock.now,
        ...options,
      });
    },

    async card(id) {
      const found = await store.get(id);
      if (!found.ok) return null;
      return found.card;
    },

    async cards() {
      return (await store.list()).cards;
    },

    async newCard(overrides = {}) {
      const created = await store.create({
        title: '아이디어 제목',
        description: '한 줄 설명',
        original: '원문 첫 줄\n원문 둘째 줄',
        source: 'paste',
        sourceRef: 'session:test',
        via: 'paste',
        actor: 'owner',
        ...overrides,
      });
      if (!created.ok) throw new Error(`card create failed: ${created.code}`);
      return created.card;
    },

    async updateCard(id, mutate, log) {
      const current = await store.get(id);
      if (!current.ok) throw new Error(`card missing: ${id}`);
      const result = await store.update(id, {
        expectRev: current.card.rev,
        mutate,
        log,
      });
      if (!result.ok) throw new Error(`card update failed: ${result.code}`);
      return result.card;
    },

    seedThread(params = {}) {
      return fake.hooks.seedThread({
        forumId: env.forumId,
        ownerId: fake.ids.ownerUserId,
        ...params,
      });
    },

    requests(method) {
      return fake.requests.filter((entry) => !method || entry.method === method);
    },

    posts() {
      return fake.requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/threads'));
    },

    mutations() {
      return fake.requests.filter((entry) => (entry.method === 'POST' && entry.path.endsWith('/threads'))
        || entry.method === 'PATCH'
        || entry.method === 'DELETE');
    },

    remoteText(relative) {
      return remoteGit(bare, ['show', `main:${relative}`]);
    },

    remoteHas(relative) {
      const listing = remoteGit(bare, ['ls-tree', '-r', '--name-only', 'main']);
      return listing.split(/\r?\n/).includes(relative);
    },

    cloneRestored(name = 'restored') {
      const target = join(parent, name);
      execFileSync('git', ['clone', '--branch', 'main', '--quiet', bare, target], {
        windowsHide: true, stdio: 'ignore',
      });
      return target;
    },

    readState() {
      return JSON.parse(readFileSync(join(repo, 'sync', 'state.json'), 'utf8'));
    },

    writeFile(relative, contents) {
      const target = join(repo, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    },

    commitAll(message = 'fixture: seed') {
      git(repo, ['add', '--', ...git(repo, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean)]);
      git(repo, ['-c', 'user.name=memento', '-c', 'user.email=memento@local', 'commit', '-m', message]);
    },

    async close() {
      if (env.closed) return;
      env.closed = true;
      await fake.close();
      rmSync(parent, { recursive: true, force: true });
    },
  };

  if (withForum) {
    await env.forum();
    await env.syncState();
    if (bare) await store.push();
  }
  return env;
}

export function spawnSyncChild(options) {
  return fork(CHILD, [JSON.stringify(options)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
}

export function waitForMessage(child, predicate, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for child message\n${child.__stderr ?? ''}`));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`child exited before the expected message (code ${code})\n${child.__stderr ?? ''}`));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    }
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

export function waitForExit(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for child exit\n${child.__stderr ?? ''}`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    function cleanup() {
      clearTimeout(timer);
      child.off('exit', onExit);
    }
    child.on('exit', onExit);
  });
}

export function killChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

export { TOKEN, CHILD };
