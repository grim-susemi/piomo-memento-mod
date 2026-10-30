// Survivor tests for NOTE-1 r5 mutation check (temp copy only).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const eventId = 'board-' + at + '-' + to;
  await env.updateCard(card.id, (c) => ({ ...c, status: to }), {
    at: iso(at), eventId, actor: 'owner', via: 'board',
    change: 'status', from: current.status, to, reason: 'owner-board',
  });
  return eventId;
}
function opKey(eventId) { return 'board-probe-' + eventId; }
async function leavePending(env, card, thread, eventId) {
  const state = env.readState();
  await env.store.writeSyncState({
    ...state,
    pending: [...(state.pending ?? []), {
      kind: 'status', key: opKey(eventId), thread: thread.id, cardId: card.id,
      t0: iso(env.clock.now()), eventId,
    }],
  });
}
function receipts(env) {
  try {
    return readFileSync(join(env.agentDir, 'logs', 'memento.jsonl'), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => !/^sync-(start|complete)$/.test(r.event));
  } catch { return []; }
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

// S9 (kills M9): a pending op of one card must not suppress the decision of another card's op.
test('Test_Sync_r5_survivor_pending_skip_is_per_card_not_global', async () => {
  const env = await setup();
  const a = await linked(env);
  const b = await linked(env);
  env.clock.advance(MIN);
  const evA = await boardPick(env, a.card, 'planned');
  await leavePending(env, a.card, a.thread, evA);
  env.clock.advance(20_000);
  const evB = await boardPick(env, b.card, 'done');
  await leavePending(env, b.card, b.thread, evB);
  env.clock.advance(MIN);
  await env.run();
  const got = await env.plainClient.getThread(b.thread.id);
  const remote = got.data.applied_tags
    .map((id) => Object.keys(env.tags).find((k) => env.tags[k] === id)).filter(Boolean);
  assert.ok(remote.includes('done'), 'card B board pick is decided and written');
  const rb = receipts(env).filter((r) => r.id === b.card.id && r.key === opKey(evB)).map((r) => r.event);
  assert.ok(rb.includes('pending-status-resumed'), 'card B op gets its own decision');
  assert.ok(!rb.includes('pending-status-subsumed'), 'card B op is not subsumed by card A');
});

// S10 (kills M10, M2, M5, M8, M1): two unfinished ops on one card; the second one is recorded as
// subsumed under that exact event name and leaves state.pending.
test('Test_Sync_r5_survivor_second_op_subsumed_receipt_and_removed', async () => {
  const env = await setup();
  const { card, thread } = await linked(env);
  await memberConflict(env, card, thread);
  env.clock.advance(MIN);
  const ev1 = await boardPick(env, card, 'planned');
  await leavePending(env, card, thread, ev1);
  env.clock.advance(20_000);
  const ev2 = await boardPick(env, card, 'done');
  await leavePending(env, card, thread, ev2);
  env.clock.advance(MIN);
  await env.run();
  const sub = receipts(env).filter((r) => r.event === 'pending-status-subsumed' && r.id === card.id);
  assert.equal(sub.length, 1, 'exactly one subsumed receipt for the second op');
  assert.equal(sub[0].key, opKey(ev2), 'the subsumed receipt names the second op');
  const left = (env.readState().pending ?? []).filter((p) => p.cardId === card.id);
  assert.equal(left.length, 0, 'no pending op left for the card');
});

// S11 (kills M11): the subsumed check runs before the budget check. With the discord budget spent
// after the first op, the second op must still be recorded as subsumed, not left for a later sync.
test('Test_Sync_r5_survivor_second_op_subsumed_even_when_budget_is_spent', async () => {
  const env = await setup();
  const { card, thread } = await linked(env);
  await memberConflict(env, card, thread);
  env.clock.advance(MIN);
  const ev1 = await boardPick(env, card, 'planned');
  await leavePending(env, card, thread, ev1);
  env.clock.advance(20_000);
  const ev2 = await boardPick(env, card, 'done');
  await leavePending(env, card, thread, ev2);
  env.clock.advance(MIN);
  const client = makeClientWrapper(env.client, { perCallMs: 1000, clock: env.clock });
  await env.run({ client, budget: { discordMs: 6000 } });
  const sub = receipts(env).filter((r) => r.event === 'pending-status-subsumed' && r.id === card.id);
  assert.equal(sub.length, 1, 'second op recorded as subsumed while the budget is spent');
  assert.equal(sub[0].key, opKey(ev2));
  const decided2 = receipts(env).filter((r) => r.event === 'pending-status-resumed' && r.key === opKey(ev2));
  assert.equal(decided2.length, 0, 'second op is not decided');
});
