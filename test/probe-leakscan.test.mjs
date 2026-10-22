import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'memento.mjs');
const TOKEN = 'synthetic-discord-token-0123456789';
const EXTRA = 'memento-card-synthetic-string';
const tempDirs = [];

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'memento-probe-leak-'));
  tempDirs.push(directory);
  return directory;
}

function writeFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('leak-scan cli timed out'));
    }, 30_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, pid: child.pid });
    });
  });
}

function gitInitRepo(directory) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  execFileSync('git', ['-C', directory, 'init', '-b', 'main'], { env });
  execFileSync('git', ['-C', directory, 'config', 'user.name', 'synthetic'], { env });
  execFileSync('git', ['-C', directory, 'config', 'user.email', 'synthetic@local'], { env });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('Test_LeakScan_when_clean prints zero counts and no content', async () => {
  const directory = tempDir();
  writeFile(join(directory, 'a', 'note.md'), 'clean Korean text 한 글자도 안 깨짐\n');
  const tokenFile = writeFile(join(tempDir(), 'token'), TOKEN);
  const { leakScan } = await import('../src/probe/leak-scan.mjs');

  const result = await leakScan({ token: TOKEN, paths: [join(directory, 'a')], gitRepos: [], strings: [] });

  assert.equal(result.matches, 0);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(result.perPath.length >= 1, true);
  assert.equal(result.perPath.every(entry => entry.matches === 0), true);
  assert.equal(readFileSync(tokenFile, 'utf8'), TOKEN);
});

test('Test_LeakScan_when_token_and_extra_strings_exist counts per path only', async () => {
  const directory = tempDir();
  const dirty = writeFile(join(directory, 'dirty.txt'), `${TOKEN}\n${EXTRA}\n${TOKEN}\n`);
  writeFile(join(directory, 'clean.txt'), 'nothing here\n');
  const { leakScan } = await import('../src/probe/leak-scan.mjs');

  const result = await leakScan({
    token: TOKEN, paths: [directory], gitRepos: [], strings: [EXTRA],
  });

  assert.equal(result.matches, 3);
  const entry = result.perPath.find(item => item.path.endsWith('dirty.txt'));
  assert.equal(entry.matches, 3);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes(EXTRA), false);
  assert.equal(readFileSync(dirty, 'utf8').includes(TOKEN), true);
});

test('Test_LeakScan_when_token_is_only_in_git_history finds it from git log', async () => {
  const directory = tempDir();
  gitInitRepo(directory);
  const file = join(directory, 'notes.md');
  writeFileSync(file, `before\n${TOKEN}\n`);
  execFileSync('git', ['-C', directory, 'add', 'notes.md']);
  execFileSync('git', ['-C', directory, 'commit', '-m', 'synthetic secret'], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  writeFileSync(file, 'before\nremoved\n');
  execFileSync('git', ['-C', directory, 'add', 'notes.md']);
  execFileSync('git', ['-C', directory, 'commit', '-m', 'synthetic cleanup'], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const { leakScan } = await import('../src/probe/leak-scan.mjs');

  const result = await leakScan({
    token: TOKEN, paths: [], gitRepos: [directory], strings: [],
  });

  assert.equal(result.matches >= 1, true);
  assert.equal(result.perRepo.length, 1);
  assert.equal(result.perRepo[0].repository, directory);
  assert.equal(result.perRepo[0].matches >= 1, true);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('Test_LeakScanCli_when_clean prints matches 0 and never the token', async () => {
  const directory = tempDir();
  writeFile(join(directory, 'evidence', 'probe.json'), '{"ok":true}\n');
  const tokenFile = writeFile(join(directory, 'token'), TOKEN);
  const stringsFile = writeFile(join(directory, 'strings.txt'), `${EXTRA}\n`);

  const result = await runCli([
    'leak-scan', '--token-file', tokenFile,
    '--paths', join(directory, 'evidence'), '--also', stringsFile,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /matches 0\b/);
  assert.equal(result.stdout.includes(TOKEN), false);
  assert.equal(result.stderr.includes(TOKEN), false);
});

test('Test_LeakScanCli_when_a_match_exists exits 1 without printing the match', async () => {
  const directory = tempDir();
  writeFile(join(directory, 'evidence', 'bad.txt'), `prefix ${TOKEN} suffix\n`);
  const tokenFile = writeFile(join(directory, 'token'), TOKEN);

  const result = await runCli([
    'leak-scan', '--token-file', tokenFile, '--paths', join(directory, 'evidence'),
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /matches 1\b/);
  assert.equal(result.stdout.includes(TOKEN), false);
  assert.equal(result.stderr.includes(TOKEN), false);
});

test('Test_LeakScanCli_when_token_file_missing exits 2 without a token', async () => {
  const directory = tempDir();
  const result = await runCli([
    'leak-scan', '--token-file', join(directory, 'missing'), '--paths', directory,
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /token-missing/);
});
