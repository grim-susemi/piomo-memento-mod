import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { makeSyncEnv } from './fixtures/sync/harness.mjs';

const envs = [];
const iso = (ms) => new Date(ms).toISOString();
const SCHEMA = 'memento.restore.v1';

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

async function boardStatus(env, card, to, eventId) {
  return env.updateCard(card.id, (current) => ({ ...current, status: to }), {
    actor: 'owner', via: 'board', change: 'status', from: card.status, to,
    reason: 'owner-board', eventId,
  });
}

async function conflictCard(env, card, discord) {
  return env.updateCard(card.id, (current) => ({
    ...current,
    discordState: 'conflict',
    conflictCard: current.status,
    conflictDiscord: discord,
    conflictSince: iso(env.clock.now()),
  }), { actor: 'memento', via: 'sync', change: 'conflict', reason: 'fixture-conflict' });
}

function receipts(env) {
  const path = join(env.agentDir, 'logs', 'memento.jsonl');
  try {
    return readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function writePending(env, op) {
  const state = env.readState();
  await env.store.writeSyncState({
    ...state,
    restoreContract: SCHEMA,
    pending: [...(state.pending ?? []), op],
  });
}

async function measured(env) {
  const state = env.readState();
  await env.store.writeSyncState({ ...state, ownerAuditDelayMs: 1_000 });
}

function shapeA(env, card, thread, overrides = {}) {
  return {
    kind: 'status', intent: 'restore', schema: SCHEMA, writer: 'sync',
    key: 'sync-fixture-restore', thread: thread.id, cardId: card.id,
    t0: iso(env.clock.now() - 5_000), patchAt: iso(env.clock.now() - 4_000),
    eventId: 'board-op', targetStatus: 'held', reason: 'owner-race',
    ownerStatus: 'held', pushedStatus: 'done',
    ownerEntryId: '20260101000000000000000000000001',
    conflictSince: iso(env.clock.now() - 3_000), attempts: 0,
    ...overrides,
  };
}

function shapeB(env, card, thread, overrides = {}) {
  return {
    kind: 'status', intent: 'restore', schema: SCHEMA, writer: 'board',
    key: 'board-fixture-reassert', thread: thread.id, cardId: card.id,
    t0: iso(env.clock.now() - 5_000), patchAt: iso(env.clock.now() - 4_000),
    eventId: 'board-op', targetStatus: 'done', reason: 'superseded-reassert',
    attempts: 0, ...overrides,
  };
}

test('Test_Restore_advertises_the_shared_contract_marker', async () => {
  const env = await setup();
  const result = await env.run();
  assert.equal(result.ok, true);
  assert.equal(env.readState().restoreContract, SCHEMA);
});

test('Test_Restore_consumes_exact_17_keys_with_complete_audit_proof', async () => {
  // Given a board event, one owner entry and a complete audit page; when resumed;
  // then the owner tag is reasserted and the card conflict is unchanged.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  const opCard = await boardStatus(env, card, 'done', 'board-op');
  const owner = env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.fake.state.channels.get(thread.id).applied_tags = [env.tags.done];
  const conflicted = await conflictCard(env, opCard, ['held', 'done']);
  const op = shapeA(env, opCard, thread, {
    ownerEntryId: owner.id, conflictSince: conflicted.conflictSince,
  });
  assert.equal(Object.keys(op).length, 17);
  await measured(env);
  await writePending(env, op);

  env.clock.advance(5 * 60 * 1_000);
  const result = await env.run();

  assert.equal(result.ok, true);
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.held]);
  assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 0);
  const after = await env.card(card.id);
  assert.equal(after.discordState, 'conflict');
  assert.equal(after.conflictCard, conflicted.conflictCard);
  assert.deepEqual(after.conflictDiscord, ['held', 'done']);
  assert.equal(after.conflictSince, conflicted.conflictSince);
  const completed = receipts(env).find((entry) => entry.event === 'owner-restore-completed');
  assert.equal(completed.proof, 'complete-audit-no-newer');
  const patch = env.requests('PATCH').at(-1);
  assert.equal(decodeURIComponent(patch.auditReasonHeader), 'memento-sync sync-fixture-restore restore');
});

test('Test_Restore_exact_13_keys_uses_a_newer_card_log_event', async () => {
  // Given an old target and a later board status event in the card log;
  // when resumed; then the later event's status wins, not the snapshot target.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.done], content: card.original,
  });
  await linkCard(env, card, thread);
  await boardStatus(env, card, 'done', 'board-op');
  const newer = await boardStatus(env, card, 'held', 'board-newer');
  const op = shapeB(env, newer, thread);
  assert.equal(Object.keys(op).length, 13);
  await measured(env);
  await writePending(env, op);

  env.clock.advance(5 * 60 * 1_000);
  await env.run();

  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.held]);
  assert.equal((await env.card(card.id)).status, 'held');
  assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 0);
  const completed = receipts(env).find((entry) => entry.event === 'owner-restore-completed');
  assert.equal(completed.proof, 'card-log-order');
});

test('Test_Restore_honors_a_newer_phone_entry_from_complete_audit', async () => {
  // Given an owner entry after ownerEntryId; when resumed; then the newer phone
  // status is reasserted, not the stale targetStatus.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  const opCard = await boardStatus(env, card, 'done', 'board-op');
  const older = env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  const newer = env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
  const conflicted = await conflictCard(env, opCard, ['held', 'done']);
  await measured(env);
  await writePending(env, shapeA(env, opCard, thread, {
    ownerEntryId: older.id, conflictSince: conflicted.conflictSince,
  }));

  env.clock.advance(5 * 60 * 1_000);
  await env.run();

  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.building]);
  const after = await env.card(card.id);
  assert.equal(after.discordState, 'conflict');
  assert.equal(after.conflictSince, conflicted.conflictSince);
  const completed = receipts(env).find((entry) => entry.event === 'owner-restore-completed');
  assert.equal(completed.proof, 'owner-audit-order');
  assert.ok(newer.id > older.id);
});

test('Test_Restore_unknown_actor_keeps_uncertainty_without_patch', async () => {
  // Given a later unknown-actor status entry; when resumed; then attribution is
  // unprovable, so no obsolete target is PATCHed and the op stays.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  const opCard = await boardStatus(env, card, 'done', 'board-op');
  const owner = env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.fake.state.channels.get(thread.id).applied_tags = [env.tags.done];
  const conflicted = await conflictCard(env, opCard, ['held', 'done']);
  env.fake.hooks.ownerSetTags({
    threadId: thread.id, appliedTags: [env.tags.done], userId: '1174109840998400099',
  });
  await writePending(env, shapeA(env, opCard, thread, {
    ownerEntryId: owner.id, conflictSince: conflicted.conflictSince,
  }));

  await env.run();

  assert.equal(env.requests('PATCH').length, 0);
  const pending = env.readState().pending.filter((entry) => entry.intent === 'restore');
  assert.equal(pending.length, 1);
  assert.ok(receipts(env).some((entry) => entry.event === 'owner-restore-uncertain'
    && entry.code === 'unknown-actor'));
});

test('Test_Restore_overlapping_intervals_remain_unresolved_without_patch', async () => {
  // Given a board event and a phone entry 500 ms later with the required wider
  // uncertainty windows; when resumed; then the order is unproven and no PATCH occurs.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  const opCard = await boardStatus(env, card, 'done', 'board-op');
  const owner = env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  await boardStatus(env, opCard, 'researching', 'board-later');
  env.clock.advance(500);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
  const conflicted = await conflictCard(env, await env.card(card.id), ['held', 'done']);
  await writePending(env, shapeA(env, opCard, thread, {
    ownerEntryId: owner.id, conflictSince: conflicted.conflictSince,
  }));

  await env.run();

  assert.equal(env.requests('PATCH').length, 0);
  const pending = env.readState().pending.filter((entry) => entry.intent === 'restore');
  assert.equal(pending.length, 1);
  assert.ok(receipts(env).some((entry) => entry.event === 'owner-restore-uncertain'
    && entry.code === 'overlapping-intervals'));
});

test('Test_Restore_13_key_phone_race_in_restore_window_keeps_conflict_and_recovers', async () => {
  // Given an exact 13-key reassert, a later board held pick and a phone dropped
  // during the held restoration PATCH; when 200 returns; then the op/conflict keep
  // dropped and the next sync restores it.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.done], content: card.original,
  });
  await linkCard(env, card, thread);
  await boardStatus(env, card, 'done', 'board-op');
  env.clock.advance(5_000);
  await boardStatus(env, card, 'held', 'board-held');
  const op = shapeB(env, card, thread);
  assert.equal(Object.keys(op).length, 13);
  await measured(env);
  await writePending(env, op);
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });

  const running = env.run();
  await hold.arrived;
  env.clock.advance(10_000);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.dropped] });
  hold.release();
  await running;

  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.held]);
  assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 1);
  assert.ok((await env.card(card.id)).conflictDiscord.includes('dropped'));
  assert.ok(receipts(env).some((entry) => entry.event === 'owner-restore-raced'));

  env.clock.advance(5 * 60 * 1_000);
  await env.run();

  assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 0);
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.dropped]);
});

test('Test_Restore_restore_patch_window_race_keeps_the_op_and_recovers', async () => {
  // Given a held restoration PATCH and an owner change during its window;
  // when the restore returns 200; then 200 is not treated as finality: the op and
  // conflict survive with the newer candidate, and the next sync restores it.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  const opCard = await boardStatus(env, card, 'done', 'board-op');
  const owner = env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.fake.state.channels.get(thread.id).applied_tags = [env.tags.done];
  const conflicted = await conflictCard(env, opCard, ['held', 'done']);
  await measured(env);
  await writePending(env, shapeA(env, opCard, thread, {
    ownerEntryId: owner.id, conflictSince: conflicted.conflictSince,
  }));
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });

  const running = env.run();
  await hold.arrived;
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.dropped] });
  hold.release();
  await running;

  assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 1);
  const raced = env.readState().pending.find((entry) => entry.intent === 'restore');
  assert.equal(raced.attempts, 1);
  assert.ok((await env.card(card.id)).conflictDiscord.includes('dropped'));
  assert.ok(receipts(env).some((entry) => entry.event === 'owner-restore-raced'));
  assert.ok(!receipts(env).some((entry) => entry.event === 'owner-restore-completed'));

  env.clock.advance(5 * 60 * 1_000);
  await env.run();

  assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 0);
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.dropped]);
});

test('Test_Restore_ambiguous_remote_tags_keeps_the_op_without_patch', async () => {
  // Given two status tags on the remote; when resumed; then no PATCH occurs and
  // the durable intent/conflict stays, rather than hiding ambiguity with the old target.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  const opCard = await boardStatus(env, card, 'done', 'board-op');
  env.fake.state.channels.get(thread.id).applied_tags = [env.tags.held, env.tags.done];
  const conflicted = await conflictCard(env, opCard, ['held', 'done']);
  await writePending(env, shapeA(env, opCard, thread, { conflictSince: conflicted.conflictSince }));

  await env.run();

  assert.equal(env.requests('PATCH').length, 0);
  const pending = env.readState().pending.filter((entry) => entry.intent === 'restore');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempts, 1);
  assert.equal((await env.card(card.id)).conflictSince, conflicted.conflictSince);
  assert.ok(receipts(env).some((entry) => entry.event === 'owner-restore-uncertain'
    && entry.code === 'ambiguous-remote-status'));
});

test('Test_Restore_missing_event_order_keeps_the_op_without_patch', async () => {
  // Given an eventId absent from the card log; when resumed; then no PATCH occurs.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.done], content: card.original,
  });
  await linkCard(env, card, thread);
  await boardStatus(env, card, 'done', 'board-op');
  await writePending(env, shapeB(env, card, thread, { eventId: 'missing-event' }));

  await env.run();

  assert.equal(env.requests('PATCH').length, 0);
  const pending = env.readState().pending.filter((entry) => entry.intent === 'restore');
  assert.equal(pending.length, 1);
  assert.ok(receipts(env).some((entry) => entry.event === 'owner-restore-uncertain'
    && entry.code === 'missing-event-order'));
});

test('Test_Restore_superseded_without_proof_does_not_patch_a_different_tag', async () => {
  // Given a reassert target equal to the card status but a different remote tag and
  // no later card-log event; when resumed; then no PATCH occurs and the op stays.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.done], content: card.original,
  });
  await linkCard(env, card, thread);
  await boardStatus(env, card, 'done', 'board-op');
  env.fake.state.channels.get(thread.id).applied_tags = [env.tags.held];
  await conflictCard(env, await env.card(card.id), ['done', 'held']);
  await writePending(env, shapeB(env, card, thread));

  await env.run();

  assert.equal(env.requests('PATCH').length, 0);
  const pending = env.readState().pending.filter((entry) => entry.intent === 'restore');
  assert.equal(pending.length, 1);
  assert.ok(receipts(env).some((entry) => entry.event === 'owner-restore-uncertain'
    && entry.code === 'missing-newer-proof'));
});

test('Test_Restore_missing_target_tag_keeps_the_op_and_counts_an_attempt', async () => {
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.done], content: card.original,
  });
  await linkCard(env, card, thread);
  await boardStatus(env, card, 'done', 'board-op');
  const state = env.readState();
  const { held, ...tagIds } = state.tagIds;
  assert.ok(held);
  await env.store.writeSyncState({
    ...state, tagIds, restoreContract: SCHEMA, pending: [shapeA(env, card, thread)],
  });

  const result = await env.run();

  assert.equal(result.actions.failures >= 1, true);
  const pending = env.readState().pending.filter((entry) => entry.intent === 'restore');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempts, 1);
  assert.ok(receipts(env).some((entry) => entry.event === 'owner-restore-missing-tag'));
  assert.equal(env.requests('PATCH').length, 0);
});

test('Test_Restore_403_keeps_the_op_and_counts_an_attempt', async () => {
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.done], content: card.original,
  });
  await linkCard(env, card, thread);
  const opCard = await boardStatus(env, card, 'done', 'board-op');
  const owner = env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.fake.state.channels.get(thread.id).applied_tags = [env.tags.done];
  await writePending(env, shapeA(env, opCard, thread, { ownerEntryId: owner.id }));
  env.fake.hooks.forceStatus({
    method: 'PATCH', path: `/channels/${thread.id}`, status: 403,
    body: { message: 'Missing Access', code: 50001 },
  });

  const result = await env.run();

  assert.equal(result.actions.failures >= 1, true);
  const pending = env.readState().pending.filter((entry) => entry.intent === 'restore');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempts, 1);
  assert.ok(receipts(env).some((entry) => entry.event === 'owner-restore-retry' && entry.code === 403));
  assert.ok(!receipts(env).some((entry) => entry.event === 'owner-restore-completed'));
});

test('Test_Restore_404_marks_the_card_deleted_and_clears_the_op', async () => {
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.done], content: card.original,
  });
  await linkCard(env, card, thread);
  await boardStatus(env, card, 'done', 'board-op');
  await writePending(env, shapeA(env, card, thread));
  env.fake.hooks.deleteThread(thread.id);

  await env.run();

  assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 0);
  assert.equal((await env.card(card.id)).discordState, 'deleted');
  assert.ok(receipts(env).some((entry) => entry.event === 'owner-restore-deleted'));
});
