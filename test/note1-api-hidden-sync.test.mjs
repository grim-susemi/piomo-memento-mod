// NOTE-1 round 3 (B-API-HIDDEN-SYNC): a card already in conflict; the owner's phone sets 'building' with its
// audit entry still hidden; a board pick 'done' follows (write-through answers conflict); then a sync runs while
// the phone entry is STILL hidden. That sync must not PATCH 'done' over the phone value. Plan lines 68/70/71:
// order not provable -> conflict, card value kept, tag left as the owner set it, no PATCH; the conflict ends only
// with the owner's NEXT board pick. Pre-linked controls of the same shape must keep passing.
// Fake clock and fake Discord only; no sleeps.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { makeApiEnv } from './fixtures/api/harness.mjs';

const envs = [];
afterEach(async () => { for (const env of envs.splice(0)) await env.close(); });
const MIN = 60_000;
const MEMBER = '999999999999999999';

const grid = [];
for (const pre of ['conflict', 'linked']) {
  for (const delayMs of [null, 63_529]) {
    for (const gap of [200, 500, 1_500]) grid.push({ pre, delayMs, gap });
  }
}

async function snap(env, card, thread) {
  const c = await env.card(card.id);
  const name = (tid) => Object.keys(env.tags).find((key) => env.tags[key] === tid);
  return {
    state: c.discordState, status: c.status,
    remote: env.remoteTags(thread.id).map(name).filter(Boolean).sort(),
    mut: env.mutations().length,
  };
}

async function setup(env, pre, delayMs) {
  if (delayMs !== null) await env.syncState({ ownerAuditDelayMs: delayMs });
  const api = await env.api({ replyBudgetMs: 30_000 });
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: `${card.title}\n\n${card.original}`,
  });
  await env.linkCard(card, thread, 'idea');
  await env.run();
  if (pre === 'conflict') {
    env.clock.advance(MIN);
    env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.researching], userId: MEMBER });
    env.clock.advance(MIN);
    await env.run();
  }
  assert.equal((await env.card(card.id)).discordState, pre, `precondition: ${pre}`);
  env.clock.advance(10 * MIN);
  return { api, card, thread };
}

async function pick(env, api, card, status, requestId) {
  const current = await env.card(card.id);
  const reply = await api.handle({ action: 'setStatus', id: current.id, status, rev: current.rev, requestId });
  await api.whenIdle();
  return reply.body;
}

for (const { pre, delayMs, gap } of grid) {
  const label = `pre_${pre}_gap_${gap}_delay_${delayMs ?? 'unset'}`;
  test(`Test_Api_note1_hidden_sync_${label}`, async () => {
    const env = await makeApiEnv();
    envs.push(env);
    const { api, card, thread } = await setup(env, pre, delayMs);

    env.fake.hooks.delayAuditVisibility();
    env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
    env.clock.advance(gap);
    const before = await snap(env, card, thread);

    await pick(env, api, card, 'done', `hs-pick-${label}`);
    const afterPick = await snap(env, card, thread);
    assert.equal(afterPick.state, 'conflict', 'write-through: order not provable -> conflict');
    assert.equal(afterPick.status, 'done', 'card keeps the board value');
    assert.equal(afterPick.mut, before.mut, 'write-through: no PATCH');

    env.clock.advance(5_000);
    await env.run();
    const hiddenSync = await snap(env, card, thread);
    assert.equal(hiddenSync.mut, before.mut, 'sync while the phone entry is hidden: no PATCH');
    assert.equal(hiddenSync.state, 'conflict', 'sync while hidden: conflict kept');
    assert.equal(hiddenSync.status, 'done', 'sync while hidden: card keeps the board value');
    assert.deepEqual(hiddenSync.remote, ['building'], 'sync while hidden: phone value stays on the tag');

    env.fake.hooks.releaseAuditVisibility();
    for (let i = 0; i < 4; i += 1) {
      env.clock.advance(65_000);
      await env.run();
      const visible = await snap(env, card, thread);
      assert.equal(visible.mut, before.mut, `visible sync ${i + 1}: no PATCH`);
      assert.equal(visible.state, 'conflict', `visible sync ${i + 1}: conflict stays until the next owner pick`);
      assert.deepEqual(visible.remote, ['building'], `visible sync ${i + 1}: phone value kept`);
    }

    await pick(env, api, card, 'held', `hs-end-${label}`);
    const ended = await snap(env, card, thread);
    assert.equal(ended.state, 'linked', 'owner next pick ends the conflict');
    assert.deepEqual(ended.remote, ['held'], 'owner next pick PATCHes its value');
  });
}
