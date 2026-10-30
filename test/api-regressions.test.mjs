// Adversarial regressions for the TASK12 module gate (M12-B1..B5).
// Real store, local bare origin and loopback fake Discord only; every wait is an
// exact event (held fake response, barrier) with a bounded deadline.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { validateReply } from '../src/contract.mjs';
import { acquire, release } from '../src/store/lock.mjs';
import { iso, makeApiEnv } from './fixtures/api/harness.mjs';

const envs = [];

async function setup() {
  const env = await makeApiEnv();
  envs.push(env);
  return env;
}

afterEach(async () => {
  for (const env of envs.splice(0)) await env.close();
});

function pick(card, status, requestId) {
  return { action: 'setStatus', id: card.id, status, rev: card.rev, requestId };
}

// Failure guard for exact-event waits: a missing event fails the test instead of
// hanging it. The wait itself is still driven by the event, never by a sleep.
function bounded(promise, label, ms = 10_000) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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

test('Test_Concurrent_board_writes_keep_each_others_pending_op', async () => {
  const env = await setup();
  const api = await env.api({ replyBudgetMs: 30_000 });
  const { card, thread } = await linkedFixture(env);
  const holdA = env.fake.hooks.holdNext({ method: 'GET', path: `/channels/${thread.id}` });
  const holdB = env.fake.hooks.holdNext({ method: 'GET', path: `/channels/${thread.id}` });

  const aPromise = api.handle(pick(card, 'done', 'req-a'));
  await bounded(holdA.arrived, 'hold A');
  const afterA = await env.card(card.id);
  const bPromise = api.handle(pick(afterA, 'held', 'req-b'));
  await bounded(holdB.arrived, 'hold B');

  const parked = env.readState().pending;
  assert.equal(parked.length, 2, 'both unfinished operations are durable');
  const keyA = parked[0].key;
  const keyB = parked[1].key;

  holdA.release();
  const replyA = await aPromise;
  assert.equal(replyA.body.discord, 'pending');
  assert.equal(validateReply(replyA), true);
  const mid = env.readState().pending;
  assert.deepEqual(mid.map((entry) => entry.key), [keyB], 'A cleanup never removes B');
  assert.notEqual(keyA, keyB);
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.idea], 'the superseded request never patches');
  assert.equal((await env.card(card.id)).status, 'held');

  holdB.release();
  const replyB = await bPromise;
  assert.equal(replyB.body.discord, 'pushed');
  assert.equal(env.readState().pending.length, 0);
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.held]);
});

test('Test_Runner_state_write_does_not_drop_a_concurrent_API_pending_op', async (t) => {
  const env = await setup();
  const real = env.store;
  let parkedResolve;
  const parked = new Promise((resolve) => { parkedResolve = resolve; });
  let gateResolve = null;
  let first = true;
  const store = {
    ...real,
    transactSyncState: async (mutate, options) => {
      if (first) {
        first = false;
        parkedResolve();
        await new Promise((resolve) => { gateResolve = resolve; });
      }
      return real.transactSyncState(mutate, options);
    },
  };
  const api = await env.api({ store, replyBudgetMs: 30_000 });
  const { card, thread } = await linkedFixture(env);

  const request = api.handle(pick(card, 'done', 'req-interleave'));
  await bounded(parked, 'parked API transaction');
  const runStarted = Date.now();
  let gateReleased = false;
  const releaseGate = () => {
    if (gateResolve && !gateReleased) {
      gateReleased = true;
      gateResolve();
    }
  };
  let hold = null;
  try {
    const run = await env.run();
    const runMs = Date.now() - runStarted;
    assert.equal(run.ok, true);
    // Registered only after the runner finished, so the hold belongs to the API read.
    hold = env.fake.hooks.holdNext({ method: 'GET', path: `/channels/${thread.id}` });
    releaseGate();
    await bounded(hold.arrived, 'thread read after the transaction');

    const state = env.readState();
    assert.equal(state.pending.some((entry) => entry.cardId === card.id), true, 'API op survived the runner write');
    assert.ok(Number.isFinite(Date.parse(state.clock?.measuredAt)), 'runner clock change survived the API write');

    hold.release();
    const reply = await request;
    assert.equal(validateReply(reply), true);
    const finalState = env.readState();
    t.diagnostic(JSON.stringify({ runMs, reply, pending: finalState.pending, runActions: run.actions }));
    assert.equal(finalState.pending.length, 0);
  } finally {
    hold?.release?.();
    releaseGate();
    await api.whenIdle().catch(() => {});
  }
});

test('Test_Superseded_continuation_never_overwrites_the_newer_pick', async () => {
  const env = await setup();
  const api = await env.api({ replyBudgetMs: 30_000 });
  const { card, thread } = await linkedFixture(env);
  const holdA = env.fake.hooks.holdNext({ method: 'GET', path: `/channels/${thread.id}` });
  const holdB = env.fake.hooks.holdNext({ method: 'GET', path: `/channels/${thread.id}` });

  const aPromise = api.handle(pick(card, 'done', 'req-old'));
  await bounded(holdA.arrived, 'hold old');
  env.clock.advance(10_000);
  const afterA = await env.card(card.id);
  const bPromise = api.handle(pick(afterA, 'held', 'req-new'));
  await bounded(holdB.arrived, 'hold new');

  holdB.release();
  const replyB = await bPromise;
  assert.equal(replyB.body.discord, 'pushed');
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.held]);

  holdA.release();
  const replyA = await aPromise;
  assert.equal(replyA.body.discord, 'pending');
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.held], 'the older continuation never pushes over the newer pick');
  const stored = await env.card(card.id);
  assert.equal(stored.status, 'held');
  assert.equal(stored.discordState, 'linked');
  assert.equal(env.patches().length, 1, 'only the newer request patched');
  assert.equal(env.readState().pending.length, 0);
});

test('Test_Newer_pick_during_the_patch_is_reasserted_and_never_lost', async () => {
  const env = await setup();
  const api = await env.api({ replyBudgetMs: 30_000 });
  const { card, thread } = await linkedFixture(env);
  const holdA = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });

  const aPromise = api.handle(pick(card, 'done', 'req-patch-old'));
  await bounded(holdA.arrived, 'held PATCH');
  env.clock.advance(10_000);
  const afterA = await env.card(card.id);
  const replyB = await api.handle(pick(afterA, 'held', 'req-patch-new'));
  assert.equal(replyB.body.discord, 'pushed');
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.held]);

  holdA.release();
  const replyA = await aPromise;
  assert.equal(replyA.body.discord, 'pending');
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.held], 'the newer pick is reasserted after the stale patch lands');
  const stored = await env.card(card.id);
  assert.equal(stored.status, 'held');
  assert.equal(stored.discordState, 'linked');
  assert.equal(env.readState().pending.length, 0);
  const reassert = env.patches().at(-1);
  assert.equal(decodeURIComponent(reassert.auditReasonHeader).endsWith(' reassert'), true);
});

test('Test_Coverage_is_measured_since_the_agreed_base_not_only_before_t0', async () => {
  const env = await setup();
  const api = await env.api();
  const { card, thread } = await linkedFixture(env);
  const state = env.readState();
  const base = Date.parse(state.bases[card.id]);
  assert.ok(Number.isFinite(base));
  await env.store.writeSyncState({
    ...state,
    audit: { ...state.audit, coveredSince: iso(base + 6_000) },
  });
  env.clock.advance(12_000);

  const reply = await api.handle(pick(card, 'done', 'req-coverage-base'));
  assert.equal(reply.status, 200);
  assert.equal(reply.body.discord, 'conflict');
  assert.equal(env.patches().length, 0);
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.idea]);
  assert.equal((await env.card(card.id)).discordState, 'conflict');
});

test('Test_Denied_owner_restoration_keeps_recovery_evidence_before_contract_adoption', async () => {
  const env = await setup();
  const api = await env.api();
  const { card, thread } = await linkedFixture(env);
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });

  const request = api.handle(pick(card, 'done', 'req-restore-denied'));
  await bounded(hold.arrived, 'held PATCH');
  env.clock.advance(1_000);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.fake.hooks.forceStatus({ method: 'PATCH', path: `/channels/${thread.id}`, status: 403 });
  hold.release();
  const reply = await request;

  assert.equal(reply.status, 200);
  assert.equal(reply.body.discord, 'conflict');
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.done], 'our patch landed, the restoration did not');
  const stored = await env.card(card.id);
  assert.equal(stored.discordState, 'conflict');
  assert.equal(stored.conflictCard, 'done');
  assert.deepEqual(stored.conflictDiscord, ['done', 'held']);

  // The runner has not advertised the shared restore contract, so no pending op
  // is invented; the unverified window stays durable and the receipt names it.
  const state = env.readState();
  assert.equal(state.pending.length, 0);
  assert.equal(state.recentWrites.length, 1, 'the unverified window stays recorded');
  assert.equal(state.recentWrites[0].cardId, card.id);
  assert.match(env.receiptsText(), /board-restore-unadopted/);
  assert.equal(state.restoreContract, undefined, 'the API used the pre-adoption branch');
  assert.equal(state.ownerAuditDelayMs, undefined);
  const originalWrite = structuredClone(state.recentWrites[0]);

  const run = await env.run();
  assert.equal(run.ok, true);
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.held], 'the next sync restores the owner tag');
  assert.equal((await env.card(card.id)).discordState, 'conflict');
  const afterRun = env.readState();
  assert.deepEqual(afterRun.recentWrites, [originalWrite],
    'restoring the tag preserves the exact original key/cardId/t0/patchAt and evidence');
  assert.equal(afterRun.pending.length, 0);
  assert.equal(afterRun.ownerAuditDelayMs, undefined);

  env.clock.advance(6 * 60 * 1_000);
  const unmeasuredRun = await env.run();
  assert.equal(unmeasuredRun.ok, true);
  const unmeasured = env.readState();
  assert.deepEqual(unmeasured.recentWrites, [originalWrite],
    'elapsed time without a measurement cannot retire the original window');
  assert.equal(unmeasured.pending.length, 0);
  assert.equal(unmeasured.ownerAuditDelayMs, undefined);
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.held]);
  const recovered = await env.card(card.id);
  assert.equal(recovered.discordState, 'conflict');
  assert.equal(recovered.conflictCard, 'done');
  assert.deepEqual([...recovered.conflictDiscord].sort(), ['done', 'held']);

  const measured = await env.store.writeSyncState({ ...unmeasured, ownerAuditDelayMs: 1_000 });
  assert.equal(measured.ok, true);
  env.clock.advance(5 * 60 * 1_000);
  const verifiedRun = await env.run();
  assert.equal(verifiedRun.ok, true);
  const verified = env.readState();
  assert.equal(verified.recentWrites.length, 0);
  assert.equal(verified.pending.length, 0);
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.held]);
  const final = await env.card(card.id);
  assert.equal(final.discordState, 'conflict');
  assert.equal(final.conflictCard, recovered.conflictCard);
  assert.deepEqual(final.conflictDiscord, recovered.conflictDiscord);
  assert.equal(final.conflictSince, recovered.conflictSince);
  const receipts = env.receiptsText().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(receipts.some((entry) => entry.event === 'recent-write-owner-race'
    && entry.key === originalWrite.key && entry.source === 'original-window'),
  'retirement requires the complete original audit window, measurement and D');
});

test('Test_Adopted_restore_contract_records_the_shared_pending_op', async () => {
  const env = await setup();
  await env.syncState({ restoreContract: 'memento.restore.v1' });
  const api = await env.api();
  const { card, thread } = await linkedFixture(env);
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });

  const request = api.handle(pick(card, 'done', 'req-restore-adopted'));
  await bounded(hold.arrived, 'held PATCH');
  env.clock.advance(1_000);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.fake.hooks.forceStatus({ method: 'PATCH', path: `/channels/${thread.id}`, status: 403 });
  hold.release();
  const reply = await request;
  assert.equal(reply.body.discord, 'conflict');

  const state = env.readState();
  assert.equal(state.pending.length, 1);
  const op = state.pending[0];
  assert.deepEqual(Object.keys(op).sort(), [
    'attempts', 'cardId', 'conflictSince', 'eventId', 'intent', 'key', 'kind',
    'ownerEntryId', 'ownerStatus', 'patchAt', 'pushedStatus', 'reason', 'schema',
    't0', 'targetStatus', 'thread', 'writer',
  ]);
  assert.equal(op.kind, 'status', 'the shared schema reuses the supported kind');
  assert.equal(op.intent, 'restore');
  assert.equal(op.schema, 'memento.restore.v1');
  assert.equal(op.writer, 'board');
  assert.equal(op.reason, 'owner-race');
  assert.equal(op.cardId, card.id);
  assert.equal(op.thread, thread.id);
  assert.equal(op.targetStatus, 'held');
  assert.equal(op.ownerStatus, 'held');
  assert.equal(op.pushedStatus, 'done');
  assert.equal(op.attempts, 0);
  assert.ok(op.key.endsWith('-restore'));
  assert.ok(op.t0 && op.patchAt && op.eventId && op.ownerEntryId && op.conflictSince);
  assert.equal(state.recentWrites.length, 1);
  assert.match(env.receiptsText(), /board-restore-deferred/);
});

test('Test_Adopted_superseded_reassert_records_the_shared_pending_op', async () => {
  const env = await setup();
  await env.syncState({ restoreContract: 'memento.restore.v1' });
  const api = await env.api({ replyBudgetMs: 30_000 });
  const { card, thread } = await linkedFixture(env);
  const holdA = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });

  const aPromise = api.handle(pick(card, 'done', 'req-reassert-old'));
  await bounded(holdA.arrived, 'held PATCH');
  env.clock.advance(10_000);
  const afterA = await env.card(card.id);
  const replyB = await api.handle(pick(afterA, 'held', 'req-reassert-new'));
  assert.equal(replyB.body.discord, 'pushed');
  env.fake.hooks.forceStatus({ method: 'PATCH', path: `/channels/${thread.id}`, status: 403 });
  holdA.release();
  const replyA = await aPromise;
  assert.equal(replyA.body.discord, 'pending');

  const state = env.readState();
  assert.equal(state.pending.length, 1);
  const op = state.pending[0];
  assert.deepEqual(Object.keys(op).sort(), [
    'attempts', 'cardId', 'eventId', 'intent', 'key', 'kind', 'patchAt',
    'reason', 'schema', 't0', 'targetStatus', 'thread', 'writer',
  ]);
  assert.equal(op.kind, 'status');
  assert.equal(op.intent, 'restore');
  assert.equal(op.schema, 'memento.restore.v1');
  assert.equal(op.writer, 'board');
  assert.equal(op.reason, 'superseded-reassert');
  assert.equal(op.targetStatus, 'held');
  assert.equal(op.attempts, 0);
  assert.ok(op.key.endsWith('-reassert'));
  assert.deepEqual(env.remoteTags(thread.id), [env.tags.done], 'our stale patch landed, the reassert did not');
  assert.equal((await env.card(card.id)).status, 'held');
  assert.match(env.receiptsText(), /board-reassert-deferred/);
});

test('Test_Late_local_board_success_cannot_rewrite_a_newer_pick', async () => {
  const env = await setup();
  const real = env.store;
  let parkedResolve;
  const parked = new Promise((resolve) => { parkedResolve = resolve; });
  let gateResolve = null;
  let gateReleased = false;
  const releaseGate = () => {
    if (gateResolve && !gateReleased) {
      gateReleased = true;
      gateResolve();
    }
  };
  let parkedOnce = false;
  const store = {
    ...real,
    update: async (id, options) => {
      if (!parkedOnce && options?.log?.reason === 'board-push') {
        parkedOnce = true;
        parkedResolve();
        await new Promise((resolve) => { gateResolve = resolve; });
      }
      return real.update(id, options);
    },
  };
  // The parked first write is held until releaseGate, so its reply can only be the
  // 2 s deadline pending reply; that budget is explicit. The newer pick runs on a
  // second instance over the same store with the default budget, so its final reply
  // does not depend on host load.
  const api = await env.api({ store, replyBudgetMs: 2_000 });
  const newer = await env.api();
  const { card, thread } = await linkedFixture(env);

  try {
    const aPromise = api.handle(pick(card, 'done', 'req-late-old'));
    await bounded(parked, 'parked board-push update');
    const replyA = await aPromise;
    assert.equal(replyA.body.discord, 'pending');

    env.clock.advance(10_000);
    const replyB = await newer.handle(pick(await env.card(card.id), 'held', 'req-late-new'));
    assert.equal(replyB.body.discord, 'pushed');

    releaseGate();
    await bounded(api.whenIdle(), 'older continuation');

    const stored = await env.card(card.id);
    assert.equal(stored.status, 'held', 'the newer board pick wins after the parked old success');
    assert.equal(stored.discordBase, 'held');
    assert.equal(stored.discordState, 'linked');
    assert.deepEqual(env.remoteTags(thread.id), [env.tags.held]);
    assert.equal(env.readState().pending.length, 0);
  } finally {
    releaseGate();
    await api.whenIdle().catch(() => {});
    await newer.whenIdle().catch(() => {});
  }
});

test('Test_Newer_phone_choice_during_restoration_survives', async () => {
  const env = await setup();
  await env.syncState({ restoreContract: 'memento.restore.v1' });
  const api = await env.api();
  const { card, thread } = await linkedFixture(env);
  const holdInitial = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const holdRestore = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });

  try {
    const request = api.handle(pick(card, 'done', 'req-restore-newer'));
    await bounded(holdInitial.arrived, 'initial PATCH');
    env.clock.advance(1_000);
    const heldEntry = env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
    holdInitial.release();
    await bounded(holdRestore.arrived, 'restoration PATCH');
    env.clock.advance(10_000);
    const droppedEntry = env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.dropped] });
    holdRestore.release();
    const reply = await request;
    assert.equal(reply.body.discord, 'conflict');

    const stored = await env.card(card.id);
    assert.equal(stored.discordState, 'conflict');
    assert.ok(stored.conflictDiscord.includes('held'));
    assert.ok(stored.conflictDiscord.includes('dropped'), 'the newer phone choice is a shown candidate');
    assert.notEqual(heldEntry.id, droppedEntry.id);

    const state = env.readState();
    const op = state.pending.find((entry) => entry.intent === 'restore');
    assert.ok(op, 'recovery is retained, not cleared by the older restoration success');
    assert.equal(op.targetStatus, 'dropped', 'the recovery target is the latest proven owner choice');
    assert.equal(op.ownerStatus, 'dropped');
    assert.equal(op.ownerEntryId, droppedEntry.id);
    assert.equal(op.pushedStatus, 'held');
    assert.equal(state.recentWrites.length, 1);
    assert.deepEqual(env.remoteTags(thread.id), [env.tags.held]);
  } finally {
    holdInitial.release();
    holdRestore.release();
    await api.whenIdle().catch(() => {});
  }
});

test('Test_Repeated_requestId_returns_the_first_BUSY_reply_and_survives_many_ids', async () => {
  const env = await setup();
  const api = await env.api();
  const { card } = await linkedFixture(env);

  const lock = await acquire(env.repo, 'write', { waitMs: 0 });
  const busy = await api.handle(pick(card, 'done', 'req-sticky-busy'));
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'BUSY');
  await release(lock);
  const repeated = await api.handle(pick(card, 'done', 'req-sticky-busy'));
  assert.deepEqual(repeated, busy, 'the first BUSY reply is the handled reply');

  const loose = await env.newCard();
  const off = await api.handle({ ...pick(loose, 'planned', 'req-keep-off') });
  assert.equal(off.status, 200);
  assert.equal(off.body.discord, 'off');
  for (let index = 0; index < 1_001; index += 1) {
    const malformed = await api.handle({
      action: 'setStatus', id: loose.id, status: 'planned', rev: loose.rev,
      requestId: `bulk-${index}`, extra: true,
    });
    assert.equal(malformed.body.code, 'BAD_REQUEST');
  }
  const kept = await api.handle({ ...pick(loose, 'planned', 'req-keep-off') });
  assert.deepEqual(kept, off, 'no eviction: the handled reply survives 1001 later request ids');
});
