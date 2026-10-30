// NOTE-1 round 7: a carried audit entry must not be settled by a sync whose audit read failed or was
// skipped. The sync that failed to read judges under partial coverage and names no pick, so its judgment
// cannot prove the order. The entry stays carried for the next sync with a complete read.
// Fake clock only; no sleeps. Every scenario checks owner-visible state (card value, conflict state,
// Discord tag, PATCH count, card log length) over four quiet syncs after the judging sync.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { makeSyncEnv, makeClientWrapper } from './fixtures/sync/harness.mjs';

const envs = [];
afterEach(async () => { for (const env of envs.splice(0)) await env.close(); });
async function setup() { const env = await makeSyncEnv(); envs.push(env); return env; }

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
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
  const eventId = `board-${at}-${to}-${card.id}`;
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

const carryOf = (env) => env.readState().audit?.carry ?? [];

async function snap(env, card, thread) {
  const c = await env.card(card.id);
  const got = await env.plainClient.getThread(thread.id);
  const remote = got.data.applied_tags
    .map((id) => Object.keys(env.tags).find((k) => env.tags[k] === id)).filter(Boolean).sort();
  return {
    state: c.discordState, status: c.status, candidates: c.conflictDiscord ?? null,
    remote, log: c.log.length, mut: env.mutations().length,
    carry: carryOf(env).filter((e) => e.target_id === thread.id).length,
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
    assert.deepEqual(row.remote, base.remote, `${msg}: remote`);
    assert.equal(row.state, base.state, `${msg}: state`);
    assert.equal(row.status, base.status, `${msg}: card status`);
    assert.equal(row.mut, base.mut, `${msg}: PATCH count`);
    assert.equal(row.log, base.log, `${msg}: log length`);
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

function cutRun(env, discordMs) {
  const client = makeClientWrapper(env.client, { perCallMs: 1000, clock: env.clock });
  return env.run({ client, budget: { discordMs } });
}

// Y4 shape: conflicted card, pending pick(s) 'done', phone 'building' 500 ms later (order unprovable).
async function y4Setup(env, ops) {
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
  return { card, thread };
}

const failModes = {
  s500: (env) => env.fake.hooks.forceStatus({ method: 'GET', path: /\/audit-logs$/, status: 500, body: { message: 'synthetic' }, times: 1 }),
  s429: (env) => env.fake.hooks.forceStatus({
    method: 'GET', path: /\/audit-logs$/, status: 429,
    body: { message: 'You are being rate limited.', retry_after: 0.01, global: false },
    headers: { 'X-RateLimit-Reset-After': '0.01' }, times: 4,
  }),
};

function receiptsOf(env) {
  try {
    return readFileSync(join(env.agentDir, 'logs', 'memento.jsonl'), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// X1: carried phone entry, then a sync whose audit read FAILS. The following sync must still keep the
// board value, keep the phone value on Discord, and show the conflict.
for (const ops of [0, 1, 2]) {
  for (const mode of Object.keys(failModes)) {
    test(`X1_carry_then_failed_audit_read_${mode}_ops_${ops}_keeps_phone_value`, async () => {
      const env = await setup();
      const { card, thread } = await y4Setup(env, ops);
      await cutRun(env, 4500);
      const afterCut = await snap(env, card, thread);
      env.clock.advance(MIN);
      failModes[mode](env);
      await env.run();
      const failed = receiptsOf(env).filter((r) => r.event === 'audit-read-failed').length;
      env.clock.advance(MIN);
      await env.run();
      const s1 = await snap(env, card, thread);
      const rows = await quiet(env, card, thread);
      assert.ok(afterCut.carry > 0, 'precondition: cut sync carried the entry');
      assert.ok(failed > 0, 'precondition: audit read failed');
      assert.equal(s1.status, 'done', 'card keeps the board value');
      assert.deepEqual(s1.remote, ['building'], 'phone value not overwritten');
      assert.equal(s1.state, 'conflict', 'order not provable -> conflict');
      flat(rows, s1, 'quiet');
    });
  }
}

// X1b control: same failed read WITHOUT a prior carry. Must keep the conflict too.
test('X1b_control_failed_audit_read_without_carry_keeps_phone_value', async () => {
  const env = await setup();
  const { card, thread } = await y4Setup(env, 0);
  failModes.s500(env);
  await env.run();
  env.clock.advance(MIN);
  await env.run();
  const s1 = await snap(env, card, thread);
  const rows = await quiet(env, card, thread);
  assert.deepEqual(s1.remote, ['building']);
  assert.equal(s1.state, 'conflict');
  flat(rows, s1, 'quiet');
});

// Budget-cut sync plus a failed audit read. Expected log growth is exactly two rows, both intended:
// - the failed read (its own sync) writes one partial-audit conflict row with no pick named;
// - the first complete read judges the kept entry and writes one unproven-order row that names the
//   pick (evidence), so the pick stops resolving. Only a judgment with a named pick is re-written,
//   because the idempotence check in applyConflict is skipped for it; nothing repeats after that.
// The budget-cut run never calls the audit API, so the forced read failure lands on the next run.
test('failed_read_in_budget_cut_sync_keeps_entry_and_phone_value', async () => {
  const env = await setup();
  const { card, thread } = await y4Setup(env, 0);
  await cutRun(env, 4500);
  env.clock.advance(MIN);
  failModes.s500(env);
  const client = makeClientWrapper(env.client, { perCallMs: 1000, clock: env.clock });
  await env.run({ client, budget: { discordMs: 500 } });
  const afterBoth = await snap(env, card, thread);
  env.clock.advance(MIN);
  await env.run();
  const failed = await snap(env, card, thread);
  const failedRow = (await env.card(card.id)).log.at(-1);
  env.clock.advance(MIN);
  await env.run();
  const s1 = await snap(env, card, thread);
  const judgedRow = (await env.card(card.id)).log.at(-1);
  const rows = await quiet(env, card, thread, 4);
  assert.ok(afterBoth.carry > 0, 'entry still carried after the budget-cut sync');
  assert.equal(failed.log, afterBoth.log + 1, 'failed read writes one row');
  assert.equal(failedRow.reason, 'partial-audit', 'failed read: partial coverage, no pick named');
  assert.equal(failedRow.evidence, undefined, 'failed read names no pick');
  assert.equal(failed.carry, 1, 'failed read keeps the entry carried');
  assert.equal(s1.log, failed.log + 1, 'first complete read writes one row');
  assert.equal(judgedRow.reason, 'unproven-order', 'first complete read judges the kept entry');
  assert.ok(judgedRow.evidence, 'the judgment names the pick');
  assert.equal(s1.carry, 0, 'the complete read settles the entry');
  assert.equal(s1.status, 'done', 'card keeps the board value');
  assert.deepEqual(s1.remote, ['building'], 'phone value not overwritten');
  assert.equal(s1.state, 'conflict');
  flat(rows, s1, 'quiet');
});

// Failed read, then a complete read after a genuine later phone change: the later phone change wins.
test('failed_read_then_ok_read_with_later_phone_change_takes_later_value', async () => {
  const env = await setup();
  const { card, thread } = await y4Setup(env, 0);
  await cutRun(env, 4500);
  env.clock.advance(MIN);
  failModes.s500(env);
  await env.run();
  env.clock.advance(10 * MIN);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.researching] });
  env.clock.advance(MIN);
  await env.run();
  const s1 = await snap(env, card, thread);
  const rows = await quiet(env, card, thread);
  assert.equal(s1.carry, 0, 'entries judged by the complete read leave the carry');
  assert.equal(s1.status, 'researching', 'later phone change is taken');
  assert.deepEqual(s1.remote, ['researching']);
  assert.equal(s1.state, 'linked');
  flat(rows, s1, 'quiet');
});

// Failed read, then a new owner board pick clearly after the phone change: the later owner pick wins.
test('failed_read_then_new_board_pick_later_than_phone_change_wins', async () => {
  const env = await setup();
  const { card, thread } = await y4Setup(env, 0);
  await cutRun(env, 4500);
  env.clock.advance(MIN);
  failModes.s500(env);
  await env.run();
  env.clock.advance(10 * MIN);
  await boardPick(env, card, 'planned');
  env.clock.advance(MIN);
  await env.run();
  const s1 = await snap(env, card, thread);
  const rows = await quiet(env, card, thread);
  assert.equal(s1.status, 'planned', 'later owner pick is kept');
  assert.deepEqual(s1.remote, ['planned']);
  assert.equal(s1.state, 'linked');
  flat(rows, s1, 'quiet');
});

// M3 discriminator: a phone change whose take fails to persist once. The entry must stay carried so the
// next sync takes it. Dropping it on the failed write leaves an unexplained-remote conflict.
test('X3_take_persist_failure_keeps_entry_and_next_sync_takes_phone_value', async () => {
  const env = await setup();
  const { card, thread } = await linked(env);
  env.clock.advance(MIN);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
  env.clock.advance(MIN);
  let failOnce = true;
  const store = {
    ...env.store,
    update: async (id, args) => {
      if (failOnce && id === card.id) { failOnce = false; return { ok: false, code: 'SYNTHETIC' }; }
      return env.store.update(id, args);
    },
  };
  await env.run({ store });
  env.clock.advance(MIN);
  await env.run();
  const s1 = await snap(env, card, thread);
  const rows = await quiet(env, card, thread);
  assert.equal(failOnce, false, 'precondition: injected failure used');
  assert.equal(s1.status, 'building', 'phone value taken');
  assert.equal(s1.state, 'linked');
  assert.equal(s1.carry, 0, 'entry settled after the landed take');
  flat(rows, s1, 'quiet');
});

// Retention: an entry whose thread is never judged again (deleted) stays carried inside the 45-day audit
// window and leaves the carry once it is older than that window. Without the retention filter in
// ingestAudit the carry would grow without bound. Fake clock only.
test('retention_drops_carried_entry_only_after_45_days', async () => {
  const env = await setup();
  const { thread } = await y4Setup(env, 0);
  await cutRun(env, 4500);
  env.fake.hooks.deleteThread(thread.id);
  env.clock.advance(MIN);
  await env.run();
  const before = carryOf(env).length;
  env.clock.advance(DAY);
  await env.run();
  const inside = carryOf(env).length;
  env.clock.advance(46 * DAY);
  await env.run();
  const after = carryOf(env).length;
  assert.ok(before > 0, 'precondition: entry carried');
  assert.equal(inside, before, 'entry inside the retention window stays carried');
  assert.equal(after, 0, 'entry older than the retention window leaves the carry');
});
