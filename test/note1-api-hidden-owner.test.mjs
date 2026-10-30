// NOTE-1 round 8: an owner tag change the audit log cannot show yet, made shortly BEFORE a board pick,
// must not be overwritten by that pick's PATCH. Plan lines 68/70: order not provable -> conflict, card value
// kept, tag left as the owner set it. Fake clock and fake Discord only; no sleeps.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { makeApiEnv } from './fixtures/api/harness.mjs';

const envs = [];
afterEach(async () => { for (const env of envs.splice(0)) await env.close(); });
const MIN = 60_000;
const MEMBER = '999999999999999999';

function tagNames(env, ids) {
  return ids.map((id) => Object.keys(env.tags).find((key) => env.tags[key] === id)).filter(Boolean).sort();
}

async function snap(env, card, thread) {
  const c = await env.card(card.id);
  return {
    state: c.discordState, status: c.status, remote: tagNames(env, env.remoteTags(thread.id)),
    log: c.log.length, mut: env.mutations().length,
  };
}

async function setup(env, pre) {
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
    assert.equal((await env.card(card.id)).discordState, 'conflict', 'precondition: conflict');
  }
  env.clock.advance(10 * MIN);
  return { api, card, thread };
}

// Owner sets 'building' (audit hidden), then the board pick 'done' follows gap ms later.
async function hiddenPhoneThenPick(env, { api, card, thread }, gap, requestId) {
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
  env.clock.advance(gap);
  const before = await snap(env, card, thread);
  const current = await env.card(card.id);
  await api.handle({ action: 'setStatus', id: current.id, status: 'done', rev: current.rev, requestId });
  await api.whenIdle();
  const afterPick = await snap(env, card, thread);
  return { before, afterPick };
}

async function releaseAndSync(env, card, thread) {
  env.fake.hooks.releaseAuditVisibility();
  for (let i = 0; i < 4; i += 1) {
    env.clock.advance(65_000);
    await env.run();
  }
  return snap(env, card, thread);
}

for (const delayMs of [null, 63_529]) {
  for (const pre of ['conflict', 'linked']) {
    for (const gap of [500, 1_500]) {
      const name = `Test_Api_note1_hidden_phone_${gap}ms_before_pick_pre_${pre}_delay_${delayMs ?? 'unset'}`;
      test(name, async () => {
        const env = await makeApiEnv();
        envs.push(env);
        if (delayMs !== null) await env.syncState({ ownerAuditDelayMs: delayMs });
        const ctx = await setup(env, pre);
        const { before, afterPick } = await hiddenPhoneThenPick(env, ctx, gap, `n1h-${pre}-${delayMs}-${gap}`);
        assert.equal(afterPick.mut, before.mut, 'no PATCH while the phone change is hidden');
        assert.deepEqual(afterPick.remote, ['building'], 'phone value stays on the tag');
        assert.equal(afterPick.state, 'conflict', 'order not provable -> conflict');
        assert.equal(afterPick.status, 'done', 'card keeps the board value');
        const end = await releaseAndSync(env, ctx.card, ctx.thread);
        assert.equal(end.state, 'conflict', 'after the audit shows the change: still conflict, not quiet-linked');
        assert.deepEqual(end.remote, ['building'], 'phone value never silently lost');
        assert.equal(end.mut, before.mut, 'no PATCH at any later sync');
      });
    }
  }
}

test('Test_Api_note1_control_board_pick_without_phone_change_patches_at_once', async () => {
  const env = await makeApiEnv();
  envs.push(env);
  const ctx = await setup(env, 'linked');
  const before = await snap(env, ctx.card, ctx.thread);
  const current = await env.card(ctx.card.id);
  await ctx.api.handle({ action: 'setStatus', id: current.id, status: 'done', rev: current.rev, requestId: 'n1h-control-plain' });
  await ctx.api.whenIdle();
  const after = await snap(env, ctx.card, ctx.thread);
  assert.equal(after.mut, before.mut + 1, 'one PATCH');
  assert.deepEqual(after.remote, ['done'], 'board value on the tag');
});

test('Test_Api_note1_control_phone_change_provably_earlier_with_full_audit_patches', async () => {
  const env = await makeApiEnv();
  envs.push(env);
  const ctx = await setup(env, 'linked');
  env.fake.hooks.ownerSetTags({ threadId: ctx.thread.id, appliedTags: [env.tags.building] });
  env.clock.advance(MIN);
  const before = await snap(env, ctx.card, ctx.thread);
  const current = await env.card(ctx.card.id);
  await ctx.api.handle({ action: 'setStatus', id: current.id, status: 'done', rev: current.rev, requestId: 'n1h-control-earlier' });
  await ctx.api.whenIdle();
  const after = await snap(env, ctx.card, ctx.thread);
  assert.equal(after.mut, before.mut + 1, 'proven order: one PATCH');
  assert.deepEqual(after.remote, ['done'], 'board value on both sides (proven order)');
});
