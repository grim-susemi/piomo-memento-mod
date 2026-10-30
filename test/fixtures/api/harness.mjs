// Temp data repo + bare origin + in-process fake Discord for the board API tests.
// Kept independent of test/fixtures/sync so the sync runner can be rewritten
// without moving the API tests with it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { STATUS_KEYS, STATUS_LABELS } from '../../../src/card/status.mjs';
import { createDiscordClient } from '../../../src/discord/client.mjs';
import { startFakeDiscord } from '../../../src/discord/fake-server.mjs';
import { createReceipts } from '../../../src/receipts.mjs';
import { initRepo } from '../../../src/store/init.mjs';
import { openStore } from '../../../src/store/store.mjs';

export const TOKEN = 'synthetic-board-api-token-0123456789';
export const DAY_MS = 24 * 60 * 60 * 1000;
export const AUDIT_RETENTION_MS = 45 * DAY_MS;

export const iso = (ms) => new Date(ms).toISOString();

export function tempDir(prefix = 'memento-api-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

/** One API environment; every directory and server is closed by env.close(). */
export async function makeApiEnv({ remote = true } = {}) {
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

  const plainClient = createDiscordClient({ tokenFile, baseUrl: fake.baseUrl, clock: fake.clock });
  const store = openStore(repo, { sleep: async () => {}, lockWaitMs: 500, now: fake.clock.now });
  const receipts = createReceipts({ agentDir });
  const apis = [];

  const env = {
    parent,
    repo,
    remote: bare,
    agentDir,
    tokenFile,
    fake,
    clock: fake.clock,
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
        env.tags[STATUS_KEYS.find((key) => STATUS_LABELS[key] === tag.name)] = tag.id;
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
        clock: { offsetMs: 0, rttMs: 0, dateSkewMs: 0, measuredAt: iso(fake.clock.now()) },
        bases: {},
        audit: {
          lastEntryId: null,
          coveredSince: iso(fake.clock.now() - AUDIT_RETENTION_MS),
          ingested: [],
        },
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

    async api(overrides = {}) {
      const { createBoardApi } = await import('../../../src/api.mjs');
      const api = createBoardApi({
        config: env.config(),
        store,
        client: env.client,
        receipts,
        now: fake.clock.now,
        // Final-status tests must not depend on the real wall-clock reply budget under
        // host load. Tests that assert a held or deadline reply pass replyBudgetMs.
        replyBudgetMs: 30_000,
        ...overrides,
      });
      apis.push(api);
      return api;
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

    async card(id) {
      const found = await store.get(id);
      return found.ok ? found.card : null;
    },

    async updateCard(id, mutate, log) {
      const current = await store.get(id);
      if (!current.ok) throw new Error(`card missing: ${id}`);
      const result = await store.update(id, { expectRev: current.card.rev, mutate, log });
      if (!result.ok) throw new Error(`card update failed: ${result.code}`);
      return result.card;
    },

    seedThread(params = {}) {
      return fake.hooks.seedThread({
        forumId: env.forumId,
        ownerId: fake.ids.botUserId,
        ...params,
      });
    },

    async linkCard(card, thread, base = 'idea') {
      const linked = await env.updateCard(card.id, (current) => ({
        ...current,
        discordChannel: env.forumId,
        discordThread: thread.id,
        discordBase: base,
        discordState: 'linked',
      }), { actor: 'memento', via: 'sync', change: 'link', reason: 'fixture-link' });
      const state = env.readState();
      await store.writeSyncState({
        ...state,
        bases: { ...(state.bases ?? {}), [card.id]: iso(fake.clock.now() - 1_000) },
      });
      return linked;
    },

    async run(options = {}) {
      const { runSync } = await import('../../../src/sync/run.mjs');
      return runSync({
        reason: 'startup',
        config: env.config(),
        store,
        client: env.client,
        receipts,
        now: fake.clock.now,
        ...options,
      });
    },

    readState() {
      return JSON.parse(readFileSync(join(repo, 'sync', 'state.json'), 'utf8'));
    },

    writeFile(relative, contents) {
      const target = join(repo, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    },

    receiptsText() {
      try {
        return readFileSync(join(agentDir, 'logs', 'memento.jsonl'), 'utf8');
      } catch {
        return '';
      }
    },

    patches() {
      return fake.requests.filter((entry) => entry.method === 'PATCH');
    },

    mutations() {
      return fake.requests.filter((entry) => entry.method === 'PATCH' || entry.method === 'POST'
        || entry.method === 'DELETE');
    },

    remoteTags(threadId) {
      return [...(fake.state.channels.get(threadId)?.applied_tags ?? [])];
    },

    async close() {
      if (env.closed) return;
      env.closed = true;
      const pending = apis.splice(0);
      for (const api of pending) api.abort?.();
      await fake.close();
      for (const api of pending) await api.whenIdle?.();
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };

  await env.forum();
  await env.syncState();
  if (bare) await store.push();
  return env;
}
