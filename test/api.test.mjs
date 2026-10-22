// Board API v1: contract shape, exact-key validation, request dedupe, the
// guarded write-through, the 2 s reply slot and its durable continuation.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  BOARD_STATE_SCHEMA,
  validateBoardState,
  validateReply,
} from '../src/contract.mjs';
import { acquire, release } from '../src/store/lock.mjs';
import { iso, makeApiEnv } from './fixtures/api/harness.mjs';

const envs = [];

async function setup(options = {}) {
  const env = await makeApiEnv(options);
  envs.push(env);
  return env;
}

afterEach(async () => {
  for (const env of envs.splice(0)) await env.close();
});

function pick(card, status, requestId, overrides = {}) {
  return { action: 'setStatus', id: card.id, status, rev: card.rev, requestId, ...overrides };
}

async function linkedFixture(env, options = {}) {
  const card = await env.newCard(options.card);
  const thread = env.seedThread({
    name: card.title,
    appliedTags: [env.tags[options.base ?? 'idea']],
    content: `${card.title}\n\n${card.original}`,
    ...options.thread,
  });
  const linked = await env.linkCard(card, thread, options.base ?? 'idea');
  return { card: linked, thread };
}

test('Test_State_matches_the_board_contract_with_caps_order_and_unreadable_cards', async () => {
  const env = await setup();
  const api = await env.api();

  const long = '가'.repeat(2_000);
  const truncated = await env.newCard({ original: long, notes: '짧은 메모' });
  const events = [];
  for (let index = 1; index <= 12; index += 1) {
    events.push({
      at: iso(env.clock.now() + index * 1_000),
      eventId: `fixture-event-${index}`,
      actor: 'memento',
      via: 'sync',
      change: 'status',
      from: 'idea',
      to: 'done',
      reason: `fixture-${index}`,
    });
  }
  await env.updateCard(truncated.id, (card) => card, events);
  const conflicted = await env.newCard({ title: '충돌 카드' });
  await env.updateCard(conflicted.id, (card) => ({
    ...card,
    discordState: 'conflict',
    conflictCard: 'idea',
    conflictDiscord: ['done'],
    conflictSince: iso(env.clock.now()),
  }), { actor: 'memento', via: 'sync', change: 'conflict', reason: 'fixture-conflict' });
  env.writeFile('cards/20260101-zzzz.md', Buffer.from([0xff, 0xfe, 0x00, 0xff]));

  const state = await api.state();
  assert.equal(state.schema, BOARD_STATE_SCHEMA);
  assert.deepEqual(validateBoardState(state).errors, []);
  assert.equal(state.statuses.length, 7);
  const longCard = state.cards.find((card) => card.id === truncated.id);
  assert.equal(longCard.originalTruncated, true);
  assert.ok(Buffer.byteLength(longCard.original, 'utf8') <= 4096);
  assert.equal(longCard.log.length, 10);
  assert.equal(longCard.log[0].reason, 'fixture-12');
  assert.equal(longCard.log[9].reason, 'fixture-3');
  assert.equal(Object.hasOwn(longCard.log[0], 'eventId'), false);
  const conflictCard = state.cards.find((card) => card.id === conflicted.id);
  assert.deepEqual(conflictCard.conflict, { card: 'idea', discord: ['done'], since: iso(env.clock.now()) });
  const unreadable = state.cards.find((card) => card.id === '20260101-zzzz');
  assert.deepEqual(unreadable, { id: '20260101-zzzz', unreadable: 'utf8', log: [] });

  env.receipts.append({ event: 'sync-complete', reason: 'startup' });
  assert.ok(Number.isFinite(Date.parse((await api.state()).lastSync)));
  assert.ok((await api.state()).unpushedCommits >= 1);
  await env.store.push();
  assert.equal((await api.state()).unpushedCommits, 0);
});

test('Test_Handle_validates_exact_keys_in_the_contract_order', async () => {
  const env = await setup();
  const api = await env.api();
  const { card } = await linkedFixture(env);

  const cases = [
    [{ action: 'setStatus', id: card.id, status: 'done', rev: card.rev, requestId: 'r1', extra: 1 }, 400, 'BAD_REQUEST'],
    [{ action: 'setStatus', id: card.id, status: 'done', rev: card.rev }, 400, 'BAD_REQUEST'],
    [{ action: 'wrong', id: card.id, status: 'done', rev: card.rev, requestId: 'r2' }, 400, 'BAD_REQUEST'],
    [{ action: 'setStatus', id: card.id, status: 'done', rev: 0, requestId: 'r3' }, 400, 'BAD_REQUEST'],
    [{ action: 'setStatus', id: card.id, status: 'done', rev: card.rev, requestId: '' }, 400, 'BAD_REQUEST'],
    [{ action: 'setStatus', id: card.id, status: 'shipped', rev: card.rev, requestId: 'r4' }, 400, 'BAD_STATUS'],
    [{ action: 'setStatus', id: '20260101-abcd', status: 'done', rev: 99, requestId: 'r5' }, 400, 'UNKNOWN_CARD'],
    [{ action: 'setStatus', id: card.id, status: 'done', rev: card.rev - 1, requestId: 'r6' }, 409, 'STALE'],
  ];
  for (const [body, status, code] of cases) {
    const reply = await api.handle(body);
    assert.equal(reply.status, status, JSON.stringify(body));
    assert.equal(reply.body.code, code, JSON.stringify(body));
    assert.equal(validateReply(reply), true);
  }
  assert.equal((await api.handle({ action: 'setStatus', id: 'bad', status: 'done', rev: 1, requestId: 'r7' })).body.code, 'UNKNOWN_CARD');
  assert.equal((await api.handle(null)).body.code, 'BAD_REQUEST');
  assert.equal((await env.card(card.id)).rev, card.rev, 'no rejected call writes a card');
});

test('Test_Handle_returns_the_first_reply_for_a_repeated_requestId', async () => {
  const env = await setup();
  const api = await env.api();
  const { card } = await linkedFixture(env);
  const body = pick(card, 'building', 'req-dedupe');

  const first = await api.handle(body);
  const second = await api.handle(body);
  assert.deepEqual(second, first);
  const afterFirst = await env.card(card.id);
  assert.equal(first.body.rev, afterFirst.rev);
  assert.equal(afterFirst.log.filter((entry) => entry.via === 'board').length, 1,
    'one board event for a repeated requestId');

  const concurrentBody = pick(afterFirst, 'done', 'req-concurrent');
  const [left, right] = await Promise.all([api.handle(concurrentBody), api.handle(concurrentBody)]);
  assert.deepEqual(left, right);
  const afterConcurrent = await env.card(card.id);
  assert.equal(left.body.rev, afterConcurrent.rev);
  assert.equal(afterConcurrent.log.filter((entry) => entry.via === 'board').length, 2,
    'one board event for the concurrent pair');
});

test('Test_Unlinked_card_writes_locally_with_discord_off', async () => {
  const env = await setup();
  const api = await env.api();
  const card = await env.newCard();
  const before = env.mutations().length;
  const reply = await api.handle(pick(card, 'planned', 'req-off'));
  assert.equal(reply.status, 200);
  assert.equal(reply.body.discord, 'off');
  assert.equal(env.mutations().length, before);
  assert.equal((await env.card(card.id)).status, 'planned');
});

test('Test_Board_pick_pushes_the_guarded_status_write', async () => {
  const env = await setup();
  const api = await env.api();
  const { card, thread } = await linkedFixture(env);

  const reply = await api.handle(pick(card, 'building', 'req-push'));
  assert.equal(reply.status, 200);
  assert.equal(reply.body.discord, 'pushed');
  assert.equal(reply.body.rev, (await env.card(card.id)).rev);
  assert.ok(reply.body.rev > card.rev);
  assert.equal(validateReply(reply), true);
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.building]);

  const stored = await env.card(card.id);
  assert.equal(stored.status, 'building');
  assert.equal(stored.discordBase, 'building');
  assert.equal(stored.discordState, 'linked');
  const state = env.readState();
  assert.equal(state.pending.length, 0);
  assert.equal(state.recentWrites.length, 1);
  const write = state.recentWrites[0];
  assert.equal(write.thread, thread.id);
  assert.equal(write.cardId, card.id);
  assert.ok(Date.parse(write.t0) && Date.parse(write.patchAt) && write.key);
  const patches = env.patches();
  assert.equal(patches.length, 1);
  assert.equal(decodeURIComponent(patches[0].auditReasonHeader), `memento-board ${write.key}`);
  assert.deepEqual(patches[0].body.applied_tags, [env.tags.building]);
});

test('Test_Archived_thread_pick_unarchives_the_patch', async () => {
  const env = await setup();
  const api = await env.api();
  const { card, thread } = await linkedFixture(env, {
    thread: { archived: true, archiveTimestamp: iso(env.clock.now()) },
  });

  const reply = await api.handle(pick(card, 'done', 'req-archived'));
  assert.equal(reply.body.discord, 'pushed');
  const patches = env.patches();
  assert.equal(patches.length, 1);
  assert.equal(patches[0].body.archived, false);
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.done]);
});

test('Test_Owner_phone_change_provably_earlier_lets_the_board_value_win', async () => {
  const env = await setup();
  const api = await env.api();
  const { card, thread } = await linkedFixture(env);

  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.researching] });
  env.clock.advance(10_000);
  const reply = await api.handle(pick(card, 'done', 'req-order-a'));
  assert.equal(reply.body.discord, 'pushed');
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.done]);
  const stored = await env.card(card.id);
  assert.equal(stored.status, 'done');
  assert.equal(stored.discordState, 'linked');
});

test('Test_Unproven_order_keeps_the_card_value_and_marks_a_conflict', async () => {
  const env = await setup();
  const api = await env.api();
  const { card, thread } = await linkedFixture(env);

  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.researching] });
  env.clock.advance(2_000);
  const reply = await api.handle(pick(card, 'done', 'req-overlap'));
  assert.equal(reply.status, 200);
  assert.equal(reply.body.discord, 'conflict');
  assert.equal(env.patches().length, 0, 'a conflict never patches');
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.researching]);
  const stored = await env.card(card.id);
  assert.equal(stored.discordState, 'conflict');
  assert.equal(stored.status, 'done');
  assert.deepEqual(stored.conflictDiscord, ['researching']);
  assert.equal(stored.conflictCard, 'done');
});

test('Test_Partial_audit_coverage_refuses_to_push_before_the_recheck', async () => {
  const env = await setup();
  await env.syncState({ audit: { lastEntryId: null, coveredSince: null, ingested: [] } });
  const api = await env.api();
  const { card, thread } = await linkedFixture(env);

  const reply = await api.handle(pick(card, 'done', 'req-partial'));
  assert.equal(reply.body.discord, 'conflict');
  assert.equal(env.patches().length, 0);
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.idea]);
  assert.equal((await env.card(card.id)).discordState, 'conflict');
});

test('Test_Skewed_clock_widens_the_board_interval_into_a_conflict', async () => {
  const env = await setup();
  const state = env.readState();
  await env.store.writeSyncState({
    ...state,
    clock: { ...state.clock, offsetMs: 3_000, rttMs: 0 },
  });
  const api = await env.api();
  const { card, thread } = await linkedFixture(env);

  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.researching] });
  env.clock.advance(2_000);
  const reply = await api.handle(pick(card, 'done', 'req-skew'));
  assert.equal(reply.body.discord, 'conflict');
  assert.equal(env.patches().length, 0);
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.researching]);
});

test('Test_Board_pick_resolves_invalid_and_conflict_cards', async () => {
  const env = await setup();
  const api = await env.api();

  const invalidCard = await env.newCard({ title: '무효 카드' });
  const invalidThread = env.seedThread({
    name: invalidCard.title, appliedTags: [], content: invalidCard.original,
  });
  const linkedInvalid = await env.linkCard(invalidCard, invalidThread, 'idea');
  const invalid = await env.updateCard(linkedInvalid.id, (card) => ({ ...card, discordState: 'invalid' }), {
    at: iso(env.clock.now()), actor: 'memento', via: 'sync', change: 'invalid-remote', reason: 'no-status-tag',
  });
  env.clock.advance(1_000);
  const invalidReply = await api.handle(pick(invalid, 'done', 'req-invalid'));
  assert.equal(invalidReply.body.discord, 'pushed');
  assert.deepEqual(env.remoteTags(invalidThread.id), [env.tags.done]);
  const afterInvalid = await env.card(invalid.id);
  assert.equal(afterInvalid.discordState, 'linked');
  assert.equal(Object.hasOwn(afterInvalid, 'conflictDiscord'), false);

  const conflictCard = await env.newCard({ title: '충돌 카드' });
  const conflictThread = env.seedThread({
    name: conflictCard.title, appliedTags: [env.tags.held], content: conflictCard.original,
  });
  const linkedConflict = await env.linkCard(conflictCard, conflictThread, 'held');
  const conflicted = await env.updateCard(linkedConflict.id, (card) => ({
    ...card,
    discordState: 'conflict',
    conflictCard: 'idea',
    conflictDiscord: ['held'],
    conflictSince: iso(env.clock.now()),
  }), { actor: 'memento', via: 'sync', change: 'conflict', reason: 'fixture-conflict' });
  env.clock.advance(1_000);
  const conflictReply = await api.handle(pick(conflicted, 'dropped', 'req-conflict'));
  assert.equal(conflictReply.body.discord, 'pushed');
  assert.deepEqual(env.remoteTags(conflictThread.id), [env.tags.dropped]);
  const afterConflict = await env.card(conflicted.id);
  assert.equal(afterConflict.status, 'dropped');
  assert.equal(afterConflict.discordState, 'linked');
  assert.equal(Object.hasOwn(afterConflict, 'conflictSince'), false);
});

test('Test_Owner_edit_between_the_reread_and_the_patch_is_restored_as_a_conflict', async (t) => {
  const env = await setup();
  const api = await env.api();
  const { card, thread } = await linkedFixture(env);

  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const pending = api.handle(pick(card, 'done', 'req-race'));
  await hold.arrived;
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  hold.release();
  const reply = await pending;

  assert.equal(reply.status, 200);
  assert.equal(reply.body.discord, 'conflict');
  assert.equal(env.patches().length, 2, 'our patch and the owner restore');
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.held]);
  const stored = await env.card(card.id);
  assert.equal(stored.discordState, 'conflict');
  assert.equal(stored.conflictCard, 'done');
  assert.deepEqual(stored.conflictDiscord, ['done', 'held']);
  assert.equal(env.readState().pending.length, 0);
  const restore = env.patches()[1];
  assert.match(decodeURIComponent(restore.auditReasonHeader), /^memento-board .+ restore$/);
  assert.deepEqual(restore.body.applied_tags, [env.tags.held]);
  t.diagnostic(JSON.stringify({
    restoredTags: env.remoteTags(thread.id),
    heldTag: env.tags.held,
    conflictCard: stored.conflictCard,
    conflictDiscord: stored.conflictDiscord,
    patches: env.patches().length,
  }));
});

test('Test_Held_discord_response_replies_pending_within_the_write_slot_and_finishes_after', async (t) => {
  const env = await setup();
  const { card, thread } = await linkedFixture(env);
  const fakeStart = env.clock.now();
  const wallStart = performance.now();
  const api = await env.api({ now: () => fakeStart + performance.now() - wallStart });

  function bounded(promise, label) {
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 10_000);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  const hold = env.fake.hooks.holdNext({ method: 'GET', path: `/channels/${thread.id}` });
  try {
    const started = performance.now();
    const pending = api.handle(pick(card, 'done', 'req-held'));
    await bounded(hold.arrived, 'held GET');
    const reply = await bounded(pending, 'pending reply');
    const elapsed = performance.now() - started;

    assert.equal(reply.status, 200);
    assert.equal(reply.body.discord, 'pending');
    assert.ok(elapsed < 2_200, `reply took ${elapsed} ms`);
    assert.equal(env.readState().pending.length, 1);

    hold.release();
    await bounded(api.whenIdle(), 'released continuation');
    t.diagnostic(JSON.stringify({ elapsedMs: elapsed, reply: reply.body }));
    assert.equal(env.readState().pending.length, 0);
    assert.deepEqual(env.remoteTags(thread.id), [env.tags.done]);
    const stored = await env.card(card.id);
    assert.equal(stored.status, 'done');
    assert.equal(stored.discordState, 'linked');
    assert.equal(env.readState().recentWrites.length, 1);
  } finally {
    hold.release();
    api.abort();
    try {
      await bounded(api.whenIdle(), 'continuation cleanup');
    } finally {
      await bounded(env.close(), 'held response fixture cleanup');
    }
  }
});

test('Test_Shutdown_aborts_the_continuation_and_leaves_a_durable_pending_op', async () => {
  const env = await setup();
  const api = await env.api();
  const { card, thread } = await linkedFixture(env);

  const hold = env.fake.hooks.holdNext({ method: 'GET', path: `/channels/${thread.id}` });
  const pending = api.handle(pick(card, 'done', 'req-abort'));
  await hold.arrived;
  api.abort();
  hold.release();
  const reply = await pending;
  assert.equal(reply.body.discord, 'pending');
  await api.whenIdle();

  const state = env.readState();
  assert.equal(state.pending.length, 1);
  const op = state.pending[0];
  assert.equal(op.kind, 'status');
  assert.equal(op.thread, thread.id);
  assert.equal(op.cardId, card.id);
  assert.ok(op.key && op.t0 && op.eventId);
  assert.equal(state.recentWrites.length, 0);
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.idea]);

  const run = await env.run();
  assert.equal(run.ok, true);
  assert.equal(env.readState().pending.length, 0);
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.done]);
  assert.equal((await env.card(card.id)).discordBase, 'done');
});

test('Test_Failed_patch_keeps_the_pending_op_and_the_sync_completes_it', async () => {
  const env = await setup();
  const api = await env.api();
  const { card, thread } = await linkedFixture(env);
  env.fake.hooks.forceStatus({ method: 'PATCH', path: `/channels/${thread.id}`, status: 500 });

  const reply = await api.handle(pick(card, 'done', 'req-fail'));
  assert.equal(reply.body.discord, 'pending');
  const state = env.readState();
  assert.equal(state.pending.length, 1);
  assert.ok(state.pending[0].key);
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.idea]);

  const run = await env.run();
  assert.equal(run.ok, true);
  assert.equal(env.readState().pending.length, 0);
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.done]);
});

test('Test_Busy_only_when_the_write_lock_is_held_and_never_for_a_running_sync', async () => {
  const env = await setup();
  const api = await env.api();
  const { card } = await linkedFixture(env);

  const writeLock = await acquire(env.repo, 'write', { waitMs: 0, now: env.clock.now });
  const busy = await api.handle(pick(card, 'done', 'req-busy'));
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'BUSY');
  assert.equal(validateReply(busy), true);
  await release(writeLock);

  const retry = await api.handle(pick(card, 'done', 'req-busy-retry'));
  assert.equal(retry.status, 200, 'a new requestId proceeds after BUSY');

  const syncLock = await acquire(env.repo, 'sync', { waitMs: 0, now: env.clock.now });
  try {
    const reply = await api.handle(pick(await env.card(card.id), 'planned', 'req-with-sync'));
    assert.equal(reply.status, 200);
    assert.notEqual(reply.body.code, 'BUSY');
  } finally {
    await release(syncLock);
  }
});

test('Test_Two_instances_publish_one_api_and_only_remove_their_own', async () => {
  const env = await setup();
  const first = await env.api();
  const second = await env.api();
  const key = Symbol.for('omo.memento.api.v1');

  try {
    assert.equal(first.publish().published, true);
    assert.equal(second.publish().published, false);
    assert.equal(globalThis[key], first.publishedObject());
    assert.equal(second.unpublish(), false);
    assert.equal(globalThis[key], first.publishedObject());
    assert.equal(first.unpublish(), true);
    assert.equal(globalThis[key], undefined);
    const state = await first.state();
    assert.deepEqual(validateBoardState(state).errors, []);
    assert.equal(Object.keys(first.publishedObject()).length, 4);
  } finally {
    delete globalThis[key];
  }
});

test('Test_Replies_and_receipts_never_carry_the_token', async () => {
  const env = await setup();
  const api = await env.api();
  const { card } = await linkedFixture(env);
  const replies = [];
  replies.push(await api.handle(pick(card, 'done', 'req-token')));
  replies.push(await api.handle(pick(card, 'done', 'req-token-stale')));
  replies.push(await api.handle({ action: 'setStatus', id: card.id, status: 'done', rev: 1, requestId: 'x', extra: true }));
  const material = `${JSON.stringify(await api.state())}\n${JSON.stringify(replies)}\n${env.receiptsText()}`;
  assert.equal(material.includes('synthetic-board-api-token-0123456789'), false);
});

test('Test_Unreadable_cards_are_reported_and_never_written', async () => {
  const env = await setup();
  const api = await env.api();
  env.writeFile('cards/20260102-wxyz.md', 'not a card\n');
  const before = env.mutations().length;
  const state = await api.state();
  assert.equal(state.cards.some((card) => card.id === '20260102-wxyz' && card.unreadable), true);
  const reply = await api.handle({
    action: 'setStatus', id: '20260102-wxyz', status: 'done', rev: 1, requestId: 'req-unreadable',
  });
  assert.equal(reply.body.code, 'UNKNOWN_CARD');
  assert.equal(env.mutations().length, before);
});
