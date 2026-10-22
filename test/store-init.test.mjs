import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { initRepo } from '../src/store/init.mjs';
import { removeDirs, tempDir } from './fixtures/store/harness.mjs';

const directories = [];

afterEach(() => {
  removeDirs(directories);
  directories.length = 0;
});

function scratch(prefix = 'memento-init-') {
  const directory = tempDir(prefix);
  directories.push(directory);
  return directory;
}

function git(cwd, args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd, encoding, windowsHide: true });
}

test('Test_InitRepo_when_directory_is_empty_creates_the_layout_and_initial_commit', async () => {
  const parent = scratch();
  const directory = join(parent, 'memento');
  const result = await initRepo({ dir: directory });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.dir, directory);
  for (const relative of ['README.ko.md', '.gitattributes', '.gitignore', 'cards/.gitkeep', 'sync/state.json']) {
    assert.equal(existsSync(join(directory, ...relative.split('/'))), true, relative);
  }
  assert.equal(readFileSync(join(directory, '.gitattributes'), 'utf8'), '* text=auto eol=lf\n');
  assert.equal(readFileSync(join(directory, 'cards', '.gitkeep')).length, 0);
  assert.equal(git(directory, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main');
  assert.equal(git(directory, ['log', '-1', '--format=%s']).trim(), 'memento: init');
  assert.equal(git(directory, ['status', '--porcelain']), '');
  assert.equal(
    git(directory, ['show', '--name-only', '--format=', 'HEAD']).trim().split(/\r?\n/).sort().join(','),
    '.gitattributes,.gitignore,README.ko.md,cards/.gitkeep,sync/state.json',
  );

  const state = JSON.parse(readFileSync(join(directory, 'sync', 'state.json'), 'utf8'));
  assert.deepEqual(state, {
    schema: 'memento.sync.v1',
    repoId: state.repoId,
    guildId: null,
    forumId: null,
    tagIds: {},
    ownerUserId: null,
    botUserId: null,
    audit: { lastEntryId: null, coveredSince: null, ingested: [] },
    pending: [],
    recentWrites: [],
    skipped: [],
    clock: null,
  });
  assert.match(state.repoId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(result.repoId, state.repoId);

  const readme = readFileSync(join(directory, 'README.ko.md'));
  assert.equal(readme[0] === 0xef && readme[1] === 0xbb && readme[2] === 0xbf, false);
  assert.equal(readme.includes(0x0d), false);
  const text = readme.toString('utf8');
  assert.match(text, /메멘토/);
  assert.match(text, /동기화/);
  assert.match(text, /직접 편집하지 마세요/);
});

test('Test_InitRepo_when_directory_has_unrelated_files_refuses_without_writing', async () => {
  const directory = scratch();
  mkdirSync(join(directory, 'existing'), { recursive: true });
  writeFileSync(join(directory, 'existing', 'keep.txt'), 'keep\n');

  const result = await initRepo({ dir: directory });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_EMPTY');
  assert.equal(existsSync(join(directory, '.git')), false);
  assert.equal(existsSync(join(directory, 'sync')), false);
  assert.equal(readFileSync(join(directory, 'existing', 'keep.txt'), 'utf8'), 'keep\n');
});

test('Test_InitRepo_when_already_initialized_is_idempotent_and_keeps_repoId', async () => {
  const parent = scratch();
  const directory = join(parent, 'memento');
  const first = await initRepo({ dir: directory });
  const stateBefore = readFileSync(join(directory, 'sync', 'state.json'));
  const headBefore = git(directory, ['rev-parse', 'HEAD']).trim();

  const second = await initRepo({ dir: directory });

  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.alreadyInitialized, true);
  assert.equal(second.repoId, first.repoId);
  assert.equal(readFileSync(join(directory, 'sync', 'state.json')).equals(stateBefore), true);
  assert.equal(git(directory, ['rev-parse', 'HEAD']).trim(), headBefore);
});

test('Test_InitRepo_when_remote_is_given_adds_origin_without_pushing', async () => {
  const parent = scratch();
  const directory = join(parent, 'memento');
  const bare = join(parent, 'remote.git');
  git(parent, ['init', '--bare', '--quiet', bare]);

  const result = await initRepo({ dir: directory, remote: bare });

  assert.equal(result.ok, true);
  assert.equal(result.remote, bare);
  assert.equal(git(directory, ['remote', 'get-url', 'origin']).trim(), bare);
  const remoteHead = spawnSync('git', ['--git-dir', bare, 'rev-parse', '--verify', 'main'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(remoteHead.status, 0);
});

test('Test_InitRepo_when_no_remote_is_given_leaves_no_remote_and_no_push', async () => {
  const parent = scratch();
  const directory = join(parent, 'memento');

  const result = await initRepo({ dir: directory });

  assert.equal(result.ok, true);
  assert.equal(result.remote, null);
  assert.equal(git(directory, ['remote']).trim(), '');
});
