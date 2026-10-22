// TASK12 response-budget candidate (012/013 shared candidate, API slice).
// NOT executed in Stage A: source/test freeze only until the root gate.
//
// The budget is anchored once at the public handle entry, uses the injected
// clock consistently, subtracts preparation, reserves 50 ms of return slack and
// never starts a new full wait when the remaining budget is exhausted.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createBoardApi } from '../src/api.mjs';
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

async function linkedFixture(env) {
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title,
    appliedTags: [env.tags.idea],
    content: card.original,
  });
  const linked = await env.linkCard(card, thread, 'idea');
  return { card: linked, thread };
}

function apiFor(env, options = {}) {
  return createBoardApi({
    config: env.config(),
    store: env.store,
    client: env.client,
    receipts: env.receipts,
    ...options,
  });
}

/** Real base time plus a fixed virtual jump after the first clock read. */
function jumpingClock(jumpMs) {
  let calls = 0;
  return () => {
    calls += 1;
    return Date.now() + (calls === 1 ? 0 : jumpMs);
  };
}

function bounded(promise, label, ms = 10_000) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`bounded: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

test('Test_Response_budget_anchors_at_public_entry_and_subtracts_preparation', async () => {
  const env = await setup();
  const { card, thread } = await linkedFixture(env);
  // The first injected-clock read is the handle entry; every later read is
  // 1900 ms ahead, so the remaining budget collapses to about 50 ms.
  const api = apiFor(env, { now: jumpingClock(1_900) });
  const hold = env.fake.hooks.holdNext({ method: 'GET', path: `/channels/${thread.id}` });
  const entered = performance.now();
  try {
    const reply = await bounded(api.handle(pick(card, 'done', 'budget-origin')), 'reply');
    const elapsed = performance.now() - entered;
    assert.equal(reply.status, 200);
    assert.equal(reply.body.discord, 'pending');
    assert.ok(elapsed < 700, `entry-anchored remaining budget expected; measured ${elapsed} ms`);
  } finally {
    hold.release();
    await api.whenIdle();
  }
});

test('Test_Response_budget_exhausted_remaining_does_not_start_a_new_wait', async () => {
  const env = await setup();
  const { card, thread } = await linkedFixture(env);
  const api = apiFor(env, { now: jumpingClock(3_000) });
  const hold = env.fake.hooks.holdNext({ method: 'GET', path: `/channels/${thread.id}` });
  const entered = performance.now();
  try {
    const reply = await bounded(api.handle(pick(card, 'done', 'budget-exhausted')), 'reply');
    const elapsed = performance.now() - entered;
    assert.equal(reply.body.discord, 'pending');
    assert.ok(elapsed < 1_000, `no fresh full wait after exhaustion; measured ${elapsed} ms`);
    assert.match(env.receiptsText(), /"exhausted":true/);
  } finally {
    hold.release();
    await api.whenIdle();
  }
});

test('Test_Response_budget_strict_entry_to_reply_is_at_most_2000ms', async () => {
  const env = await setup();
  const { card, thread } = await linkedFixture(env);
  const api = apiFor(env, { now: Date.now });
  const hold = env.fake.hooks.holdNext({ method: 'GET', path: `/channels/${thread.id}` });
  const entered = performance.now();
  let reply = null;
  try {
    reply = await bounded(api.handle(pick(card, 'done', 'budget-strict')), 'reply');
  } finally {
    hold.release();
  }
  const elapsed = performance.now() - entered;
  assert.equal(reply.status, 200);
  assert.equal(reply.body.discord, 'pending');
  assert.ok(elapsed <= 2_000, `strict entry-to-reply bound: measured ${elapsed} ms`);
  await api.whenIdle();
});

test('Test_Response_budget_lets_completed_work_win_the_race', async () => {
  const env = await setup();
  const { card } = await linkedFixture(env);
  const api = apiFor(env, { now: env.clock.now });
  const entered = performance.now();
  const reply = await bounded(api.handle(pick(card, 'done', 'budget-complete')), 'reply');
  const elapsed = performance.now() - entered;
  assert.equal(reply.status, 200);
  assert.equal(reply.body.discord, 'pushed');
  assert.ok(elapsed < 2_000, `completed work resolves before the deadline; measured ${elapsed} ms`);
});

test('Test_Response_budget_keeps_the_first_reply_for_a_repeated_requestId', async () => {
  const env = await setup();
  const api = apiFor(env, { now: env.clock.now });
  const loose = await env.newCard();
  const body = pick(loose, 'planned', 'budget-repeat');
  const first = await api.handle(body);
  const second = await api.handle(body);
  assert.equal(first.status, 200);
  assert.equal(first.body.discord, 'off');
  assert.deepEqual(second, first);
  const stored = await env.card(loose.id);
  assert.equal(stored.status, 'planned');
  assert.equal(stored.rev, loose.rev + 1, 'exactly one card change for the repeated requestId');
});
