import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  git,
  killChild,
  makeSyncEnv,
  spawnSyncChild,
  waitForExit,
  waitForMessage,
} from './fixtures/sync/harness.mjs';

const envs = [];
const children = [];

async function setup() {
  const env = await makeSyncEnv();
  envs.push(env);
  return env;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    killChild(child);
    await waitForExit(child).catch(() => {});
  }
  for (const env of envs.splice(0)) await env.close();
});

function childOptions(env, parkAt) {
  return {
    repoPath: env.repo,
    tokenFile: env.tokenFile,
    baseUrl: env.fake.baseUrl,
    remote: env.remote,
    agentDir: env.agentDir,
    nowMs: env.clock.now(),
    parkAt,
  };
}

test('Test_Crash_when_killed_between_the_create_response_and_the_link_rerun_links_once', async () => {
  // Given a child killed after the POST response; when rerun; then exactly one post and one card.
  const env = await setup();
  const card = await env.newCard();
  const child = spawnSyncChild(childOptions(env, 'after-create-response'));
  children.push(child);
  await waitForMessage(child, (message) => message.type === 'barrier' && message.name === 'after-create-response');
  killChild(child);
  await waitForExit(child);

  assert.equal(env.posts().length, 1);
  const posting = await env.card(card.id);
  assert.equal(posting.discordState, 'posting');
  assert.equal(env.readState().pending[0].sent, true);

  const result = await env.run();
  assert.equal(result.actions.linked, 1);
  assert.equal(env.posts().length, 1);
  const cards = await env.cards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].discordState, 'linked');
});

test('Test_Crash_after_posting_before_the_link_push_restores_and_links_by_marker', async () => {
  // Given a child killed after the link commit but before its push; when restored and synced;
  // then one card linked from the marker, one post, and a byte-equal original.
  const env = await setup();
  const card = await env.newCard({ original: '크래시 복원 원문 ㅋㅋㅋ 👍\n둘째 줄' });
  const child = spawnSyncChild(childOptions(env, 'before-final-push'));
  children.push(child);
  await waitForMessage(child, (message) => message.type === 'barrier' && message.name === 'before-final-push');
  killChild(child);
  await waitForExit(child);

  assert.equal(env.posts().length, 1);
  const restoredPath = env.cloneRestored();
  const { openStore } = await import('../src/store/store.mjs');
  const { runSync } = await import('../src/sync/run.mjs');
  const restored = openStore(restoredPath, { sleep: async () => {}, lockWaitMs: 500 });

  const result = await runSync({
    reason: 'startup',
    config: { ...env.config(), repoPath: restoredPath },
    store: restored,
    client: env.client,
    receipts: env.receipts,
    now: env.clock.now,
  });

  assert.equal(result.ok, true);
  assert.equal(env.posts().length, 1);
  const cards = (await restored.list()).cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, card.id);
  assert.equal(cards[0].discordState, 'linked');
  assert.ok(cards[0].discordThread);
  assert.equal(cards[0].original, card.original.normalize('NFC'));
  assert.equal(git(restoredPath, ['status', '--porcelain']).trim(), '');
});

test('Test_Sync_a_card_write_from_another_process_succeeds_during_a_sync', async () => {
  // Given a sync child held on its guarded re-read; when this process writes the card;
  // then the external write survives and the child cannot clobber it.
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
    bases: { ...(initial.bases ?? {}), [card.id]: new Date(env.clock.now() - 1_000).toISOString() },
  });
  const picked = await env.updateCard(card.id, (current) => ({ ...current, status: 'done' }), {
    at: new Date(env.clock.now()).toISOString(),
    eventId: 'board-cross-process',
    actor: 'owner',
    via: 'board',
    change: 'status',
    from: linked.status,
    to: 'done',
    reason: 'owner-board',
  });
  const hold = env.fake.hooks.holdNext({ method: 'GET', path: `/channels/${thread.id}` });
  const child = spawnSyncChild(childOptions(env));
  children.push(child);
  await hold.arrived;

  const external = await env.store.update(picked.id, {
    expectRev: picked.rev,
    mutate: (current) => ({ ...current, notes: '다른 프로세스' }),
    log: { actor: 'owner', via: 'board', change: 'status', from: 'done', to: 'done', reason: 'external' },
  });
  assert.equal(external.ok, true);
  hold.release();
  await waitForMessage(child, (message) => message.type === 'result');
  await waitForExit(child);

  const after = await env.card(card.id);
  assert.equal(after.notes, '다른 프로세스');
  assert.ok(after.rev > picked.rev);
});
