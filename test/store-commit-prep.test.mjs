import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { initRepo } from '../src/store/init.mjs';
import { openStore } from '../src/store/store.mjs';
import { removeDirs, tempDir } from './fixtures/store/harness.mjs';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const CARD = {
  title: '준비 실패 카드',
  description: '준비 실패 카드',
  original: '원문',
  source: 'paste',
  sourceRef: 'test:prep',
  via: 'paste',
  actor: 'owner',
};
const directories = [];
let restoreFs = null;

afterEach(() => {
  if (restoreFs) restoreFs();
  restoreFs = null;
  removeDirs(directories);
  directories.length = 0;
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function status(cwd) {
  return git(cwd, ['status', '--porcelain']);
}

function head(cwd) {
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

async function setup() {
  const parent = tempDir('memento-prep-');
  directories.push(parent);
  const directory = join(parent, 'data');
  const initialized = await initRepo({ dir: directory });
  assert.equal(initialized.ok, true);
  return { directory, store: openStore(directory, { sleep: async () => {} }) };
}

function installOneShotFsFailure(name, predicate, occurrence = 1) {
  const original = fsp[name];
  let fired = false;
  let matched = 0;
  fsp[name] = async (...args) => {
    const target = String(args[0] ?? '').replaceAll('\\', '/');
    if (!fired && predicate(target)) {
      matched += 1;
      if (matched === occurrence) {
        fired = true;
        const error = new Error(`ENOSPC: injected ${name}`);
        error.code = 'ENOSPC';
        throw error;
      }
    }
    return original(...args);
  };
  syncBuiltinESMExports();
  restoreFs = () => {
    fsp[name] = original;
    syncBuiltinESMExports();
  };
  return () => fired;
}

function commitMessageWrite(target) {
  return target.includes('/.git/memento/') && target.includes('/commit-') && target.endsWith('.tmp');
}

function commitMessageDirectory(target) {
  return target.endsWith('/.git/memento');
}

function restoreNow() {
  if (restoreFs) restoreFs();
  restoreFs = null;
}

test('Test_Create_when_commit_message_write_fails_ENOSPC_rolls_back_and_retry_works', async () => {
  const { directory, store } = await setup();
  writeFileSync(join(directory, 'foreign.txt'), 'foreign\n');
  git(directory, ['add', '--', 'foreign.txt']);
  const headBefore = head(directory);
  const fired = installOneShotFsFailure('writeFile', commitMessageWrite);

  const result = await store.create({ ...CARD, id: '20261022-aaaa' });

  assert.equal(fired(), true);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COMMIT_PREP_FAILED');
  assert.equal(result.written, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.indexRestored, true);
  assert.equal(result.commit.stage, 'message-write');
  assert.equal(result.commit.errno, 'ENOSPC');
  assert.equal(existsSync(join(directory, 'cards', '20261022-aaaa.md')), false);
  assert.equal(head(directory), headBefore);
  assert.equal(status(directory), 'A  foreign.txt\n');

  restoreNow();
  const retried = await store.create({ ...CARD, id: '20261022-aaaa' });
  assert.equal(retried.ok, true);
  assert.equal(retried.committed, true);
  assert.equal(status(directory), 'A  foreign.txt\n');
});

test('Test_Update_when_commit_message_write_fails_ENOSPC_rolls_back_bytes_and_retry_works', async () => {
  const { directory, store } = await setup();
  const created = await store.create({ ...CARD, id: '20261022-bbbb' });
  const file = join(directory, 'cards', `${created.id}.md`);
  const bytesBefore = readFileSync(file);
  const headBefore = head(directory);
  installOneShotFsFailure('writeFile', commitMessageWrite);

  const result = await store.update(created.id, {
    expectRev: 1,
    mutate: (card) => { card.status = 'done'; },
    log: { actor: 'owner', via: 'board', change: 'status', from: 'idea', to: 'done', reason: 'prep failure' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'COMMIT_PREP_FAILED');
  assert.equal(result.written, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.indexRestored, true);
  assert.equal(result.commit.stage, 'message-write');
  assert.equal(result.rev, 1);
  assert.equal(readFileSync(file).equals(bytesBefore), true);
  assert.equal(head(directory), headBefore);
  assert.equal(status(directory), '');

  restoreNow();
  const retried = await store.update(created.id, {
    expectRev: 1,
    mutate: (card) => { card.status = 'done'; },
    log: { actor: 'owner', via: 'board', change: 'status', from: 'idea', to: 'done', reason: 'prep failure' },
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.rev, 2);
});

test('Test_WriteSyncState_when_commit_message_write_fails_ENOSPC_rolls_back_state_and_retry_works', async () => {
  const { directory, store } = await setup();
  const read = await store.readSyncState();
  const next = structuredClone(read.state);
  next.pending.push({ key: 'prep-failure' });
  const statePath = join(directory, 'sync', 'state.json');
  const bytesBefore = readFileSync(statePath);
  const headBefore = head(directory);
  installOneShotFsFailure('writeFile', commitMessageWrite);

  const result = await store.writeSyncState(next);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'COMMIT_PREP_FAILED');
  assert.equal(result.written, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.indexRestored, true);
  assert.equal(result.commit.stage, 'message-write');
  assert.equal(result.changed, false);
  assert.equal(readFileSync(statePath).equals(bytesBefore), true);
  assert.equal(head(directory), headBefore);
  assert.equal(status(directory), '');

  restoreNow();
  const retried = await store.writeSyncState(next);
  assert.equal(retried.ok, true);
  assert.equal(retried.changed, true);
  assert.equal(retried.committed, true);
});

test('Test_Create_when_commit_message_directory_fails_ENOSPC_rolls_back_and_retry_works', async () => {
  const { directory, store } = await setup();
  const headBefore = head(directory);
  const fired = installOneShotFsFailure('mkdir', commitMessageDirectory, 2);

  const result = await store.create({ ...CARD, id: '20261022-cccc' });

  assert.equal(fired(), true);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COMMIT_PREP_FAILED');
  assert.equal(result.written, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.indexRestored, true);
  assert.equal(result.commit.stage, 'message-dir');
  assert.equal(result.commit.errno, 'ENOSPC');
  assert.equal(existsSync(join(directory, 'cards', '20261022-cccc.md')), false);
  assert.equal(head(directory), headBefore);
  assert.equal(status(directory), '');

  restoreNow();
  const retried = await store.create({ ...CARD, id: '20261022-cccc' });
  assert.equal(retried.ok, true);
  assert.equal(retried.committed, true);
});
