import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { initRepo } from '../src/store/init.mjs';
import { commitPaths } from '../src/store/git.mjs';
import { openStore } from '../src/store/store.mjs';
import { removeDirs, tempDir } from './fixtures/store/harness.mjs';

const CARD = {
  title: '푸시 확인',
  description: '로컬 베어 원격으로 푸시 확인',
  original: '원문 바이트 그대로 👍',
  source: 'paste',
  sourceRef: 'session:push',
  via: 'paste',
  actor: 'owner',
};

const directories = [];
afterEach(() => {
  removeDirs(directories);
  directories.length = 0;
});

function scratch(prefix = 'memento-git-') {
  const directory = tempDir(prefix);
  directories.push(directory);
  return directory;
}

function gitRaw(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'buffer', windowsHide: true });
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

async function setupWithBare() {
  const parent = scratch();
  const bare = join(parent, 'remote.git');
  git(parent, ['init', '--bare', '--quiet', bare]);
  const directory = join(parent, 'memento');
  const init = await initRepo({ dir: directory, remote: bare });
  assert.equal(init.ok, true);
  const store = openStore(directory, { sleep: async () => {} });
  return { parent, bare, directory, store };
}

test('Test_Push_when_a_local_bare_remote_exists_updates_it_and_clears_unpushed', async () => {
  const { bare, directory, store } = await setupWithBare();
  const created = await store.create(CARD);
  assert.equal(created.ok, true);
  assert.equal(await store.unpushedCount(), 2);

  const pushed = await store.push();

  assert.equal(pushed.ok, true);
  assert.equal(await store.unpushedCount(), 0);
  assert.equal(git(bare, ['rev-parse', '--verify', 'main']).trim().length, 40);
  const workingBytes = readFileSync(join(directory, 'cards', `${created.id}.md`));
  const remoteBytes = gitRaw(bare, ['show', `main:cards/${created.id}.md`]);
  assert.equal(remoteBytes.equals(workingBytes), true);

  const expected = `memento: create ${created.id}\n\n${CARD.description}\n`;
  assert.equal(gitRaw(bare, ['log', 'main', '-1', '--format=%B']).toString('utf8'), `${expected}\n`);
  const secondPush = await store.push();
  assert.equal(secondPush.ok, true);
  assert.equal(await store.unpushedCount(), 0);
});

test('Test_Push_when_no_remote_is_configured_is_a_noop_and_reports_it', async () => {
  const parent = scratch();
  const directory = join(parent, 'memento');
  await initRepo({ dir: directory });
  const store = openStore(directory, { sleep: async () => {} });
  await store.create(CARD);

  const pushed = await store.push();

  assert.equal(pushed.ok, true);
  assert.equal(pushed.skipped, 'no-remote');
  assert.equal(await store.unpushedCount(), 0);
});

test('Test_Push_when_the_remote_path_does_not_exist_fails_without_touching_the_repo', async () => {
  const parent = scratch();
  const directory = join(parent, 'memento');
  await initRepo({ dir: directory });
  git(directory, ['remote', 'add', 'origin', join(parent, 'missing.git')]);
  const store = openStore(directory, { sleep: async () => {} });
  const created = await store.create(CARD);
  const head = git(directory, ['rev-parse', 'HEAD']).trim();
  const count = await store.unpushedCount();
  assert.ok(count >= 2);

  const pushed = await store.push();

  assert.equal(pushed.ok, false);
  assert.equal(git(directory, ['rev-parse', 'HEAD']).trim(), head);
  assert.equal(await store.unpushedCount(), count);
  assert.equal(git(directory, ['status', '--porcelain']), '');
  assert.equal(created.ok, true);
});

test('Test_CommitPaths_when_a_path_is_missing_reports_ADD_FAILED', async () => {
  const parent = scratch();
  const directory = join(parent, 'memento');
  await initRepo({ dir: directory });

  const result = await commitPaths(directory, ['cards/missing.md'], 'memento: missing path\n');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ADD_FAILED');
  assert.match(result.stderr, /did not match any files|pathspec/i);
});

test('Test_GitSource_when_inspected_never_uses_a_shell_or_puts_card_text_on_argv', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const source = readFileSync(join(root, 'src', 'store', 'git.mjs'), 'utf8');

  assert.equal(/shell\s*:\s*true/.test(source), false);
  assert.equal(/['"]-m['"]|--message/.test(source), false);
  assert.match(source, /['"]-F['"]/);
  assert.match(source, /['"]add['"],\s*['"]--['"]/);
  assert.equal(/GIT_TERMINAL_PROMPT:\s*['"]0['"]/.test(source), true);
  assert.equal(/GCM_INTERACTIVE:\s*['"]never['"]/.test(source), true);
});
