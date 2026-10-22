// 016A error classification: actual-store dedicated tests.
// STAGE A: written but NOT executed until both repositories are frozen.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { createBoardApi, DISCORD_BUDGET_MS } from '../src/api.mjs';
import { acquire, release } from '../src/store/lock.mjs';
import { validateReply } from '../src/contract.mjs';
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

function pick(card, status, requestId, rev = card.rev) {
  return { action: 'setStatus', id: card.id, status, rev, requestId };
}

function apiFor(env, receipts = env.receipts) {
  return createBoardApi({
    config: env.config(),
    store: env.store,
    client: env.client,
    receipts,
    now: env.clock.now,
  });
}

// Subscribe to the API's own post-second-save receipt for this card and rev.
// Installed before the fresh trigger; a pending 200 is fine, a failed second
// save never matches and the existing DISCORD_BUDGET_MS bound fails the test.
function pushedWatcher(inner, id, rev) {
  let resolvePushed;
  let rejectPushed;
  const pushed = new Promise((resolve, reject) => {
    resolvePushed = resolve;
    rejectPushed = reject;
  });
  pushed.catch(() => {});
  let timer = setTimeout(
    () => rejectPushed(new Error(`board-pushed rev ${rev} not observed`)),
    DISCORD_BUDGET_MS,
  );
  return {
    pushed,
    receipts: {
      path: inner.path,
      append(entry) {
        const ok = inner.append(entry);
        if (entry?.event === 'board-pushed' && entry.id === id && entry.rev === rev) {
          clearTimeout(timer);
          timer = null;
          resolvePushed(entry);
        }
        return ok;
      },
    },
    cleanup() {
      if (timer) clearTimeout(timer);
    },
  };
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

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
}

test('Test_Index_lock_is_a_WRITE_FAILED_and_never_becomes_BUSY_or_success', async () => {
  const env = await setup();
  const { card } = await linkedFixture(env);
  const watch = pushedWatcher(env.receipts, card.id, card.rev + 2);
  const api = apiFor(env, watch.receipts);
  const indexLock = join(env.repo, '.git', 'index.lock');
  const cardPath = join(env.repo, 'cards', `${card.id}.md`);
  const statePath = join(env.repo, 'sync', 'state.json');

  try {
    const cardBytes = readFileSync(cardPath);
    const stateBytes = readFileSync(statePath);
    const head = git(env.repo, ['rev-parse', 'HEAD']).trim();
    const status = git(env.repo, ['status', '--porcelain', '--untracked-files=all']);
    writeFileSync(indexLock, 'foreign-index-lock\n');

    const body = pick(card, 'done', 'idx-1');
    const first = await api.handle(body);
    assert.equal(first.status, 500);
    assert.deepEqual(first.body, { ok: false, code: 'WRITE_FAILED' });
    assert.equal(Object.keys(first.body).length, 2, 'no internal detail');
    assert.equal(validateReply(first), true);
    assert.equal(readFileSync(indexLock, 'utf8'), 'foreign-index-lock\n', 'foreign index lock retained');
    assert.equal(readFileSync(cardPath).equals(cardBytes), true, 'card bytes unchanged');
    assert.equal(readFileSync(statePath).equals(stateBytes), true, 'state bytes unchanged');
    assert.equal(git(env.repo, ['rev-parse', 'HEAD']).trim(), head, 'HEAD unchanged');
    assert.equal(git(env.repo, ['status', '--porcelain', '--untracked-files=all']), status, 'index/worktree unchanged');

    const repeat = await api.handle(body);
    assert.deepEqual(repeat, first, 'first failure retained for the requestId');

    rmSync(indexLock);
    const afterUnlock = await api.handle(body);
    assert.deepEqual(afterUnlock, first, 'no automatic retry after the lock is removed');
    const stored = await env.card(card.id);
    assert.equal(stored.rev, card.rev, 'no mutation occurred');

    const fresh = await api.handle(pick(card, 'done', 'idx-2'));
    assert.equal(fresh.status, 200);
    await watch.pushed;
    assert.equal((await env.card(card.id)).rev, card.rev + 2);
  } finally {
    watch.cleanup();
    rmSync(indexLock, { force: true });
  }
});

test('Test_Write_lock_contention_is_BUSY_and_the_first_failure_is_retained', async () => {
  const env = await setup();
  const { card } = await linkedFixture(env);
  const api = apiFor(env);
  const held = await acquire(env.repo, 'write', { waitMs: 0 });
  assert.equal(held.ok, true);

  try {
    const body = pick(card, 'done', 'busy-1');
    const first = await api.handle(body);
    assert.equal(first.status, 409);
    assert.deepEqual(first.body, { ok: false, code: 'BUSY' });

    await release(held);
    const repeat = await api.handle(body);
    assert.deepEqual(repeat, first, 'BUSY is the first reply for this requestId');
    const unchanged = await env.card(card.id);
    assert.equal(unchanged.rev, card.rev, 'no mutation or automatic retry');

    const fresh = await api.handle(pick(card, 'done', 'busy-2'));
    assert.equal(fresh.status, 200);
  } finally {
    await release(held).catch(() => {});
  }
});

test('Test_Stale_remains_STALE_with_the_current_rev', async () => {
  const env = await setup();
  const { card } = await linkedFixture(env);
  const api = apiFor(env);
  const stale = await api.handle(pick(card, 'done', 'stale-1', card.rev + 1));
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { ok: false, code: 'STALE', rev: card.rev });
  assert.equal(validateReply(stale), true);
  const unchanged = await env.card(card.id);
  assert.equal(unchanged.rev, card.rev);
});
