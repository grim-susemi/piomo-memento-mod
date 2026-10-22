import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { makeSyncEnv } from './fixtures/sync/harness.mjs';

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

test('Test_Sync_merge_does_not_resurrect_a_concurrently_completed_restore_op', async () => {
  // Given a restore op that fails 403 and increments attempts; when another
  // restorer deletes that key and adds an unrelated op at the final barrier;
  // then the stale attempts update must not resurrect it.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  const opCard = await env.updateCard(card.id, (current) => ({ ...current, status: 'done' }), {
    actor: 'owner', via: 'board', change: 'status', from: 'idea', to: 'done',
    reason: 'owner-board', eventId: 'board-op',
  });
  const owner = env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.fake.state.channels.get(thread.id).applied_tags = [env.tags.done];
  const op = {
    kind: 'status', intent: 'restore', schema: 'memento.restore.v1', writer: 'sync',
    key: 'board-durable-restore', thread: thread.id, cardId: card.id,
    t0: iso(env.clock.now() - 5_000), patchAt: iso(env.clock.now() - 4_000),
    eventId: 'board-op', targetStatus: 'held', reason: 'owner-race',
    ownerStatus: 'held', pushedStatus: 'done', ownerEntryId: owner.id,
    conflictSince: iso(env.clock.now() - 3_000), attempts: 0,
  };
  const state = env.readState();
  await env.store.writeSyncState({
    ...state, restoreContract: 'memento.restore.v1', pending: [op],
  });
  env.fake.hooks.forceStatus({
    method: 'PATCH', path: `/channels/${thread.id}`, status: 403,
    body: { message: 'Missing Access', code: 50001 },
  });
  let reached;
  let release;
  const atBarrier = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const running = env.run({
    hooks: {
      async barrier(name) {
        if (name !== 'before-final-state-write') return;
        reached();
        await gate;
      },
    },
  });
  await atBarrier;

  const other = await env.store.transactSyncState((latest) => {
    latest.pending = [
      ...(latest.pending ?? []).filter((entry) => entry.key !== op.key),
      { kind: 'note', key: 'concurrent-add' },
    ];
  });
  assert.equal(other.ok, true);
  release();
  await running;

  const keys = env.readState().pending.map((entry) => entry.key);
  assert.ok(!keys.includes(op.key), 'completed key was not resurrected');
  assert.ok(keys.includes('concurrent-add'), 'unrelated addition survived');
  assert.equal(env.readState().restoreContract, 'memento.restore.v1');
  assert.equal(opCard.status, 'done');
});

test('Test_Sync_finalize_preserves_a_concurrent_deletion_and_the_adoption_marker', async () => {
  // Given pending entries in the runner snapshot; when the API deletes one and adds
  // another at the held final-state barrier; then the deletion/addition survive and
  // the runner's adoption marker is still written.
  const env = await setup();
  const initial = env.readState();
  await env.store.writeSyncState({
    ...initial,
    pending: [
      { kind: 'note', key: 'keep-op' },
      { kind: 'note', key: 'delete-op' },
    ],
  });
  let reached;
  let release;
  const atBarrier = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const running = env.run({
    hooks: {
      async barrier(name) {
        if (name !== 'before-final-state-write') return;
        reached();
        await gate;
      },
    },
  });
  await atBarrier;

  const apiState = env.readState();
  await env.store.writeSyncState({
    ...apiState,
    pending: [
      ...(apiState.pending ?? []).filter((entry) => entry.key !== 'delete-op'),
      { kind: 'note', key: 'api-add' },
    ],
  });
  release();

  const result = await running;
  assert.equal(result.ok, true);
  const stored = env.readState();
  const keys = stored.pending.map((entry) => entry.key);
  assert.ok(keys.includes('keep-op'));
  assert.ok(keys.includes('api-add'), 'concurrent addition survived');
  assert.ok(!keys.includes('delete-op'), 'concurrent deletion survived');
  assert.equal(stored.restoreContract, 'memento.restore.v1');
});

test('Test_Sync_finalize_merges_an_API_state_write_made_at_the_held_barrier', async () => {
  // Given a sync parked just before its final state read-modify-write;
  // when the board API adds pending/recentWrites/bases; then all entries survive.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  const linked = await env.updateCard(card.id, (current) => ({
    ...current,
    discordChannel: env.forumId,
    discordThread: thread.id,
    discordBase: 'idea',
    discordState: 'linked',
  }), { actor: 'memento', via: 'sync', change: 'link', reason: 'fixture-link' });
  const initial = env.readState();
  await env.store.writeSyncState({
    ...initial,
    bases: { ...(initial.bases ?? {}), [card.id]: iso(env.clock.now() - 1_000) },
  });
  await env.updateCard(card.id, (current) => ({ ...current, status: 'done' }), {
    at: iso(env.clock.now()),
    eventId: 'board-race',
    actor: 'owner',
    via: 'board',
    change: 'status',
    from: linked.status,
    to: 'done',
    reason: 'owner-board',
  });

  let reached;
  let release;
  const atBarrier = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const hooks = {
    async barrier(name) {
      if (name !== 'before-final-state-write') return;
      reached();
      await gate;
    },
  };
  const running = env.run({ hooks });
  await atBarrier;

  const apiState = env.readState();
  apiState.pending = [...(apiState.pending ?? []), {
    kind: 'status',
    key: 'api-op',
    thread: thread.id,
    cardId: card.id,
    t0: iso(env.clock.now()),
    eventId: 'api-event',
  }];
  apiState.recentWrites = [...(apiState.recentWrites ?? []), {
    thread: thread.id,
    t0: iso(env.clock.now()),
    patchAt: iso(env.clock.now()),
    key: 'api-write',
    cardId: card.id,
    eventId: 'api-event',
  }];
  apiState.bases = { ...(apiState.bases ?? {}), 'api-only-card': iso(env.clock.now()) };
  const apiWrite = await env.store.writeSyncState(apiState);
  assert.equal(apiWrite.ok, true);
  release();

  const result = await running;
  assert.equal(result.ok, true);
  const stored = env.readState();
  assert.ok(stored.pending.some((entry) => entry.key === 'api-op'), 'API pending survived');
  assert.ok(stored.recentWrites.some((entry) => entry.key === 'api-write'), 'API recentWrite survived');
  assert.ok(stored.recentWrites.some((entry) => entry.cardId === card.id && entry.key !== 'api-write'),
    'runner recentWrite survived');
  assert.equal(stored.bases['api-only-card'] !== undefined, true, 'API base survived');
  assert.equal(stored.bases[card.id] !== undefined, true, 'runner base survived');
});
