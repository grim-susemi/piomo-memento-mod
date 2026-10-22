import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import extension, { REGISTRATION_KEY } from '../src/extension.mjs';
import { getSyncNow, setSyncNow } from '../src/intake/capture.mjs';
import {
  createFakePi,
  makeRepo,
  removeDirs,
  tempDir,
  writeConfig,
} from './fixtures/intake/harness.mjs';

const ENV_KEYS = ['SENPI_CODING_AGENT_DIR', 'OMO_CODING_AGENT_DIR', 'OMO_MEMENTO'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let tempDirs = [];

beforeEach(() => {
  tempDirs = [];
});

afterEach(() => {
  delete globalThis[REGISTRATION_KEY];
  setSyncNow(null);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  removeDirs(tempDirs);
  tempDirs = [];
});

function receipts(agentDir) {
  const path = join(agentDir, 'logs', 'memento.jsonl');
  try {
    return readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function boot({ withTarget = true } = {}) {
  const { parent, repo } = await makeRepo();
  tempDirs.push(parent);
  const agentDir = tempDir('memento-sync-agent-');
  tempDirs.push(agentDir);
  writeConfig(agentDir, {
    repoPath: repo,
    tokenFile: join(agentDir, 'missing-token'),
  });
  if (withTarget) {
    const statePath = join(repo, 'sync', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    writeFileSync(statePath, `${JSON.stringify({
      ...state,
      guildId: '1',
      forumId: '2',
      tagIds: { idea: '3' },
      ownerUserId: '4',
      botUserId: '5',
    }, null, 2)}\n`);
  }
  process.env.SENPI_CODING_AGENT_DIR = agentDir;
  const sessionDir = tempDir('memento-sync-session-');
  tempDirs.push(sessionDir);
  const fake = createFakePi({ agentDir, sessionFile: join(sessionDir, 'lead.jsonl') });
  const runtime = extension(fake.pi);
  return { repo, agentDir, fake, runtime };
}

test('Test_Lifecycle_session_start_starts_one_bounded_sync_and_shutdown_clears_the_hook', async () => {
  // Given a configured lead session with no Discord token; when it starts; then one sync runs.
  const { agentDir, fake, runtime } = await boot();
  await fake.emit('session_start', { reason: 'startup' }, fake.ctx);
  assert.equal(runtime.active, true);

  const hook = getSyncNow();
  assert.equal(typeof hook, 'function', 'TASK9 command hook is wired to the sync runner');
  const result = await hook();
  assert.equal(result.ok, true);
  assert.equal(result.discord, 'unreachable');

  const lines = receipts(agentDir);
  assert.ok(lines.some((entry) => entry.event === 'sync-start'));
  assert.ok(lines.some((entry) => entry.event === 'sync-complete'));
  assert.ok(lines.some((entry) => entry.event === 'discord-unreachable'));

  await fake.emit('session_shutdown', {}, fake.ctx);
  assert.equal(getSyncNow(), null);
});

test('Test_Lifecycle_session_start_without_discord_identity_still_commits_and_pushes', async () => {
  // Given a configured repo with no forum identity; when the session starts;
  // then one sync runs and reaches the local commit/push path.
  const { agentDir, fake } = await boot({ withTarget: false });
  await fake.emit('session_start', { reason: 'startup' }, fake.ctx);
  const result = await getSyncNow()();
  assert.equal(result.discord, 'unconfigured');
  assert.equal(result.push, 'no-remote');
  const lines = receipts(agentDir);
  assert.ok(lines.some((entry) => entry.event === 'sync-start'));
  assert.ok(lines.some((entry) => entry.event === 'sync-complete'));
});

test('Test_Lifecycle_configured_data_repo_without_forum_pushes_a_local_bare_remote', async () => {
  // Given a configured repo with a bare remote and no forum; when the session starts;
  // then the unpushed card reaches the remote.
  const { parent, repo } = await makeRepo({ remote: true });
  tempDirs.push(parent);
  const agentDir = tempDir('memento-sync-agent-');
  tempDirs.push(agentDir);
  writeConfig(agentDir, {
    repoPath: repo,
    tokenFile: join(agentDir, 'missing-token'),
    remote: join(parent, 'remote.git'),
  });
  process.env.SENPI_CODING_AGENT_DIR = agentDir;
  const card = await (await import('../src/store/store.mjs')).openStore(repo).create({
    title: '시작 카드', description: '시작 카드', original: '시작 카드 원문',
    source: 'paste', sourceRef: 'session:startup', via: 'paste', actor: 'owner',
  });
  assert.equal(card.ok, true);
  const sessionDir = tempDir('memento-sync-session-');
  tempDirs.push(sessionDir);
  const fake = createFakePi({ agentDir, sessionFile: join(sessionDir, 'lead.jsonl') });
  extension(fake.pi);

  await fake.emit('session_start', { reason: 'startup' }, fake.ctx);
  const result = await getSyncNow()();

  assert.equal(result.discord, 'unconfigured');
  assert.equal(result.push, 'ok');
  const { execFileSync } = await import('node:child_process');
  const listing = execFileSync('git', ['--git-dir', join(parent, 'remote.git'), 'ls-tree', '-r', '--name-only', 'main'], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.ok(listing.includes(`cards/${card.id}.md`));
});

test('Test_Lifecycle_whole_extension_unconfigured_stays_inert', async () => {
  // Given no config.json at all; when the session starts; then no sync or receipt is created.
  const agentDir = tempDir('memento-sync-agent-');
  tempDirs.push(agentDir);
  process.env.SENPI_CODING_AGENT_DIR = agentDir;
  const sessionDir = tempDir('memento-sync-session-');
  tempDirs.push(sessionDir);
  const fake = createFakePi({ agentDir, sessionFile: join(sessionDir, 'lead.jsonl') });
  extension(fake.pi);

  await fake.emit('session_start', { reason: 'startup' }, fake.ctx);

  assert.equal(getSyncNow(), null);
  assert.equal(receipts(agentDir).filter((entry) => entry.event === 'sync-start').length, 0);
  assert.equal(receipts(agentDir).length, 0);
});

test('Test_Lifecycle_reload_rebinds_the_context_without_starting_another_sync', async () => {
  // Given a completed startup sync; when the runtime reloads; then the hook is rebound and no sync starts.
  const { agentDir, fake } = await boot();
  await fake.emit('session_start', { reason: 'startup' }, fake.ctx);
  await getSyncNow()();
  const before = receipts(agentDir).filter((entry) => entry.event === 'sync-start' || entry.event === 'sync-skipped').length;

  await fake.emit('session_start', { reason: 'reload' }, fake.ctx);
  await new Promise((resolve) => setImmediate(resolve));

  const after = receipts(agentDir).filter((entry) => entry.event === 'sync-start' || entry.event === 'sync-skipped').length;
  assert.equal(after, before);
  assert.equal(typeof getSyncNow(), 'function');
});

test('Test_Lifecycle_child_session_keeps_the_sync_hook_unset', async () => {
  // Given a child session; when it starts; then no sync hook and no receipt exists.
  const { parent, repo } = await makeRepo();
  tempDirs.push(parent);
  const agentDir = tempDir('memento-sync-agent-');
  tempDirs.push(agentDir);
  writeConfig(agentDir, { repoPath: repo, tokenFile: join(agentDir, 'missing-token') });
  process.env.SENPI_CODING_AGENT_DIR = agentDir;
  const fake = createFakePi({ sessionKind: 'worker', agentDir });

  const runtime = extension(fake.pi);
  await fake.emit('session_start', { reason: 'startup' }, fake.ctx);

  assert.equal(runtime, undefined);
  assert.equal(getSyncNow(), null);
  assert.equal(receipts(agentDir).length, 0);
  rmSync(agentDir, { recursive: true, force: true });
});
