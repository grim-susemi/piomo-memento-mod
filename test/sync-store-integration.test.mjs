import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { openStore } from '../src/store/store.mjs';
import { git, makeSyncEnv } from './fixtures/sync/harness.mjs';

const envs = [];
const iso = (ms) => new Date(ms).toISOString();

async function setup() {
  const env = await makeSyncEnv();
  envs.push(env);
  return env;
}

afterEach(async () => {
  for (const env of envs.splice(0)) await env.close();
});

async function linkCard(env, card, thread) {
  const linked = await env.updateCard(card.id, (current) => ({
    ...current,
    discordChannel: env.forumId,
    discordThread: thread.id,
    discordBase: 'idea',
    discordState: 'linked',
  }), { actor: 'memento', via: 'sync', change: 'link', reason: 'fixture-link' });
  const state = env.readState();
  await env.store.writeSyncState({
    ...state,
    bases: { ...(state.bases ?? {}), [card.id]: iso(env.clock.now() - 1_000) },
  });
  return linked;
}

async function boardPick(env, card, to) {
  return env.updateCard(card.id, (current) => ({ ...current, status: to }), {
    at: iso(env.clock.now()),
    eventId: `board-${to}`,
    actor: 'owner',
    via: 'board',
    change: 'status',
    from: card.status,
    to,
    reason: 'owner-board',
  });
}

test('Test_Sync_denied_restore_then_restart_recovers_with_a_fresh_store', async () => {
  // Given a denied owner restore persisted by store.transactSyncState;
  // when the runner restarts with a fresh store on the same repo;
  // then the owner tag is restored and the durable op clears.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  await boardPick(env, card, 'done');
  const withDelay = env.readState();
  await env.store.writeSyncState({ ...withDelay, ownerAuditDelayMs: 1_000 });
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  let calls = 0;
  const realPatch = env.plainClient.patchThreadTags;
  env.client = {
    ...env.plainClient,
    patchThreadTags: async (params, options) => {
      calls += 1;
      if (calls === 2) {
        return {
          ok: false, status: 403, data: null, headers: {}, date: null,
          sentAt: null, receivedAt: null, error: 'http', forbidden: true,
        };
      }
      return realPatch(params, options);
    },
  };

  const first = env.run();
  await hold.arrived;
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  hold.release();
  await first;
  assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 1);

  // Restart: a new store instance reads the committed state and resumes.
  const restarted = openStore(env.repo, {
    sleep: async () => {},
    lockWaitMs: 500,
    now: env.clock.now,
  });
  env.client = env.plainClient;
  const recovered = await env.run({ store: restarted });

  assert.equal(recovered.ok, true);
  assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 1,
    'success is retained until D');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.held]);
  assert.equal((await env.card(card.id)).discordState, 'conflict');

  env.clock.advance(5 * 60 * 1_000);
  const cleared = await env.run({ store: openStore(env.repo, {
    sleep: async () => {}, lockWaitMs: 500, now: env.clock.now,
  }) });
  assert.equal(cleared.ok, true);
  assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 0);
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.held]);
});

test('Test_Sync_index_lock_barrier_keeps_state_unchanged_and_recovers', async () => {
  // Given a held git index lock; when finalize writes; then the store reports
  // INDEX_LOCK without changing state, and removing the lock lets the retry commit.
  const env = await setup();
  await env.newCard();
  const indexLock = join(env.repo, '.git', 'index.lock');
  writeFileSync(indexLock, '');
  let blocked;
  try {
    blocked = await env.run();
  } finally {
    rmSync(indexLock, { force: true });
  }

  assert.equal(blocked.stateWrite, 'INDEX_LOCK');
  assert.equal(env.readState().restoreContract, undefined);

  const retried = await env.run();
  assert.equal(retried.stateWrite, undefined);
  assert.equal(env.readState().restoreContract, 'memento.restore.v1');
});

test('Test_Sync_commit_failure_barrier_uses_store_rollback_and_retries_equal_state', async () => {
  // Given a commit failure injected through GIT_AUTHOR_DATE; when finalize writes;
  // then the store restores bytes/index, no dirty index remains, and a retry commits.
  const env = await setup();
  await env.newCard();
  const previous = process.env.GIT_AUTHOR_DATE;
  let failed;
  try {
    process.env.GIT_AUTHOR_DATE = 'not-a-date';
    failed = await env.run();
  } finally {
    if (previous === undefined) delete process.env.GIT_AUTHOR_DATE;
    else process.env.GIT_AUTHOR_DATE = previous;
  }

  assert.equal(failed.stateWrite, 'COMMIT_FAILED');
  assert.equal(git(env.repo, ['status', '--porcelain', '--', 'sync/state.json']).trim(), '');
  assert.equal(env.readState().restoreContract, undefined, 'failed write restored previous bytes');

  const retried = await env.run();

  assert.equal(retried.stateWrite, undefined);
  assert.equal(env.readState().restoreContract, 'memento.restore.v1');
  assert.equal(git(env.repo, ['status', '--porcelain', '--', 'sync/state.json']).trim(), '');
});
