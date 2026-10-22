import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';
import { initRepo } from '../src/store/init.mjs';
import { openStore } from '../src/store/store.mjs';
import {
  removeDirs,
  send,
  spawnCrashChild,
  spawnLockChild,
  stopChildren,
  tempDir,
  waitForExit,
  waitForMessage,
} from './fixtures/store/harness.mjs';

const CARD = {
  title: '아이디어 제목',
  description: '한 줄 설명 ㅋㅋㅋ 👍',
  original: '원문 첫 줄\n원문 둘째 줄 😀',
  source: 'paste',
  sourceRef: 'session:test',
  via: 'paste',
  actor: 'owner',
};

const directories = [];
const children = [];

afterEach(async () => {
  stopChildren(children);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) await waitForExit(child).catch(() => {});
  }
  children.length = 0;
  removeDirs(directories);
  directories.length = 0;
});

function scratch(prefix = 'memento-store-') {
  const directory = tempDir(prefix);
  directories.push(directory);
  return directory;
}

async function setup(storeOptions = {}) {
  const parent = scratch();
  const directory = join(parent, 'memento');
  const init = await initRepo({ dir: directory });
  assert.equal(init.ok, true);
  const store = openStore(directory, {
    sleep: async () => {},
    lockWaitMs: 200,
    ...storeOptions,
  });
  return { directory, store };
}

function git(cwd, args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd, encoding, windowsHide: true });
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function cardPath(directory, id) {
  return join(directory, 'cards', `${id}.md`);
}

async function holdLock(directory, name) {
  const child = spawnLockChild(directory, name, 'hold');
  children.push(child);
  const acquired = await waitForMessage(child, (item) => item.type === 'acquired');
  assert.equal(acquired.ok, true);
  return child;
}

test('Test_Create_when_valid_stores_a_canonical_card_committed_with_korean_bytes', async () => {
  const { directory, store } = await setup();

  const created = await store.create(CARD);

  assert.equal(created.ok, true);
  assert.match(created.id, /^\d{8}-[a-z2-7]{4}$/);
  assert.equal(created.rev, 1);
  assert.equal(created.file, `cards/${created.id}.md`);
  const bytes = readFileSync(cardPath(directory, created.id));
  assert.equal(bytes.includes(0x0d), false);
  assert.equal(git(directory, ['status', '--porcelain']), '');

  const listed = await store.list();
  assert.equal(listed.unreadable.length, 0);
  assert.equal(listed.cards.length, 1);
  const card = listed.cards[0];
  assert.equal(card.id, created.id);
  assert.equal(card.status, 'idea');
  assert.equal(card.rev, 1);
  assert.equal(card.title, CARD.title);
  assert.equal(card.description, CARD.description.normalize('NFC'));
  assert.equal(card.original, CARD.original.normalize('NFC'));
  assert.equal(card.log.length, 1);
  assert.equal(card.log[0].change, 'create');
  assert.equal(card.log[0].actor, 'owner');
  assert.equal(card.log[0].via, 'paste');

  const got = await store.get(created.id);
  assert.equal(got.ok, true);
  assert.equal(got.card.id, created.id);

  const expected = `memento: create ${created.id}\n\n${CARD.description.normalize('NFC')}\n`;
  const logBody = git(directory, ['log', '-1', '--format=%B'], 'buffer');
  assert.equal(logBody.toString('utf8'), `${expected}\n`);
  assert.equal(logBody.includes(Buffer.from('\uFFFD', 'utf8')), false);
});

test('Test_List_when_two_cards_exist_returns_them_sorted_by_id', async () => {
  const { store } = await setup();

  await store.create({ ...CARD, id: '20261022-bbbb' });
  await store.create({ ...CARD, id: '20261022-aaaa' });
  const listed = await store.list();

  assert.deepEqual(listed.cards.map((card) => card.id), ['20261022-aaaa', '20261022-bbbb']);
});

test('Test_Create_when_the_id_already_exists_returns_EXISTS_and_keeps_the_bytes', async () => {
  const { directory, store } = await setup();
  const first = await store.create({ ...CARD, id: '20261022-aaaa' });
  const before = readFileSync(cardPath(directory, first.id));

  const second = await store.create({ ...CARD, id: '20261022-aaaa', title: '다른 제목' });

  assert.equal(second.ok, false);
  assert.equal(second.code, 'EXISTS');
  assert.equal(sha256(readFileSync(cardPath(directory, first.id))), sha256(before));
});

test('Test_Update_when_expectRev_is_old_returns_STALE_and_leaves_bytes_unchanged', async () => {
  const { directory, store } = await setup();
  const created = await store.create(CARD);
  const before = readFileSync(cardPath(directory, created.id));
  const head = git(directory, ['rev-parse', 'HEAD']).trim();

  const result = await store.update(created.id, {
    expectRev: 0,
    mutate: (card) => {
      card.status = 'done';
    },
    log: { actor: 'owner', via: 'board', change: 'status', from: 'idea', to: 'done', reason: '완료로 바꿈' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'STALE');
  assert.equal(sha256(readFileSync(cardPath(directory, created.id))), sha256(before));
  assert.equal(git(directory, ['rev-parse', 'HEAD']).trim(), head);
  assert.equal(git(directory, ['status', '--porcelain']), '');
});

test('Test_Update_when_expectRev_matches_advances_rev_and_commits_the_korean_reason', async () => {
  const { directory, store } = await setup();
  const created = await store.create(CARD);

  const result = await store.update(created.id, {
    expectRev: 1,
    mutate: (card) => {
      card.status = 'done';
      card.notes = '메모도 함께 저장';
    },
    log: { actor: 'owner', via: 'board', change: 'status', from: 'idea', to: 'done', reason: '완료로 바꿈' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.rev, 2);
  assert.equal(result.card.status, 'done');
  assert.equal(result.card.notes, '메모도 함께 저장');
  assert.equal(result.card.log.length, 2);
  assert.deepEqual(
    { change: result.card.log[1].change, from: result.card.log[1].from, to: result.card.log[1].to },
    { change: 'status', from: 'idea', to: 'done' },
  );
  const listed = await store.list();
  assert.equal(listed.cards[0].rev, 2);
  assert.equal(git(directory, ['status', '--porcelain']), '');

  const expected = `memento: update ${created.id} rev 2\n\n완료로 바꿈\n`;
  const logBody = git(directory, ['log', '-1', '--format=%B'], 'buffer');
  assert.equal(logBody.toString('utf8'), `${expected}\n`);
});

test('Test_Get_and_Update_when_the_card_is_missing_return_NOT_FOUND', async () => {
  const { store } = await setup();

  assert.deepEqual(await store.get('20261022-aaaa'), { ok: false, code: 'NOT_FOUND' });
  const updated = await store.update('20261022-aaaa', {
    expectRev: 1,
    mutate: () => {},
    log: { actor: 'owner', via: 'board', change: 'status', from: 'idea', to: 'done', reason: '없는 카드' },
  });
  assert.equal(updated.ok, false);
  assert.equal(updated.code, 'NOT_FOUND');
});

test('Test_Get_when_a_tmp_sibling_exists_waits_for_the_rename_instead_of_reporting_missing', async () => {
  const { directory, store } = await setup();
  const created = await store.create({ ...CARD, id: '20261022-aaaa' });
  const file = cardPath(directory, created.id);
  const bytes = readFileSync(file);
  rmSync(file);
  writeFileSync(join(directory, 'cards', `.${created.id}.md.fixture.tmp`), 'partial tmp');
  let restored = false;
  const racing = openStore(directory, {
    sleep: async () => {
      if (restored) return;
      writeFileSync(file, bytes);
      restored = true;
    },
  });

  const got = await racing.get(created.id);

  assert.equal(got.ok, true);
  assert.equal(got.card.id, created.id);
  assert.equal(restored, true);
});

test('Test_List_when_a_card_is_unreadable_reports_it_and_keeps_good_cards', async () => {
  const { directory, store } = await setup();
  await store.create({ ...CARD, id: '20261022-aaaa' });
  writeFileSync(cardPath(directory, 'broken'), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('---\n', 'utf8'),
  ]));

  const listed = await store.list();

  assert.equal(listed.cards.length, 1);
  assert.equal(listed.cards[0].id, '20261022-aaaa');
  assert.deepEqual(listed.unreadable, [{ file: 'cards/broken.md', reason: 'bom' }]);
});

test('Test_Create_when_index_lock_exists_reports_it_and_never_deletes_it', async () => {
  const { directory, store } = await setup();
  const indexLock = join(directory, '.git', 'index.lock');
  writeFileSync(indexLock, 'held-by-another-git\n');

  const result = await store.create({ ...CARD, id: '20261022-aaaa' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INDEX_LOCK');
  assert.equal(result.skipped, 'index-lock');
  assert.equal(readFileSync(indexLock, 'utf8'), 'held-by-another-git\n');
  assert.equal(existsSync(cardPath(directory, '20261022-aaaa')), false);
  assert.equal((await store.list()).cards.length, 0);
});

function openLockingStore(directory, lockPath, lockBytes) {
  return openStore(directory, {
    sleep: async () => {},
    lockWaitMs: 200,
    hooks: {
      beforeRename: async () => {
        writeFileSync(lockPath, lockBytes);
      },
    },
  });
}

test('Test_Create_when_index_lock_appears_before_rename_rolls_back_and_reports_INDEX_LOCK', async () => {
  const { directory } = await setup();
  const indexLock = join(directory, '.git', 'index.lock');
  const lockBytes = 'foreign-index-lock\n';
  const racing = openLockingStore(directory, indexLock, lockBytes);
  const headBefore = git(directory, ['rev-parse', 'HEAD']).trim();

  const result = await racing.create({ ...CARD, id: '20261022-aaaa' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INDEX_LOCK');
  assert.equal(result.skipped, 'index-lock');
  assert.equal(result.written, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.indexRestored, true);
  assert.equal(existsSync(cardPath(directory, '20261022-aaaa')), false);
  assert.equal(readFileSync(indexLock, 'utf8'), lockBytes);
  assert.equal(git(directory, ['rev-parse', 'HEAD']).trim(), headBefore);
  assert.equal(git(directory, ['status', '--porcelain', '--untracked-files=all']), '');

  rmSync(indexLock);
  const normal = openStore(directory, { sleep: async () => {} });
  const retried = await normal.create({ ...CARD, id: '20261022-aaaa' });
  assert.equal(retried.ok, true);
  assert.equal(retried.committed, true);
});

test('Test_Update_when_index_lock_appears_before_rename_rolls_back_the_card_bytes', async () => {
  const { directory, store } = await setup();
  const created = await store.create({ ...CARD, id: '20261022-aaaa' });
  const indexLock = join(directory, '.git', 'index.lock');
  const lockBytes = 'foreign-index-lock\n';
  const racing = openLockingStore(directory, indexLock, lockBytes);
  const bytesBefore = readFileSync(cardPath(directory, created.id));
  const headBefore = git(directory, ['rev-parse', 'HEAD']).trim();

  const result = await racing.update(created.id, {
    expectRev: 1,
    mutate: (card) => { card.status = 'done'; },
    log: { actor: 'owner', via: 'board', change: 'status', from: 'idea', to: 'done', reason: 'race rollback' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INDEX_LOCK');
  assert.equal(result.written, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.indexRestored, true);
  assert.equal(result.rev, 1);
  assert.equal(readFileSync(cardPath(directory, created.id)).equals(bytesBefore), true);
  assert.equal(readFileSync(indexLock, 'utf8'), lockBytes);
  assert.equal(git(directory, ['rev-parse', 'HEAD']).trim(), headBefore);
  assert.equal(git(directory, ['status', '--porcelain', '--untracked-files=all']), '');

  rmSync(indexLock);
  const normal = openStore(directory, { sleep: async () => {} });
  const retried = await normal.update(created.id, {
    expectRev: 1,
    mutate: (card) => { card.status = 'done'; },
    log: { actor: 'owner', via: 'board', change: 'status', from: 'idea', to: 'done', reason: 'race rollback' },
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.rev, 2);
});

test('Test_WriteSyncState_when_index_lock_appears_before_rename_rolls_back_the_state', async () => {
  const { directory, store } = await setup();
  const read = await store.readSyncState();
  const next = structuredClone(read.state);
  next.pending.push({ key: 'race-state' });
  const statePath = join(directory, 'sync', 'state.json');
  const bytesBefore = readFileSync(statePath);
  const indexLock = join(directory, '.git', 'index.lock');
  const lockBytes = 'foreign-index-lock\n';
  const racing = openLockingStore(directory, indexLock, lockBytes);
  const headBefore = git(directory, ['rev-parse', 'HEAD']).trim();

  const result = await racing.writeSyncState(next);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INDEX_LOCK');
  assert.equal(result.written, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.indexRestored, true);
  assert.equal(readFileSync(statePath).equals(bytesBefore), true);
  assert.equal(readFileSync(indexLock, 'utf8'), lockBytes);
  assert.equal(git(directory, ['rev-parse', 'HEAD']).trim(), headBefore);
  assert.equal(git(directory, ['status', '--porcelain', '--untracked-files=all']), '');

  rmSync(indexLock);
  const normal = openStore(directory, { sleep: async () => {} });
  const retried = await normal.writeSyncState(next);
  assert.equal(retried.ok, true);
  assert.equal(retried.changed, true);
  assert.equal(retried.committed, true);
});

test('Test_WriteSyncState_when_equal_state_is_untracked_dirty_commits_it_on_retry', async () => {
  const { directory, store } = await setup();
  const read = await store.readSyncState();
  const next = structuredClone(read.state);
  next.pending.push({ key: 'must-be-durable' });
  const statePath = join(directory, 'sync', 'state.json');
  const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
  writeFileSync(statePath, bytes);
  assert.match(git(directory, ['status', '--porcelain', '--', 'sync/state.json']), /^ M sync\/state\.json$/m);
  const headBefore = git(directory, ['rev-parse', 'HEAD']).trim();

  const result = await store.writeSyncState(next);

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.committed, true);
  assert.notEqual(git(directory, ['rev-parse', 'HEAD']).trim(), headBefore);
  assert.equal(git(directory, ['status', '--porcelain', '--', 'sync/state.json']), '');
  assert.deepEqual((await store.readSyncState()).state, next);
});

test('Test_Create_when_a_foreign_file_is_pre_staged_commits_only_the_card', async () => {
  const { directory, store } = await setup();
  writeFileSync(join(directory, 'foreign.txt'), 'outside-card-change\n');
  git(directory, ['add', '--', 'foreign.txt']);
  assert.match(git(directory, ['status', '--porcelain']), /^A  foreign\.txt$/m);

  const created = await store.create({ ...CARD, id: '20261022-abcf' });

  assert.equal(created.ok, true);
  const names = git(directory, ['show', '--name-only', '--format=', 'HEAD']).trim().split(/\r?\n/);
  assert.deepEqual(names, [`cards/${created.id}.md`]);
  assert.equal(created.committed, true);
  const foreignInHead = spawnSync('git', ['cat-file', '-e', 'HEAD:foreign.txt'], {
    cwd: directory,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(foreignInHead.status, 0);
  assert.match(git(directory, ['status', '--porcelain']), /^A  foreign\.txt$/m);
  assert.equal(readFileSync(join(directory, 'foreign.txt'), 'utf8'), 'outside-card-change\n');
});

test('Test_Create_when_write_lock_is_held_returns_BUSY', async () => {
  const { directory, store } = await setup();
  const holder = await holdLock(directory, 'write');

  const result = await store.create({ ...CARD, id: '20261022-aaaa' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'BUSY');
  await send(holder, { type: 'release' });
  await waitForMessage(holder, (item) => item.type === 'released');
});

test('Test_Create_when_sync_lock_is_held_still_writes_the_card', async () => {
  const { store, directory } = await setup();
  const holder = await holdLock(directory, 'sync');

  const result = await store.create({ ...CARD, id: '20261022-aaaa' });

  assert.equal(result.ok, true);
  assert.equal((await store.list()).cards.length, 1);
  await send(holder, { type: 'release' });
  await waitForMessage(holder, (item) => item.type === 'released');
});

test('Test_Create_when_committing_stages_only_the_card_path', async () => {
  const { directory, store } = await setup();
  writeFileSync(join(directory, 'decoy.txt'), 'not part of the card commit\n');

  const created = await store.create({ ...CARD, id: '20261022-aaaa' });

  assert.equal(created.ok, true);
  const names = git(directory, ['show', '--name-only', '--format=', 'HEAD']).trim().split(/\r?\n/);
  assert.deepEqual(names, [`cards/${created.id}.md`]);
  assert.match(git(directory, ['status', '--porcelain']), /^\?\? decoy\.txt$/m);
});

test('Test_Create_when_the_child_crashes_between_tmp_and_rename_leaves_no_partial_card', async () => {
  const { directory, store } = await setup();
  const child = spawnCrashChild(directory, 'card', '20261022-bbbb');
  children.push(child);

  const barrier = await waitForMessage(child, (item) => item.type === 'before-rename');
  assert.equal(barrier.kind, 'card');
  assert.equal(barrier.target, cardPath(directory, '20261022-bbbb'));
  assert.equal(existsSync(barrier.target), false);
  assert.match(barrier.tmp, /\.tmp$/);
  assert.equal(dirname(barrier.tmp), join(directory, 'cards'));

  child.kill();
  await waitForExit(child);

  assert.equal(existsSync(barrier.target), false);
  assert.equal((await store.list()).cards.length, 0);
  assert.equal(git(directory, ['status', '--porcelain', '--untracked-files=all']), '');

  const retried = await store.create({ ...CARD, id: '20261022-bbbb' });
  assert.equal(retried.ok, true);
  assert.equal((await store.list()).cards.length, 1);
});

test('Test_WriteSyncState_when_the_child_crashes_before_rename_leaves_the_old_state_intact', async () => {
  const { directory } = await setup();
  const statePath = join(directory, 'sync', 'state.json');
  const before = readFileSync(statePath);
  const child = spawnCrashChild(directory, 'sync');
  children.push(child);

  const barrier = await waitForMessage(child, (item) => item.type === 'before-rename');
  assert.equal(barrier.kind, 'sync');
  assert.equal(barrier.target, statePath);
  assert.equal(dirname(barrier.tmp), join(directory, 'sync'));

  child.kill();
  await waitForExit(child);

  assert.equal(readFileSync(statePath).equals(before), true);
  assert.doesNotThrow(() => JSON.parse(readFileSync(statePath, 'utf8')));
  assert.equal(git(directory, ['status', '--porcelain', '--untracked-files=all']), '');
});

test('Test_WriteSyncState_when_valid_replaces_atomically_and_commits_once', async () => {
  const { directory, store } = await setup();
  const read = await store.readSyncState();
  assert.equal(read.ok, true);
  const next = structuredClone(read.state);
  next.pending.push({ key: 'op-1', thread: 'thread-1', t0: '2026-10-22T00:00:00.000Z' });
  next.clock = { offsetMs: 0, rttMs: 10, at: '2026-10-22T00:00:00.000Z' };
  const headBefore = git(directory, ['rev-parse', 'HEAD']).trim();

  const written = await store.writeSyncState(next);

  assert.equal(written.ok, true);
  assert.equal(written.changed, true);
  assert.notEqual(git(directory, ['rev-parse', 'HEAD']).trim(), headBefore);
  const readBack = await store.readSyncState();
  assert.deepEqual(readBack.state, next);
  assert.equal(readFileSync(join(directory, 'sync', 'state.json'), 'utf8').endsWith('\n'), true);
  assert.equal(git(directory, ['log', '-1', '--format=%s']).trim(), 'memento: sync state');
  const again = await store.writeSyncState(next);
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
});

test('Test_WriteSyncState_when_the_rename_hook_throws_keeps_bytes_and_removes_tmp', async () => {
  const { directory } = await setup();
  const statePath = join(directory, 'sync', 'state.json');
  const before = readFileSync(statePath);
  const throwing = openStore(directory, {
    sleep: async () => {},
    hooks: {
      beforeRename: async ({ kind }) => {
        if (kind === 'sync') throw new Error('barrier-abort');
      },
    },
  });
  const read = await throwing.readSyncState();
  read.state.pending.push({ key: 'aborted' });

  await assert.rejects(() => throwing.writeSyncState(read.state), /barrier-abort/);

  assert.equal(readFileSync(statePath).equals(before), true);
  const leftovers = git(directory, ['status', '--porcelain', '--untracked-files=all']);
  assert.equal(leftovers, '');
});

test('Test_Store_when_initialized_reports_the_repo_revision_as_zero_unpushed_without_remote', async () => {
  const { directory, store } = await setup();

  assert.equal(await store.unpushedCount(), 0);
  const pushed = await store.push();
  assert.equal(pushed.ok, true);
  assert.equal(pushed.skipped, 'no-remote');
  assert.equal(git(directory, ['status', '--porcelain']), '');
});
