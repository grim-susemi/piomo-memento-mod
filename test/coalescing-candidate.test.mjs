import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import extension, { REGISTRATION_KEY } from '../src/extension.mjs';
import { getSyncNow, setSyncNow } from '../src/intake/capture.mjs';
import { acquire, release } from '../src/store/lock.mjs';
import { makeSyncEnv } from './fixtures/sync/harness.mjs';
import { createFakePi } from './fixtures/intake/harness.mjs';

const envs = [];

async function setup() {
  const env = await makeSyncEnv();
  envs.push(env);
  mkdirSync(join(env.agentDir, 'memento'), { recursive: true });
  writeFileSync(join(env.agentDir, 'memento', 'config.json'), `${JSON.stringify({
    repoPath: env.repo,
    tokenFile: env.tokenFile,
    remote: env.remote,
  })}\n`);
  process.env.SENPI_CODING_AGENT_DIR = env.agentDir;
  return env;
}

afterEach(async () => {
  delete globalThis[REGISTRATION_KEY];
  setSyncNow(null);
  delete process.env.SENPI_CODING_AGENT_DIR;
  for (const env of envs.splice(0)) await env.close();
});

function bounded(promise, label, ms = 10_000) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function receiptCount(env, event) {
  const path = join(env.agentDir, 'logs', 'memento.jsonl');
  let raw = '';
  try { raw = readFileSync(path, 'utf8'); } catch { return 0; }
  return raw.split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === event).length;
}

test('Test_Coalescing_two_simultaneous_session_starts_one_active_one_rerun', async () => {
  // Given two simultaneous lead session starts and real loopback audit holds;
  // when both pi events fire before the first sync settles; then exactly one
  // active cycle plus one rerun complete, with no aborted or duplicate cycle.
  const env = await setup();
  const fake = createFakePi({
    agentDir: env.agentDir,
    sessionFile: join(env.agentDir, 'lead.jsonl'),
  });
  extension(fake.pi, { client: env.client });
  const auditPath = `/guilds/${env.fake.ids.guildId}/audit-logs`;
  const firstHold = env.fake.hooks.holdNext({ method: 'GET', path: auditPath });
  const secondHold = env.fake.hooks.holdNext({ method: 'GET', path: auditPath });

  const firstEvent = fake.emit('session_start', { reason: 'startup' }, fake.ctx);
  try {
    await bounded(firstHold.arrived, 'first held audit request');
    await firstEvent;
    const secondEvent = fake.emit('session_start', { reason: 'startup' }, fake.ctx);
    await bounded(secondEvent, 'second session_start');
    const sync = getSyncNow()();
    firstHold.release();
    await bounded(secondHold.arrived, 'second held audit request');
    secondHold.release();
    await bounded(sync, 'coalesced sync');

    assert.equal(receiptCount(env, 'sync-start'), 2, 'exactly two cycles start');
    assert.equal(receiptCount(env, 'sync-aborted'), 0, 'no cycle is aborted');
    assert.equal(receiptCount(env, 'sync-complete'), 2, 'both cycles complete');
    assert.equal(receiptCount(env, 'sync-failed'), 0, 'no failed cycle');

    const syncLock = await acquire(env.repo, 'sync', { waitMs: 0 });
    assert.equal(syncLock.ok, true);
    await release(syncLock);
    const writeLock = await acquire(env.repo, 'write', { waitMs: 0 });
    assert.equal(writeLock.ok, true);
    await release(writeLock);
  } finally {
    firstHold.release();
    secondHold.release();
  }
});
