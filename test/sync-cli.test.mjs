import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { afterEach } from 'node:test';
import { openStore } from '../src/store/store.mjs';
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

function writeConfig(env) {
  const dir = join(env.agentDir, 'memento');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({
    repoPath: env.repo, tokenFile: env.tokenFile, remote: env.remote,
  })}\n`);
}

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

test('Test_CrashHook_when_the_env_value_is_not_exactly_1_links_normally', async () => {
  // Given a configured CLI run with the hook value "true"; when it syncs; then it
  // never crashes and the one post is linked.
  const env = await setup();
  writeConfig(env);
  const card = await env.newCard();

  const run = await runCli(['sync', '--discord-base', env.fake.baseUrl], {
    SENPI_CODING_AGENT_DIR: env.agentDir,
    MEMENTO_TEST_CRASH_AFTER_CREATE: 'true',
  });

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /sync: ok/);
  assert.equal(env.posts().length, 1);
  const linked = await env.card(card.id);
  assert.equal(linked.discordState, 'linked');
  assert.ok(linked.discordThread);
});

test('Test_CrashHook_when_1_exits_after_the_create_response_and_the_next_sync_adopts_one_post', async () => {
  // Given a real CLI child with the hook exactly 1; when the create response
  // arrives; then it exits 70 before saving the link, keeps one post and a
  // posting card; the next sync links by marker exactly once.
  const env = await setup();
  writeConfig(env);
  const card = await env.newCard();

  const crashed = await runCli(['sync', '--discord-base', env.fake.baseUrl], {
    SENPI_CODING_AGENT_DIR: env.agentDir,
    MEMENTO_TEST_CRASH_AFTER_CREATE: '1',
  });

  assert.equal(crashed.code, 70, `${crashed.stdout}\n${crashed.stderr}`);
  assert.equal(env.posts().length, 1);
  const posting = await env.card(card.id);
  assert.equal(posting.discordState, 'posting');
  assert.equal(posting.discordThread, '');
  const pending = env.readState().pending.filter((entry) => entry.kind === 'create');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sent, true);
  assert.equal(git(env.repo, ['status', '--porcelain']).trim(), '');

  const recovered = await runCli(['sync', '--discord-base', env.fake.baseUrl], {
    SENPI_CODING_AGENT_DIR: env.agentDir,
    MEMENTO_TEST_CRASH_AFTER_CREATE: '0',
  });

  assert.equal(recovered.code, 0, `${recovered.stdout}\n${recovered.stderr}`);
  assert.match(recovered.stdout, /sync: ok/);
  assert.equal(env.posts().length, 1);
  const linked = await env.card(card.id);
  assert.equal(linked.discordState, 'linked');
  assert.ok(linked.discordThread);
  assert.equal((await env.cards()).length, 1);
  assert.equal(env.readState().pending.filter((entry) => entry.kind === 'create').length, 0);
});

test('Test_DryRun_when_the_restored_repo_is_converged_plans_zero_and_keeps_links', async () => {
  // Given a pushed card and post; when a real CLI dry-runs the restored clone;
  // then it reports zero planned actions and writes nothing.
  const env = await setup();
  const card = await env.newCard();
  const synced = await env.run();
  assert.equal(synced.actions.posted, 1);
  const clone = env.cloneRestored('dry-converged');
  const before = snapshot(clone);
  const mutations = env.mutations().length;
  const agentDir = join(env.parent, 'unconfigured-agent');

  const run = await runCli([
    'sync', '--dry-run', '--repo', clone,
    '--discord-base', env.fake.baseUrl, '--token-file', env.tokenFile,
    '--agent-dir', agentDir,
  ], { SENPI_CODING_AGENT_DIR: agentDir });

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /sync: dry-run ok cards 1 linked 1 planned 0/);
  assert.equal(env.mutations().length, mutations, 'dry-run must not write to Discord');
  assert.deepEqual(snapshot(clone), before);
  assert.equal(existsSync(join(agentDir, 'logs', 'memento.jsonl')), false);
  const restored = openStore(clone, { sleep: async () => {}, lockWaitMs: 500 });
  const restoredCard = await restored.get(card.id);
  assert.equal(restoredCard.ok, true);
  assert.equal(restoredCard.card.discordState, 'linked');
});

test('Test_DryRun_when_the_board_status_differs_reports_one_planned_push_without_writes', async () => {
  // Given a linked card whose board status differs from the remote tag; when a real
  // CLI dry-runs; then it reports one planned push and no Discord, card, state, git
  // or receipt write happens.
  const env = await setup();
  const card = await env.newCard();
  await env.run();
  const linked = await env.card(card.id);
  await env.updateCard(card.id, (current) => ({ ...current, status: 'done' }), {
    at: new Date(env.clock.now()).toISOString(),
    eventId: 'board-dry-run',
    actor: 'owner', via: 'board', change: 'status',
    from: linked.status, to: 'done', reason: 'owner-board',
  });

  const before = snapshot(env.repo);
  const mutations = env.mutations().length;
  const receiptsPath = join(env.agentDir, 'logs', 'memento.jsonl');
  const receiptsBefore = fileHash(receiptsPath);

  const run = await runCli([
    'sync', '--dry-run', '--repo', env.repo,
    '--discord-base', env.fake.baseUrl, '--token-file', env.tokenFile,
    '--agent-dir', env.agentDir,
  ], { SENPI_CODING_AGENT_DIR: join(env.parent, 'unconfigured-agent') });

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /sync: dry-run ok cards 1 linked 1 planned 1/);
  assert.match(run.stdout, /pushed 1/);
  assert.equal(env.mutations().length, mutations, 'dry-run must not write to Discord');
  assert.deepEqual(snapshot(env.repo), before);
  assert.equal(fileHash(receiptsPath), receiptsBefore);
  const after = await env.card(card.id);
  assert.equal(after.status, 'done');
  assert.equal(after.discordState, 'linked');
});
