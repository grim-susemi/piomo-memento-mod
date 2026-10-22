import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeDirs, tempDir } from './fixtures/store/harness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'memento.mjs');
const directories = [];

afterEach(() => {
  removeDirs(directories);
  directories.length = 0;
});

function scratch(prefix = 'memento-cli-') {
  const directory = tempDir(prefix);
  directories.push(directory);
  return directory;
}

function run(args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('Test_CliInit_when_given_a_temp_directory_and_bare_remote_initializes_the_repo', () => {
  const parent = scratch();
  const bare = join(parent, 'remote.git');
  execFileSync('git', ['init', '--bare', '--quiet', bare], { cwd: parent, windowsHide: true });
  const directory = join(parent, 'memento');

  const output = run(['init', directory, '--remote', bare]);

  assert.match(output, /memento: initialized/);
  assert.match(output, /memento: initial commit/);
  assert.equal(existsSync(join(directory, 'sync', 'state.json')), true);
  assert.equal(execFileSync('git', ['-C', directory, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(), 'main');
  assert.equal(execFileSync('git', ['-C', directory, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim(), bare);
});

test('Test_CliInit_when_the_directory_has_files_exits_2_and_writes_nothing', () => {
  const directory = scratch();
  writeFileSync(join(directory, 'keep.txt'), 'keep\n');

  const result = spawnSync(process.execPath, [CLI, 'init', directory], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /NOT_EMPTY/);
  assert.equal(existsSync(join(directory, '.git')), false);
  assert.equal(readFileSync(join(directory, 'keep.txt'), 'utf8'), 'keep\n');
});

test('Test_CliHelp_when_called_lists_the_init_command', () => {
  const output = run(['--help']);

  assert.match(output, /init <dir> \[--remote <url>\]/);
});
