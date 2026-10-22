import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { openStore } from '../src/store/store.mjs';
import { makeApiEnv } from './fixtures/api/harness.mjs';

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

function bounded(promise, label, ms = 10_000) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

async function linkedFixture(env) {
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title,
    appliedTags: [env.tags.idea],
    content: `${card.title}\n\n${card.original}`,
  });
  return { card: await env.linkCard(card, thread, 'idea'), thread };
}

test('Test_009_unmeasured_restore_retains_until_measurement_and_D', async () => {
  // Given no measured owner audit delay and a hidden dropped choice;
  // when fresh runners pass at 0, 6 and 12 virtual minutes; then both recovery
  // records survive. A supplied measurement plus D and the revealed lower-id
  // owner then permit normal convergence and retirement.
  const env = await setup();
  await env.syncState({ restoreContract: 'memento.restore.v1' });
  const api = await env.api();
  const { card, thread } = await linkedFixture(env);
  const holdInitial = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });

  try {
    const request = api.handle(pick(card, 'done', 'req-unmeasured'));
    await bounded(holdInitial.arrived, 'initial PATCH');
    env.clock.advance(1_000);
    env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
    env.fake.hooks.delayAuditVisibility();
    env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.dropped] });
    holdInitial.release();
    const reply = await request;
    assert.equal(reply.body.discord, 'conflict');
    assert.equal(env.readState().ownerAuditDelayMs, undefined);
    assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 1);
    assert.equal(env.readState().recentWrites.length, 1);

    for (const minutes of [0, 6, 12]) {
      if (minutes > 0) env.clock.advance(6 * 60 * 1_000);
      const store = openStore(env.repo, { sleep: async () => {}, now: env.clock.now });
      await env.run({ store });
      assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 1,
        `unmeasured recovery retained at ${minutes} minutes`);
      assert.equal(env.readState().recentWrites.length, 1,
        `unmeasured original evidence retained at ${minutes} minutes`);
      assert.deepEqual(env.remoteTags(thread.id), [env.tags.held]);
    }

    env.fake.hooks.releaseAuditVisibility();
    const withMeasurement = env.readState();
    await env.store.writeSyncState({ ...withMeasurement, ownerAuditDelayMs: 1_000 });
    const measuredStore = openStore(env.repo, { sleep: async () => {}, now: env.clock.now });
    const final = await env.run({ store: measuredStore });

    assert.equal(final.ok, true);
    assert.deepEqual(env.remoteTags(thread.id), [env.tags.dropped]);
    assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 0);
    assert.equal(env.readState().recentWrites.length, 0);
    assert.ok((await env.card(card.id)).conflictDiscord.includes('dropped'));
  } finally {
    holdInitial.release();
    await api.whenIdle().catch(() => {});
  }
});

test('Test_007_immediate_resume_retains_then_hidden_owner_converges_after_D', async () => {
  // Given API recovery with D=300000 and a hidden later dropped owner choice;
  // when a fresh runner resumes at 0 it must retain evidence, then after reveal
  // and D it must restore the latest choice and retire only verified records.
  const env = await setup();
  await env.syncState({ restoreContract: 'memento.restore.v1', ownerAuditDelayMs: 1_000 });
  const api = await env.api();
  const { card, thread } = await linkedFixture(env);
  const holdInitial = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });

  try {
    const request = api.handle(pick(card, 'done', 'req-retention'));
    await bounded(holdInitial.arrived, 'initial PATCH');
    env.clock.advance(1_000);
    env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
    env.fake.hooks.delayAuditVisibility();
    env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.dropped] });
    holdInitial.release();
    const reply = await request;
    assert.equal(reply.body.discord, 'conflict');
    assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 1);
    assert.equal(env.readState().recentWrites.length, 1);

    const firstStore = openStore(env.repo, { sleep: async () => {}, now: env.clock.now });
    const first = await env.run({ store: firstStore });
    assert.equal(first.ok, true);
    assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 1,
      'immediate success is not retired before D');
    assert.equal(env.readState().recentWrites.length, 1,
      'the other consumer evidence survives the same-pass success');
    assert.deepEqual(env.remoteTags(thread.id), [env.tags.held]);

    env.fake.hooks.releaseAuditVisibility();
    env.clock.advance(6 * 60 * 1_000);
    const secondStore = openStore(env.repo, { sleep: async () => {}, now: env.clock.now });
    const second = await env.run({ store: secondStore });

    assert.equal(second.ok, true);
    assert.deepEqual(env.remoteTags(thread.id), [env.tags.dropped],
      'the revealed lower-id owner choice wins after D');
    assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 0);
    assert.equal(env.readState().recentWrites.length, 0, 'truly verified records retire');
    assert.ok((await env.card(card.id)).conflictDiscord.includes('dropped'));
  } finally {
    holdInitial.release();
    await api.whenIdle().catch(() => {});
  }
});
