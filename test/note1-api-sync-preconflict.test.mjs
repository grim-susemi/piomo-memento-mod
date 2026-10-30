// F2 round-2 (B-SYNC-PRECONFLICT): a card already in conflict; the owner's phone tag change is hidden from the
// audit log; a board pick lands 200/500/1500 ms later and its write-through audit read fails once, so the pick
// stays pending. A sync that runs while the audit is still hidden must keep the conflict. Once the audit entry
// becomes visible, later syncs must still conflict and the owner's next board pick must end it. Plan lines 66/68/
// 70/71/304: order not provable -> conflict, card keeps the board value, tag left as the phone set it, no PATCH;
// a conflict ends with the owner's next board pick or an owner entry genuinely newer than conflict_since.
// Fake clock and fake Discord only; no sleeps, no skip/only/todo.
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
    state: c.discordState,
    status: c.status,
    remote: tagNames(env, env.remoteTags(thread.id)),
    conflictDiscord: c.conflictDiscord ?? null,
    lastLog: c.log.at(-1)?.reason ?? null,
    mut: env.mutations().length,
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
  }
  assert.equal((await env.card(card.id)).discordState, pre, `precondition: ${pre}`);
  env.clock.advance(10 * MIN);
  return { api, card, thread };
}

async function hiddenPhoneThenSyncShape(env, { api, card, thread }, { gap, delayMs, id }) {
  if (delayMs !== null) await env.syncState({ ownerAuditDelayMs: delayMs });
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
  env.clock.advance(gap);
  const mutBefore = env.mutations().length;
  env.fake.hooks.forceStatus({
    method: 'GET', path: /\/audit-logs$/, status: 500, body: { message: 'synthetic' }, times: 1,
  });
  const current = await env.card(card.id);
  const reply = await api.handle({
    action: 'setStatus', id: current.id, status: 'done', rev: current.rev, requestId: `n1b-${id}`,
  });
  await api.whenIdle();
  assert.equal(reply.body?.discord, 'pending', 'write-through left its pending op');
  env.clock.advance(5_000);
  await env.run();
  const decided = await snap(env, card, thread);
  env.clock.advance(Math.max(MIN, (delayMs ?? 0) + 1_000));
  env.fake.hooks.releaseAuditVisibility();
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    await env.run();
    rows.push(await snap(env, card, thread));
    env.clock.advance(10 * MIN);
  }
  const latest = await env.card(card.id);
  const endReply = await api.handle({
    action: 'setStatus', id: latest.id, status: 'held', rev: latest.rev, requestId: `n1b-end-${id}`,
  });
  await api.whenIdle();
  const ended = await snap(env, card, thread);
  return { mutBefore, decided, rows, ended };
}

function assertConflictEndState({ mutBefore, decided, rows, ended }) {
  assert.equal(decided.mut, mutBefore, 'no PATCH while the phone change is hidden');
  assert.equal(decided.state, 'conflict', 'order not provable -> conflict');
  assert.equal(decided.status, 'done', 'card keeps the board value');
  assert.deepEqual(decided.remote, ['building'], 'phone value stays on the tag');
  for (const [i, row] of rows.entries()) {
    assert.equal(row.state, 'conflict', `sync ${i + 1} after audit visible: still conflict`);
    assert.equal(row.status, 'done', `sync ${i + 1}: card keeps the board value`);
    assert.deepEqual(row.remote, ['building'], `sync ${i + 1}: phone value kept on the tag`);
    assert.equal(row.mut, mutBefore, `sync ${i + 1}: no PATCH`);
    assert.ok(row.conflictDiscord?.includes('building'), `sync ${i + 1}: conflict shows the phone value`);
  }
  assert.equal(ended.state, 'linked', 'the next owner board pick ends the conflict');
  assert.deepEqual(ended.remote, ['held'], 'the next owner board pick is PATCHed');
}

const shapes = [];
for (const delayMs of [null, 63_529]) for (const gap of [200, 500, 1_500]) shapes.push({ gap, delayMs });

for (const { gap, delayMs } of shapes) {
  test(`N1B_sync_pre_conflict_gap_${gap}_delay_${delayMs ?? 'unset'}`, async () => {
    const env = await makeApiEnv();
    envs.push(env);
    const ctx = await setup(env, 'conflict');
    const id = `conflict-${gap}-${delayMs ?? 'unset'}`;
    assertConflictEndState(await hiddenPhoneThenSyncShape(env, ctx, { gap, delayMs, id }));
  });
}

test('N1B_control_sync_pre_linked_gap_500', async () => {
  const env = await makeApiEnv();
  envs.push(env);
  const ctx = await setup(env, 'linked');
  assertConflictEndState(await hiddenPhoneThenSyncShape(env, ctx, { gap: 500, delayMs: null, id: 'linked-500' }));
});

test('N1B_control_later_owner_entry_ends_conflict', async () => {
  const env = await makeApiEnv();
  envs.push(env);
  const { card, thread } = await setup(env, 'conflict');
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
  env.clock.advance(MIN);
  await env.run();
  const after = await snap(env, card, thread);
  assert.equal(after.state, 'linked', 'an owner entry newer than conflict_since ends the conflict');
  assert.equal(after.status, 'building', 'the newer owner value is taken');
  assert.deepEqual(after.remote, ['building']);
});
