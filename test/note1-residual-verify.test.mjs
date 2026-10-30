// NOTE-1 round 5 residual: a recent write (a board pick that succeeded) on the same card as two
// failed board picks, judged by the pending loop in the same sync as verifyRecentWrites runs.
// Real api.mjs write-through; fake clock only; no sleeps. api.whenIdle() is bounded by the test timeout.
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
    writes: (env.readState().recentWrites ?? []).length,
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

// 'late': the phone change lands 500 ms before the sync, after the two failed picks -> the order is
// not provable, so the card stays in conflict with the board value as conflictCard.
// 'early': the phone change lands 500 ms after the successful PATCH; the two failed picks come 20 s
// later, so they are genuine later owner picks and the last pick wins (linked on 'done').
for (const variant of ['late', 'early']) {
  test(`Test_Sync_recent_write_plus_two_pending_same_card_${variant}_judges_once`, async () => {
    const env = await makeApiEnv();
    envs.push(env);
    const api = await env.api({ replyBudgetMs: 30_000 });
    const { card, thread } = await conflicted(env);
    env.clock.advance(MIN);
    const ok = await pick(env, api, card, 'planned', 'ok');
    assert.equal(ok.body?.discord, 'pushed', 'first board write-through succeeded');
    assert.equal((env.readState().recentWrites ?? []).length, 1, 'successful write-through left a recent write');
    if (variant === 'early') {
      env.clock.advance(500);
      env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
    }
    env.fake.hooks.forceStatus({ method: 'GET', path: /\/audit-logs$/, status: 500, body: { message: 'synthetic' }, times: 2 });
    env.clock.advance(20_000);
    const r2 = await pick(env, api, card, 'researching', 'b');
    env.clock.advance(20_000);
    const r3 = await pick(env, api, card, 'done', 'c');
    const afterPicks = await snap(env, card, thread);
    assert.equal(r2.body?.discord, 'pending', 'second write-through left pending');
    assert.equal(r3.body?.discord, 'pending', 'third write-through left pending');
    assert.equal(afterPicks.pending, 2, 'two pending ops on one card');
    if (variant === 'late') {
      env.clock.advance(500);
      env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
    }
    env.clock.advance(MIN);
    const logBefore = afterPicks.log;
    await env.run();
    const s1 = await snap(env, card, thread);
    console.log(`RESIDUAL-TRACE ${variant} ${JSON.stringify({ afterPicks, s1, logAdded: s1.log - logBefore })}`);
    assert.equal(s1.pending, 0, 'pending ops consumed');
    assert.equal(s1.log - logBefore, 1, 'one judgment row for the card in the sync');
    if (variant === 'late') {
      assert.equal(s1.state, 'conflict', 'order not provable -> conflict');
      assert.equal(s1.status, 'done', 'card keeps the board value');
      assert.equal(s1.conflictCard, 'done', 'board value kept as the conflict card value');
      assert.ok(s1.candidates?.includes('building'), 'owner value stays a conflict candidate');
    } else {
      assert.equal(s1.state, 'linked', 'genuine later pick wins');
      assert.equal(s1.status, 'done', 'last pick is the card value');
      assert.deepEqual(s1.remote, ['done'], 'Discord carries the last pick');
    }
    const settled = s1;
    for (let i = 0; i < 4; i += 1) {
      env.clock.advance(10 * MIN);
      await env.run();
      const q = await snap(env, card, thread);
      assert.deepEqual(q.remote, settled.remote, 'quiet: remote');
      assert.equal(q.state, settled.state, 'quiet: state');
      assert.equal(q.status, settled.status, 'quiet: status');
      assert.deepEqual(q.candidates, settled.candidates, 'quiet: candidates');
      assert.equal(q.mut, settled.mut, 'quiet: PATCH');
      assert.equal(q.log, settled.log, 'quiet: log');
      assert.equal(q.rc, settled.rc, 'quiet: receipts');
    }
  });
}
