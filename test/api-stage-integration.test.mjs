// Stage A module integration regression (TASK12 attempt 4).
//
// Delayed lower-id owner evidence -> the API creates the recovery target ->
// a fresh store + the frozen runner consumes it (explicit restore + the
// secondary recentWrites pass). The runner's secondary consumer is known broken
// in this frozen revision, so this target is expected to stay RED until the
// root's Stage B runner fix is frozen; it is recorded, not retried to green.
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
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function linkedFixture(env) {
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title,
    appliedTags: [env.tags.idea],
    content: `${card.title}\n\n${card.original}`,
  });
  const linked = await env.linkCard(card, thread, 'idea');
  return { card: linked, thread };
}

test('Test_Delayed_lower_id_owner_choice_creates_recovery_and_the_secondary_pass_converges', async (t) => {
  const env = await setup();
  await env.syncState({ restoreContract: 'memento.restore.v1' });
  const api = await env.api();
  const { card, thread } = await linkedFixture(env);
  const holdInitial = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const holdRestore = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });

  try {
    const request = api.handle(pick(card, 'done', 'req-delayed-lower'));
    await bounded(holdInitial.arrived, 'initial PATCH');
    env.clock.advance(1_000);
    const heldEntry = env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
    // Hide the later owner choice; it is created before the bot PATCH entry, so
    // its snowflake id is lower than the cursor that bot entry establishes.
    env.fake.hooks.delayAuditVisibility();
    const droppedEntry = env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.dropped] });
    holdInitial.release();
    await bounded(holdRestore.arrived, 'restoration PATCH');
    env.fake.hooks.releaseAuditVisibility();
    holdRestore.release();
    const reply = await request;
    assert.equal(reply.body.discord, 'conflict');

    const botTagEntries = env.fake.state.audit
      .filter((entry) => entry.action_type === 111 && entry.user_id === env.fake.ids.botUserId
        && typeof entry.reason === 'string' && entry.reason.startsWith('memento-board'));
    const highestBotId = botTagEntries.reduce((best, entry) => (best === null
      || BigInt(entry.id) > BigInt(best) ? entry.id : best), null);
    assert.ok(highestBotId, 'the bot PATCH entries exist');
    assert.ok(BigInt(droppedEntry.id) < BigInt(highestBotId),
      'the late owner choice sits below the bot cursor');
    assert.notEqual(heldEntry.id, droppedEntry.id);

    // Intermediate evidence: the API must see the late lower-id choice through a
    // full-window read and keep a recovery target naming it.
    const stored = await env.card(card.id);
    assert.equal(stored.discordState, 'conflict');
    assert.ok(stored.conflictDiscord.includes('held'));
    assert.ok(stored.conflictDiscord.includes('dropped'), 'the late lower-id choice is a conflict candidate');
    const state = env.readState();
    const op = state.pending.find((entry) => entry.intent === 'restore');
    assert.ok(op, 'the API creates the durable recovery');
    assert.equal(op.targetStatus, 'dropped');
    assert.equal(op.ownerEntryId, droppedEntry.id);
    assert.equal(op.pushedStatus, 'held');
    assert.equal(state.recentWrites.length, 1, 'the unverified window is retained');
    assert.deepEqual(env.remoteTags(thread.id), [env.tags.held]);

    // Fresh store + frozen runner: explicit restore, then the secondary
    // recentWrites pass. Both must honor the latest proven owner choice.
    env.clock.advance(6 * 60 * 1_000);
    const freshStore = openStore(env.repo, { sleep: async () => {}, now: env.clock.now });
    const run = await env.run({ store: freshStore });
    t.diagnostic(JSON.stringify({
      runOk: run.ok,
      runActions: run.actions,
      remoteTags: env.remoteTags(thread.id),
      pending: env.readState().pending.length,
      recentWrites: env.readState().recentWrites.length,
      cardStatus: (await env.card(card.id))?.status,
    }));

    assert.deepEqual(env.remoteTags(thread.id), [env.tags.dropped],
      'the latest proven owner choice survives the secondary pass');
    const finalCard = await env.card(card.id);
    assert.equal(finalCard.discordState, 'conflict');
    assert.ok(finalCard.conflictDiscord.includes('dropped'));
  } finally {
    holdInitial.release();
    holdRestore.release();
    await api.whenIdle().catch(() => {});
  }
});
