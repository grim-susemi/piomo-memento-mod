// openStore.transactSyncState: one lock-held read/mutate/atomic-write/commit of
// sync/state.json, plus narrow regressions for the existing lock and commit
// failure behaviour of the store.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { initRepo } from '../src/store/init.mjs';
import { acquire, release } from '../src/store/lock.mjs';
import { openStore } from '../src/store/store.mjs';
import { removeDirs, tempDir } from './fixtures/store/harness.mjs';

const directories = [];

afterEach(() => {
  removeDirs(directories);
  directories.length = 0;
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

async function setup() {
  const parent = tempDir('memento-tx-');
  directories.push(parent);
  const directory = join(parent, 'data');
  const initialized = await initRepo({ dir: directory });
  assert.equal(initialized.ok, true);
  const store = openStore(directory, { lockWaitMs: 200 });
  return {
    parent,
    directory,
    store,
    statePath: join(directory, 'sync', 'state.json'),
  };
}

const keys = (state) => (state.pending ?? []).map((entry) => entry.key);

function addPending(key) {
  return (state) => {
    state.pending = [...(state.pending ?? []), { key, marker: 'fixture' }];
  };
}

test('Test_TransactSyncState_mutates_the_document_read_under_the_lock', async () => {
  const { directory, store, statePath } = await setup();
  const first = await store.transactSyncState(addPending('a'));
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(first.committed, true);
  assert.deepEqual(keys(first.state), ['a']);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).pending.length, 1);

  // A second writer lands between two transactions (fresh store, own handle).
  const other = openStore(directory, { sleep: async () => {} });
  const second = await other.transactSyncState(addPending('b'));
  assert.equal(second.ok, true);

  const third = await store.transactSyncState((state) => {
    state.pending = state.pending.filter((entry) => entry.key !== 'a');
  });
  assert.equal(third.ok, true);
  assert.deepEqual(keys(third.state), ['b'], 'the removal saw the b entry written after the first read');
  assert.deepEqual(keys(JSON.parse(readFileSync(statePath, 'utf8'))), ['b']);
});

test('Test_TransactSyncState_concurrent_additions_and_a_keyed_removal_all_survive', async () => {
  const { store } = await setup();
  const results = await Promise.all([
    store.transactSyncState(addPending('a'), { waitMs: 5_000 }),
    store.transactSyncState(addPending('b'), { waitMs: 5_000 }),
  ]);
  assert.deepEqual(results.map((result) => result.ok), [true, true]);
  const both = await store.readSyncState();
  assert.deepEqual(keys(both.state).sort(), ['a', 'b']);

  const removed = await store.transactSyncState((state) => {
    state.pending = state.pending.filter((entry) => entry.key !== 'a');
  });
  assert.equal(removed.ok, true);
  assert.deepEqual(keys(removed.state), ['b']);
});

test('Test_TransactSyncState_returns_BUSY_without_writing_while_the_write_lock_is_held', async () => {
  const { directory, store, statePath } = await setup();
  const before = readFileSync(statePath);
  const lock = await acquire(directory, 'write', { waitMs: 0 });
  assert.equal(lock.ok, true);
  try {
    const result = await store.transactSyncState(addPending('blocked'), { waitMs: 30 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BUSY');
    assert.equal(readFileSync(statePath).equals(before), true);
  } finally {
    await release(lock);
  }
  const retried = await store.transactSyncState(addPending('after'));
  assert.equal(retried.ok, true);
  assert.deepEqual(keys(retried.state), ['after']);
});

test('Test_TransactSyncState_rolls_back_when_the_index_lock_appears_before_rename', async () => {
  const { directory, statePath } = await setup();
  const bytesBefore = readFileSync(statePath);
  const headBefore = git(directory, ['rev-parse', 'HEAD']).trim();
  const indexLock = join(directory, '.git', 'index.lock');
  const racing = openStore(directory, {
    sleep: async () => {},
    lockWaitMs: 200,
    hooks: { beforeRename: async () => { writeFileSync(indexLock, 'foreign-index-lock\n'); } },
  });

  const result = await racing.transactSyncState(addPending('index-race'));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INDEX_LOCK');
  assert.equal(result.skipped, 'index-lock');
  assert.equal(result.written, false);
  assert.equal(result.rolledBack, true);
  assert.equal(readFileSync(statePath).equals(bytesBefore), true);
  assert.equal(readFileSync(indexLock, 'utf8'), 'foreign-index-lock\n');
  assert.equal(git(directory, ['rev-parse', 'HEAD']).trim(), headBefore);

  rmSync(indexLock);
  const normal = openStore(directory, { lockWaitMs: 200 });
  const retried = await normal.transactSyncState(addPending('index-race'));
  assert.equal(retried.ok, true);
  assert.deepEqual(keys(retried.state), ['index-race']);
});

test('Test_TransactSyncState_rejects_an_invalid_mutate_result_without_writing', async () => {
  const { store, statePath } = await setup();
  const before = readFileSync(statePath);
  const result = await store.transactSyncState(() => ({ schema: 'not-memento' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_STATE');
  assert.equal(readFileSync(statePath).equals(before), true);
});

test('Test_TransactSyncState_restores_the_previous_bytes_when_the_commit_fails', async () => {
  const { parent, directory, store, statePath } = await setup();
  const hooksDir = join(parent, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n');
  const hooksPath = hooksDir.replaceAll('\\', '/');
  git(directory, ['config', 'core.hooksPath', hooksPath]);
  const before = readFileSync(statePath);
  const headBefore = git(directory, ['rev-parse', 'HEAD']).trim();

  const result = await store.transactSyncState(addPending('commit-fails'));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'COMMIT_FAILED');
  assert.equal(result.written, false);
  assert.equal(result.rolledBack, true);
  assert.equal(readFileSync(statePath).equals(before), true);
  assert.equal(git(directory, ['rev-parse', 'HEAD']).trim(), headBefore);
  assert.equal(git(directory, ['status', '--porcelain', '--untracked-files=all']), '');

  git(directory, ['config', '--unset', 'core.hooksPath']);
  const retried = await store.transactSyncState(addPending('commit-fails'));
  assert.equal(retried.ok, true);
  assert.equal(retried.committed, true);
  assert.deepEqual(keys(retried.state), ['commit-fails']);
});

test('Test_TransactSyncState_returns_MISSING_and_UNREADABLE_without_throwing', async () => {
  const { store, statePath } = await setup();
  writeFileSync(statePath, '{not json');
  const unreadable = await store.transactSyncState(addPending('x'));
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.code, 'UNREADABLE');
  rmSync(statePath);
  const missing = await store.transactSyncState(addPending('x'));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'MISSING');
});

test('Test_TransactSyncState_commit_failure_leaves_no_staged_state_and_a_clean_equal_retry', async () => {
  const { directory, store, statePath } = await setup();
  const before = readFileSync(statePath);
  process.env.GIT_AUTHOR_DATE = 'not-a-date';
  let failed;
  try {
    failed = await store.transactSyncState((state) => { state.clock = { offsetMs: 1 }; });
  } finally {
    delete process.env.GIT_AUTHOR_DATE;
  }

  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'COMMIT_FAILED');
  assert.equal(failed.written, false);
  assert.equal(failed.rolledBack, true);
  assert.equal(failed.indexRestored, true);
  assert.equal(readFileSync(statePath).equals(before), true);
  assert.equal(git(directory, ['status', '--porcelain', '--untracked-files=all']), '', 'no MM staged state is left behind');

  const equalRetry = await store.transactSyncState((state) => state);
  assert.equal(equalRetry.ok, true);
  assert.equal(equalRetry.changed, false);
  assert.equal(git(directory, ['status', '--porcelain', '--untracked-files=all']), '', 'the equal retry does not claim success over a staged state');

  const retry = await store.transactSyncState((state) => { state.clock = { offsetMs: 1 }; });
  assert.equal(retry.ok, true);
  assert.equal(retry.committed, true);
  assert.equal(git(directory, ['status', '--porcelain', '--untracked-files=all']), '');
});

test('Test_TransactSyncState_equal_bytes_on_a_dirty_worktree_commits_on_retry', async () => {
  const { directory, store, statePath } = await setup();
  const read = await store.readSyncState();
  const next = structuredClone(read.state);
  next.pending.push({ key: 'must-be-durable' });
  writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`);
  assert.match(git(directory, ['status', '--porcelain', '--', 'sync/state.json']), /^ M sync\/state\.json$/m);
  const headBefore = git(directory, ['rev-parse', 'HEAD']).trim();

  const result = await store.transactSyncState((state) => state);

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.committed, true, 'the dirty equal state is committed on retry');
  assert.notEqual(git(directory, ['rev-parse', 'HEAD']).trim(), headBefore);
  assert.equal(git(directory, ['status', '--porcelain', '--', 'sync/state.json']), '');
});

test('Test_TransactSyncState_equal_bytes_over_a_staged_failed_state_never_claims_a_clean_ok', async () => {
  const { directory, store, statePath } = await setup();
  const head = readFileSync(statePath);
  const staged = structuredClone(JSON.parse(head.toString('utf8')));
  staged.clock = { offsetMs: 9 };
  writeFileSync(statePath, `${JSON.stringify(staged, null, 2)}\n`);
  git(directory, ['add', '--', 'sync/state.json']);
  writeFileSync(statePath, head);
  assert.match(git(directory, ['status', '--porcelain', '--', 'sync/state.json']), /^MM /m);

  const result = await store.transactSyncState((state) => state);

  assert.equal(result.ok, false, 'a staged failed state is never reported as a clean no-op');
  assert.equal(result.code, 'COMMIT_FAILED');
  assert.equal(result.dirty, true);
  assert.equal(git(directory, ['status', '--porcelain', '--', 'sync/state.json']), '', 'the retry reconciles the index');

  const retried = await store.transactSyncState((state) => state);
  assert.equal(retried.ok, true);
  assert.equal(retried.changed, false);
  assert.equal(retried.committed, false);
  assert.equal(git(directory, ['status', '--porcelain', '--', 'sync/state.json']), '');
});

test('Test_TransactSyncState_dirty_equal_state_with_a_failed_commit_is_reported', async () => {
  const { parent, directory, store, statePath } = await setup();
  const read = await store.readSyncState();
  const next = structuredClone(read.state);
  next.pending.push({ key: 'reported' });
  writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`);
  const hooksDir = join(parent, 'hooks-dirty');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n');
  git(directory, ['config', 'core.hooksPath', hooksDir.replaceAll('\\', '/')]);

  const result = await store.transactSyncState((state) => state);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'COMMIT_FAILED');
  assert.equal(result.dirty, true);
  assert.equal(result.written, false);
  assert.equal(result.rolledBack, false, 'the working bytes already match the committed document');
  assert.match(git(directory, ['status', '--porcelain', '--', 'sync/state.json']), /^M  sync\/state\.json$/m);
});

test('Test_TransactSyncState_preserves_a_foreign_staged_path', async () => {
  const { parent, directory, store } = await setup();
  const foreign = join(directory, 'cards', 'foreign.md');
  writeFileSync(foreign, 'foreign staged content\n');
  git(directory, ['add', '--', 'cards/foreign.md']);

  const ok = await store.transactSyncState(addPending('with-foreign'));
  assert.equal(ok.ok, true);
  assert.match(git(directory, ['status', '--porcelain']), /^A  cards\/foreign\.md$/m);

  const hooksDir = join(parent, 'hooks-foreign');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n');
  git(directory, ['config', 'core.hooksPath', hooksDir.replaceAll('\\', '/')]);
  const failed = await store.transactSyncState(addPending('with-foreign-2'));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'COMMIT_FAILED');
  assert.match(git(directory, ['status', '--porcelain']), /^A  cards\/foreign\.md$/m, 'the foreign stage is not reset');
  assert.equal(git(directory, ['status', '--porcelain', '--', 'sync/state.json']), '');
});

test('Test_TransactSyncState_explicit_null_result_is_BAD_STATE_and_changes_nothing', async () => {
  const { directory, store, statePath } = await setup();
  const bytesBefore = readFileSync(statePath);
  const headBefore = git(directory, ['rev-parse', 'HEAD']).trim();
  const lockPath = join(directory, '.git', 'memento', 'write.lock');

  const result = await store.transactSyncState((state) => {
    state.pending.push({ key: 'must-reject-null-replacement' });
    return null;
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_STATE');
  assert.equal(result.reason, 'state', 'null is an invalid replacement, not a kept clone');
  assert.equal(readFileSync(statePath).equals(bytesBefore), true, 'no bytes change');
  assert.equal(git(directory, ['rev-parse', 'HEAD']).trim(), headBefore, 'no commit');
  assert.equal(git(directory, ['status', '--porcelain', '--untracked-files=all']), '', 'no staged or worktree change');
  assert.equal(existsSync(lockPath), false, 'no lock file left');
  const lock = await acquire(directory, 'write', { waitMs: 0 });
  assert.equal(lock.ok, true, 'the write lock is released');
  await release(lock);
  assert.equal((await store.readSyncState()).state.pending.length, 0);
});

test('Test_TransactSyncState_undefined_keeps_the_clone_and_an_explicit_replacement_is_used', async () => {
  const { store } = await setup();

  const keptClone = await store.transactSyncState((state) => {
    state.pending.push({ key: 'keep-clone' });
    return undefined;
  });
  assert.equal(keptClone.ok, true);
  assert.deepEqual(keptClone.state.pending.map((entry) => entry.key), ['keep-clone']);

  const replaced = await store.transactSyncState((state) => {
    state.pending.push({ key: 'clone-should-not-be-used' });
    return { ...state, pending: [{ key: 'replacement' }] };
  });
  assert.equal(replaced.ok, true);
  assert.deepEqual(replaced.state.pending.map((entry) => entry.key), ['replacement'], 'an explicit valid replacement wins over the mutated clone');
});

test('Test_Existing_store_lock_and_commit_failure_behaviour_is_unchanged', async () => {
  const { directory, store } = await setup();
  // writeSyncState still answers BUSY while the write lock is held.
  const lock = await acquire(directory, 'write', { waitMs: 0 });
  assert.equal(lock.ok, true);
  try {
    const read = await store.readSyncState();
    const busy = await store.writeSyncState(read.state);
    assert.equal(busy.ok, false);
    assert.equal(busy.code, 'BUSY');
  } finally {
    await release(lock);
  }
  // update still refuses with BUSY while another process holds the write lock.
  const created = await store.create({
    title: '잠금 카드',
    description: '잠금 카드',
    original: '원문',
    source: 'paste',
    sourceRef: 'test:lock',
    via: 'paste',
    actor: 'owner',
    id: '20260101-aaaa',
  });
  assert.equal(created.ok, true);
  const held = await acquire(directory, 'write', { waitMs: 0 });
  assert.equal(held.ok, true);
  try {
    const blocked = await store.update(created.id, {
      expectRev: 1,
      mutate: (card) => { card.status = 'done'; },
      log: { actor: 'owner', via: 'board', change: 'status', from: 'idea', to: 'done', reason: 'lock' },
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'BUSY');
  } finally {
    await release(held);
  }
  // writeSyncState still commits a changed document and reports committed.
  const state = await store.readSyncState();
  const next = structuredClone(state.state);
  next.pending.push({ key: 'regression' });
  const written = await store.writeSyncState(next);
  assert.equal(written.ok, true);
  assert.equal(written.changed, true);
  assert.equal(written.committed, true);
  assert.equal(existsSync(join(directory, 'sync', 'state.json')), true);
});
