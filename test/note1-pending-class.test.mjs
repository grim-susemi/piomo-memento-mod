// NOTE-1 round 5: several unfinished board ops on one card are judged once per sync.
// Fake clock only; no sleeps. Each case runs four quiet syncs after the decisive sync.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { makeSyncEnv } from './fixtures/sync/harness.mjs';

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
  const eventId = `board-${at}-${to}`;
  await env.updateCard(card.id, (c) => ({ ...c, status: to }), {
    at: iso(at), eventId, actor: 'owner', via: 'board',
    change: 'status', from: current.status, to, reason: 'owner-board',
  });
  return eventId;
}

// The op api.mjs guardedWrite registers before a Discord call and leaves in state.pending when the
// write-through fails. Each failed write-through appends one more op for the same card.
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

function receipts(env) {
  try {
    return readFileSync(join(env.agentDir, 'logs', 'memento.jsonl'), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => !/^sync-(start|complete)$/.test(r.event));
  } catch { return []; }
}

async function snap(env, card, thread) {
  const c = await env.card(card.id);
  const got = await env.plainClient.getThread(thread.id);
  const remote = got.data.applied_tags
    .map((id) => Object.keys(env.tags).find((k) => env.tags[k] === id)).filter(Boolean).sort();
  return {
    state: c.discordState, status: c.status, candidates: c.conflictDiscord ?? null,
    remote, log: c.log.length, mut: env.mutations().length, rc: receipts(env).length,
    writes: env.readState().recentWrites.length, pending: (env.readState().pending ?? []).length,
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
    assert.equal(row.rc, base.rc, `${msg}: receipts`);
    assert.equal(row.writes, base.writes, `${msg}: recentWrites`);
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

// Two or three unfinished picks on one card, the phone change 500 ms before or after the last pick.
// The order is not provable, so the card stays in conflict with its board value.
for (const ops of [['planned', 'done'], ['planned', 'researching', 'done']]) {
  for (const gap of [500, -500]) {
    test(`Test_Sync_pending_${ops.length}_board_ops_same_card_gap_${gap}_keeps_conflict`, async () => {
      const env = await setup();
      const { card, thread } = await linked(env);
      await memberConflict(env, card, thread);
      env.clock.advance(MIN);
      const last = ops.at(-1);
      for (const to of ops.slice(0, -1)) {
        await leavePending(env, card, thread, await boardPick(env, card, to));
        env.clock.advance(20_000);
      }
      if (gap < 0) {
        env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
        env.clock.advance(-gap);
      }
      await leavePending(env, card, thread, await boardPick(env, card, last));
      if (gap > 0) {
        env.clock.advance(gap);
        env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
      }
      env.clock.advance(MIN);
      await env.run();
      const s1 = await snap(env, card, thread);
      assert.equal(s1.state, 'conflict', 'order not provable -> conflict');
      assert.equal(s1.status, last, 'card keeps the last board value');
      assert.deepEqual(s1.remote, ['building'], 'tag left as the phone set it');
      flat(await quiet(env, card, thread), s1, 'quiet');
    });
  }
}

// A genuine later pick: the phone change comes first, then two unfinished picks; the last pick is
// provably later and must win and stay linked.
for (const offset of [0, 1, 100, 1000, 60_000]) {
  test(`Test_Sync_pending_genuine_pick_${offset}ms_after_phone_two_ops_wins_and_stays_linked`, async () => {
    const env = await setup();
    const { card, thread } = await linked(env);
    await memberConflict(env, card, thread);
    env.clock.advance(MIN);
    env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
    env.clock.advance(MIN);
    await leavePending(env, card, thread, await boardPick(env, card, 'planned'));
    env.clock.advance(20_000);
    await leavePending(env, card, thread, await boardPick(env, card, 'done'));
    env.clock.advance(offset);
    env.clock.advance(MIN);
    await env.run();
    const s1 = await snap(env, card, thread);
    assert.equal(s1.state, 'linked', 'provably later pick wins');
    assert.equal(s1.status, 'done');
    assert.deepEqual(s1.remote, ['done'], 'board value written to the thread');
    flat(await quiet(env, card, thread), s1, 'quiet');
  });
}
