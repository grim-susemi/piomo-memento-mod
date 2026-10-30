// NOTE-1 round 4: a board pick whose write-through left its pending op, through the real api.mjs
// with the audit read forced to 500 once. The next sync must keep the conflict, not take the phone.
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
    state: c.discordState, status: c.status, remote,
    log: c.log.length, mut: env.mutations().length, pending: (env.readState().pending ?? []).length,
  };
}

for (const gap of [500, -500]) {
  test(`Test_Api_board_write_through_audit_fail_then_phone_gap_${gap}ms_stays_conflicted`, async () => {
    const env = await makeApiEnv();
    envs.push(env);
    const api = await env.api({ replyBudgetMs: 30_000 });
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
    env.clock.advance(MIN);
    if (gap < 0) {
      env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
      env.clock.advance(-gap);
    }
    env.fake.hooks.forceStatus({
      method: 'GET', path: /\/audit-logs$/, status: 500, body: { message: 'synthetic' }, times: 1,
    });
    const current = await env.card(card.id);
    const reply = await api.handle({ action: 'setStatus', id: current.id, status: 'done', rev: current.rev, requestId: `req-${gap}` });
    await api.whenIdle();
    const afterPick = await snap(env, current, thread);
    assert.equal(reply.body?.discord, 'pending', 'write-through did not finish');
    assert.equal(afterPick.pending, 1, 'write-through left its pending op');
    if (gap > 0) {
      env.clock.advance(gap);
      env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
    }
    env.clock.advance(MIN);
    await env.run();
    const s1 = await snap(env, current, thread);
    assert.equal(s1.state, 'conflict', 'order not provable -> conflict');
    assert.equal(s1.status, 'done', 'card keeps the board value');
    assert.deepEqual(s1.remote, ['building'], 'tag left as the phone set it');
    for (let i = 0; i < 4; i += 1) {
      env.clock.advance(10 * MIN);
      await env.run();
      const row = await snap(env, current, thread);
      assert.deepEqual(row.remote, s1.remote, 'quiet: remote unchanged');
      assert.equal(row.state, s1.state, 'quiet: state unchanged');
      assert.equal(row.status, s1.status, 'quiet: status unchanged');
      assert.equal(row.mut, s1.mut, 'quiet: no PATCH');
      assert.equal(row.log, s1.log, 'quiet: no card-log event');
    }
  });
}
