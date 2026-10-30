// NOTE-1 round 5: two board picks on one card whose write-throughs both leave a pending op, through
// the real api.mjs with the audit read forced to 500 twice. The phone change lands 500 ms before or
// after the last pick; the order is not provable, so the card must stay in conflict with the board
// value, and four quiet syncs must not PATCH, log or write a receipt.
// Fake clock only; no sleeps. api.whenIdle() is bounded by the test timeout.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { makeApiEnv } from './fixtures/api/harness.mjs';

const envs = [];
afterEach(async () => { for (const env of envs.splice(0)) await env.close(); });
const MIN = 60_000;
const MEMBER = '999999999999999999';

async function snap(env, card, thread) {
  const c = await env.card(card.id);
  const remote = env.remoteTags(thread.id)
    .map((id) => Object.keys(env.tags).find((k) => env.tags[k] === id)).filter(Boolean).sort();
  return {
    state: c.discordState, status: c.status, conflictCard: c.conflictCard ?? null,
    candidates: c.conflictDiscord ?? null, remote,
    log: c.log.length, mut: env.mutations().length, pending: (env.readState().pending ?? []).length,
    rc: env.receiptsText().split(/\r?\n/).filter((l) => l && !/"event":"sync-(start|complete)"/.test(l)).length,
  };
}

async function conflicted(env) {
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: `${card.title}\n\n${card.original}`,
  });
  await env.linkCard(card, thread, 'idea');
  await env.run();
  env.clock.advance(MIN);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.researching], userId: MEMBER });
  env.clock.advance(MIN);
  await env.run();
  assert.equal((await env.card(card.id)).discordState, 'conflict', 'member conflict');
  return { card, thread };
}

async function pick(env, api, card, status, tag) {
  const current = await env.card(card.id);
  const reply = await api.handle({ action: 'setStatus', id: current.id, status, rev: current.rev, requestId: `req-${tag}` });
  await api.whenIdle();
  return reply;
}

for (const gap of [500, -500]) {
  test(`Test_Api_two_pending_board_ops_phone_gap_${gap}ms_stays_conflicted`, async () => {
    const env = await makeApiEnv();
    envs.push(env);
    const api = await env.api({ replyBudgetMs: 30_000 });
    const { card, thread } = await conflicted(env);
    env.clock.advance(MIN);
    env.fake.hooks.forceStatus({ method: 'GET', path: /\/audit-logs$/, status: 500, body: { message: 'synthetic' }, times: 2 });
    const r1 = await pick(env, api, card, 'planned', `a${gap}`);
    env.clock.advance(20_000);
    if (gap < 0) {
      env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
      env.clock.advance(-gap);
    }
    const r2 = await pick(env, api, card, 'done', `b${gap}`);
    assert.equal(r1.body?.discord, 'pending', 'first write-through left pending');
    assert.equal(r2.body?.discord, 'pending', 'second write-through left pending');
    const afterPicks = await snap(env, card, thread);
    assert.equal(afterPicks.pending, 2, 'two pending ops on one card');
    if (gap > 0) {
      env.clock.advance(gap);
      env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
    }
    env.clock.advance(MIN);
    await env.run();
    const s1 = await snap(env, card, thread);
    assert.equal(s1.pending, 0, 'pending ops consumed');
    assert.equal(s1.state, 'conflict', 'order not provable -> conflict');
    assert.equal(s1.status, 'done', 'card keeps the board value');
    assert.equal(s1.conflictCard, 'done', 'board value kept as the conflict card value');
    assert.deepEqual(s1.remote, ['building'], 'phone tag left as the phone set it');
    for (let i = 0; i < 4; i += 1) {
      env.clock.advance(10 * MIN);
      await env.run();
      const q = await snap(env, card, thread);
      assert.deepEqual(q.remote, s1.remote, 'quiet: remote');
      assert.equal(q.state, s1.state, 'quiet: state');
      assert.equal(q.status, s1.status, 'quiet: status');
      assert.deepEqual(q.candidates, s1.candidates, 'quiet: candidates');
      assert.equal(q.mut, s1.mut, 'quiet: PATCH count');
      assert.equal(q.log, s1.log, 'quiet: log length');
      assert.equal(q.rc, s1.rc, 'quiet: receipts');
    }
  });
}
