import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { afterEach } from 'node:test';
import { git, makeSyncEnv } from './fixtures/sync/harness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'memento.mjs');
const envs = [];

async function setup() {
  const env = await makeSyncEnv();
  env.clock.set(Date.now());
  envs.push(env);
  return env;
}

afterEach(async () => {
  for (const env of envs.splice(0)) await env.close();
});

function runCli(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function snapshot(repo) {
  const cardsDir = join(repo, 'cards');
  return {
    head: git(repo, ['rev-parse', 'HEAD']).trim(),
    status: git(repo, ['status', '--porcelain']).trim(),
    state: sha(join(repo, 'sync', 'state.json')),
    cards: readdirSync(cardsDir).sort().map((name) => [name, sha(join(cardsDir, name))]),
  };
}

function fileHash(file) {
  return existsSync(file) ? sha(file) : null;
}

function dryRun(env) {
  const agentDir = join(env.parent, 'unconfigured-agent');
  return runCli([
    'sync', '--dry-run', '--repo', env.repo,
    '--discord-base', env.fake.baseUrl, '--token-file', env.tokenFile,
    '--agent-dir', agentDir,
  ], { SENPI_CODING_AGENT_DIR: agentDir });
}

test('Test_DryRun_when_the_archived_listing_is_forbidden_reports_incomplete_and_exits_1', async () => {
  // Given an empty but configured repo and a 403 on the archived-public listing;
  // when the real CLI dry-runs; then it reports incomplete, exits 1, and writes
  // nothing to Discord, the card repo, state, git or receipts.
  const env = await setup();
  env.fake.hooks.forceStatus({
    method: 'GET',
    path: `/channels/${env.forumId}/threads/archived/public`,
    status: 403,
    body: { message: 'Missing Access', code: 50001 },
  });
  const before = snapshot(env.repo);
  const mutations = env.mutations().length;
  const receiptsPath = join(env.agentDir, 'logs', 'memento.jsonl');
  const receiptsBefore = fileHash(receiptsPath);

  const run = await dryRun(env);

  assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /sync: dry-run incomplete cards 0 linked 0 planned 0/);
  assert.match(run.stdout, /sync: dry-run stopped \(archived-list:403\)/);
  assert.equal(env.mutations().length, mutations, 'dry-run must not write to Discord');
  assert.deepEqual(snapshot(env.repo), before);
  assert.equal(fileHash(receiptsPath), receiptsBefore);
});

test('Test_DryRun_when_the_audit_read_is_forbidden_reports_incomplete_and_exits_1', async () => {
  // Given an empty but configured repo and a 403 on both audit reads;
  // when the real CLI dry-runs; then it reports incomplete, exits 1, and writes
  // nothing to Discord, the card repo, state, git or receipts.
  const env = await setup();
  env.fake.hooks.forceStatus({
    method: 'GET',
    path: `/guilds/${env.fake.ids.guildId}/audit-logs`,
    status: 403,
    times: 2,
    body: { message: 'Missing Access', code: 50001 },
  });
  const before = snapshot(env.repo);
  const mutations = env.mutations().length;
  const receiptsPath = join(env.agentDir, 'logs', 'memento.jsonl');
  const receiptsBefore = fileHash(receiptsPath);

  const run = await dryRun(env);

  assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /sync: dry-run incomplete cards 0 linked 0 planned 0/);
  assert.match(run.stdout, /sync: dry-run stopped \(audit-read:403\)/);
  assert.equal(env.mutations().length, mutations, 'dry-run must not write to Discord');
  assert.deepEqual(snapshot(env.repo), before);
  assert.equal(fileHash(receiptsPath), receiptsBefore);
});

test('Test_DryRun_when_archived_and_audit_are_empty_stays_complete_and_exits_0', async () => {
  // Given an empty but configured repo whose archived listing and audit reads all
  // succeed with no events; when the real CLI dry-runs; then a legitimate zero is
  // complete and exits 0, not a false incomplete.
  const env = await setup();
  const before = snapshot(env.repo);

  const run = await dryRun(env);

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /sync: dry-run ok cards 0 linked 0 planned 0/);
  assert.doesNotMatch(run.stdout, /incomplete/);
  assert.deepEqual(snapshot(env.repo), before);
});

test('Test_Sync_default_when_the_audit_read_is_forbidden_keeps_the_nonfatal_partial_policy', async () => {
  // Given a 403 on both audit reads; when the default live sync runs; then it
  // still returns ok/discord ok, records the failure, and does not become a
  // dry-run-style failure.
  const env = await setup();
  env.fake.hooks.forceStatus({
    method: 'GET',
    path: `/guilds/${env.fake.ids.guildId}/audit-logs`,
    status: 403,
    times: 2,
    body: { message: 'Missing Access', code: 50001 },
  });

  const result = await env.run();

  assert.equal(result.ok, true);
  assert.equal(result.discord, 'ok');
  assert.equal(result.actions.failures, 0);
  const events = readFileSync(join(env.agentDir, 'logs', 'memento.jsonl'), 'utf8')
    .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.event === 'audit-read-failed'));
});
