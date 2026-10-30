// NOTE-1 round 6: an audit entry the sync's cursor has moved past must reach a card judgment before it
// is dropped. A Discord budget cut between the audit read and the judgment must not turn a phone change
// into a silent overwrite. Fake clock only; no sleeps. Every scenario checks four quiet syncs after the
// sync that judged the card, on owner-visible state (card value, conflict state, Discord tag, PATCH count,
// card log length).
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { makeSyncEnv, makeClientWrapper } from './fixtures/sync/harness.mjs';

const envs = [];
afterEach(async () => { for (const env of envs.splice(0)) await env.close(); });
async function setup() { const env = await makeSyncEnv(); envs.push(env); return env; }

const MIN = 60_000;
const MEMBER = '999999999999999999';
const iso = (ms) => new Date(ms).toISOString();

async function linkCard(env, card, thread, base = 'idea') {
  await env.updateCard(card.id, (current) => ({
    ...current, discordChannel: env.forumId, discordThread: thread.id,
    discordBase: base, discordState: 'linked',
  }), { actor: 'memento', via: 'sync', change: 'link', reason: 'fixture-link' });
  const state = env.readState();
  await env.store.writeSyncState({
    ...state, bases: { ...(state.bases ?? {}), [card.id]: iso(env.clock.now() - 1_000) },
  });
}

async function boardPick(env, card, to, at = env.clock.now()) {
  const current = await env.card(card.id);
  const eventId = `board-${at}-${to}`;
  await env.updateCard(card.id, (c) => ({ ...c, status: to }), {
    at: iso(at), eventId, actor: 'owner', via: 'board',
    change: 'status', from: current.status, to, reason: 'owner-board',
  });
  return eventId;
}

async function leavePending(env, card, thread, eventId) {
  const state = env.readState();
  await env.store.writeSyncState({
    ...state,
    pending: [...(state.pending ?? []), {
      kind: 'status', key: `board-probe-${eventId}`, thread: thread.id, cardId: card.id,
      t0: iso(env.clock.now()), eventId,
    }],
  });
}

async function snap(env, card, thread) {
  const c = await env.card(card.id);
  const got = await env.plainClient.getThread(thread.id);
  const remote = got.data.applied_tags
    .map((id) => Object.keys(env.tags).find((k) => env.tags[k] === id)).filter(Boolean).sort();
  return {
    state: c.discordState, status: c.status, candidates: c.conflictDiscord ?? null,
    remote, log: c.log.length, mut: env.mutations().length,
    conflicts: c.log.filter((e) => e.change === 'conflict').length,
  };
}

async function quiet(env, card, thread, n = 4) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    env.clock.advance(10 * MIN);
    await env.run();
    rows.push(await snap(env, card, thread));
  }
  return rows;
}

function flat(rows, base, msg) {
  for (const row of rows) {
    assert.deepEqual(row.remote, base.remote, `${msg}: remote tag`);
    assert.equal(row.state, base.state, `${msg}: discord state`);
    assert.equal(row.status, base.status, `${msg}: card status`);
    assert.equal(row.mut, base.mut, `${msg}: PATCH count`);
    assert.equal(row.log, base.log, `${msg}: card log length`);
    assert.equal(row.conflicts, base.conflicts, `${msg}: conflict rows`);
  }
}

async function linked(env) {
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  return { card, thread };
}

async function memberConflict(env, card, thread) {
  env.clock.advance(MIN);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.researching], userId: MEMBER });
  env.clock.advance(MIN);
  await env.run();
  assert.equal((await env.card(card.id)).discordState, 'conflict');
}

// The cut run: the Discord budget ends after the audit read has moved the cursor, before this sync
// judges the card (the pending loop or the main loop).
function cutRun(env, discordMs) {
  const client = makeClientWrapper(env.client, { perCallMs: 1000, clock: env.clock });
  return env.run({ client, budget: { discordMs } });
}

// Pending board pick(s) + a phone change 500 ms after the last pick (order not provable) on a card that
// is already in conflict. The cut sync must not consume the phone entry; the next sync shows a conflict
// and keeps 'building' on Discord (plan line 67, IS-2, IS-3).
for (const ops of [2, 1, 0]) {
  test(`budget_cut_after_audit_read_ops_${ops}_keeps_phone_value_as_conflict`, async () => {
    const env = await setup();
    const { card, thread } = await linked(env);
    await memberConflict(env, card, thread);
    env.clock.advance(MIN);
    if (ops === 2) {
      const p1 = await boardPick(env, card, 'planned');
      await leavePending(env, card, thread, p1);
      env.clock.advance(20_000);
    }
    const p2 = await boardPick(env, card, 'done');
    if (ops > 0) await leavePending(env, card, thread, p2);
    env.clock.advance(500);
    env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
    env.clock.advance(MIN);
    await cutRun(env, 4500);
    env.clock.advance(MIN);
    await env.run();
    const s1 = await snap(env, card, thread);
    const rows = await quiet(env, card, thread);
    assert.equal(s1.status, 'done', 'card keeps the board value');
    assert.deepEqual(s1.remote, ['building'], 'phone value not overwritten');
    assert.equal(s1.state, 'conflict', 'order not provable -> conflict');
    flat(rows, s1, 'quiet');
  });
}

// Outage-recovery shape: card B's pending push spends the budget before card A's pending op is judged.
// Card A had a phone change 500 ms after its pick. Its phone entry must survive the cut sync.
for (const discordMs of [6500, 7500]) {
  test(`budget_spent_mid_pending_loop_other_card_keeps_phone_value_${discordMs}`, async () => {
    const env = await setup();
    const a = await linked(env);
    const b = await linked(env);
    await memberConflict(env, a.card, a.thread);
    env.clock.advance(MIN);
    const pb = await boardPick(env, b.card, 'planned');
    await leavePending(env, b.card, b.thread, pb);
    const pa = await boardPick(env, a.card, 'done');
    await leavePending(env, a.card, a.thread, pa);
    env.clock.advance(500);
    env.fake.hooks.ownerSetTags({ threadId: a.thread.id, appliedTags: [env.tags.building] });
    env.clock.advance(MIN);
    await cutRun(env, discordMs);
    env.clock.advance(MIN);
    await env.run();
    const s1 = await snap(env, a.card, a.thread);
    const rows = await quiet(env, a.card, a.thread);
    assert.equal(s1.status, 'done', 'card keeps the board value');
    assert.deepEqual(s1.remote, ['building'], 'phone value not overwritten');
    assert.equal(s1.state, 'conflict', 'order not provable -> conflict');
    flat(rows, s1, 'quiet');
  });
}

// A genuine later phone change (provably after the pick) that is read by a cut sync must still be taken
// by the next sync: the board value is not pushed over it.
test('genuine_later_phone_change_survives_budget_cut_and_is_taken', async () => {
  const env = await setup();
  const { card, thread } = await linked(env);
  env.clock.advance(MIN);
  const pick = await boardPick(env, card, 'done');
  await leavePending(env, card, thread, pick);
  env.clock.advance(10 * MIN);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
  env.clock.advance(MIN);
  await cutRun(env, 4500);
  env.clock.advance(MIN);
  await env.run();
  const s1 = await snap(env, card, thread);
  const rows = await quiet(env, card, thread);
  assert.equal(s1.status, 'building', 'phone value taken');
  assert.equal(s1.state, 'linked');
  assert.deepEqual(s1.remote, ['building']);
  flat(rows, s1, 'quiet');
});

// A member (unknown actor) change read by a cut sync stays a conflict and is never written over.
test('member_entry_survives_budget_cut_and_stays_conflict_without_write', async () => {
  const env = await setup();
  const { card, thread } = await linked(env);
  env.clock.advance(MIN);
  const pick = await boardPick(env, card, 'done');
  await leavePending(env, card, thread, pick);
  env.clock.advance(500);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.researching], userId: MEMBER });
  env.clock.advance(MIN);
  const mut0 = env.mutations().length;
  await cutRun(env, 4500);
  env.clock.advance(MIN);
  await env.run();
  const s1 = await snap(env, card, thread);
  const rows = await quiet(env, card, thread);
  assert.equal(s1.state, 'conflict');
  assert.equal(s1.status, 'done');
  assert.deepEqual(s1.remote, ['researching']);
  assert.equal(s1.mut, mut0, 'no PATCH over the member tag');
  flat(rows, s1, 'quiet');
});

// No entry is judged twice: a cut sync followed by the judging sync leaves exactly one conflict row, and
// the quiet syncs after it add none.
test('cut_then_judged_entry_is_not_judged_again_in_quiet_syncs', async () => {
  const env = await setup();
  const { card, thread } = await linked(env);
  env.clock.advance(MIN);
  const pick = await boardPick(env, card, 'done');
  await leavePending(env, card, thread, pick);
  env.clock.advance(500);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
  env.clock.advance(MIN);
  await cutRun(env, 4500);
  env.clock.advance(MIN);
  await env.run();
  const s1 = await snap(env, card, thread);
  assert.equal(s1.conflicts, 1, 'the phone entry is judged once, into one conflict row');
  const rows = await quiet(env, card, thread);
  flat(rows, s1, 'quiet');
});
