// TASK12 lifecycle candidate: real extension + fake pi host + real temp repo.
// No mocked board API: the published object is the real createBoardApi facade and
// a stale rev is rejected by the real contract. Syncs run through the frozen
// runSync with a repository whose Discord ids are absent, so no network is used.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import extension, { REGISTRATION_KEY, shouldSync } from '../src/extension.mjs';
import { getSyncNow } from '../src/intake/capture.mjs';
import { initRepo } from '../src/store/init.mjs';
import { acquire, release } from '../src/store/lock.mjs';
import { openStore } from '../src/store/store.mjs';

const API_KEY = Symbol.for('omo.memento.api.v1');
const ENV_KEYS = ['SENPI_CODING_AGENT_DIR', 'OMO_CODING_AGENT_DIR', 'OMO_MEMENTO'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const dirs = [];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  delete globalThis[REGISTRATION_KEY];
  delete globalThis[API_KEY];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function tempDir(prefix = 'memento-life-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function createFakePi({ sessionKind = 'interactive', sessionFile = 'owned/session.jsonl', hasUI = true, agentDir = '' } = {}) {
  const handlers = new Map();
  const ctx = {
    hasUI,
    agentDir,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => 'lifecycle-session',
    },
    ui: { notify() {} },
  };
  const pi = {
    sessionKind,
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    registerTool() {},
    registerCommand() {},
  };
  return { pi, ctx, handlers };
}

async function fire(fake, name, event = {}, ctx = fake.ctx) {
  for (const handler of fake.handlers.get(name) ?? []) await handler(event, ctx);
}

async function setupRepo({ configured = true } = {}) {
  const parent = tempDir();
  const agentDir = join(parent, 'agent');
  const repo = join(parent, 'repo');
  mkdirSync(join(agentDir, 'logs'), { recursive: true });
  const tokenFile = join(parent, 'token');
  writeFileSync(tokenFile, 'synthetic-lifecycle-token\n');
  const init = await initRepo({ dir: repo });
  assert.equal(init.ok, true);
  if (configured) {
    mkdirSync(join(agentDir, 'memento'), { recursive: true });
    writeFileSync(join(agentDir, 'memento', 'config.json'), JSON.stringify({
      repoPath: repo,
      tokenFile,
      remote: null,
    }));
  }
  process.env.SENPI_CODING_AGENT_DIR = agentDir;
  return { parent, agentDir, repo, receipts: join(agentDir, 'logs', 'memento.jsonl') };
}

function receiptText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Event-driven receipt wait (fs.watch), bounded; no polling loop. */
function waitForReceipt(path, predicate, ms = 10_000) {
  return new Promise((resolve, reject) => {
    let watcher = null;
    let timer = null;
    const done = (value, error) => {
      if (timer) clearTimeout(timer);
      watcher?.close();
      if (error) reject(error);
      else resolve(value);
    };
    const check = () => {
      if (predicate(receiptText(path))) done(true);
    };
    watcher = watch(join(path, '..'), check);
    timer = setTimeout(() => done(false, new Error('timed out waiting for receipt')), ms);
    check();
  });
}

function terminalCount(text) {
  return (text.match(/"event":"sync-(?:complete|aborted)"/g) ?? []).length;
}

async function fireLead(env, fake, reason = 'startup', ctx = fake.ctx) {
  const before = terminalCount(receiptText(env.receipts));
  await fire(fake, 'session_start', { reason }, ctx);
  if (shouldSync(reason)) {
    await waitForReceipt(env.receipts, (text) => terminalCount(text) > before);
    // Let the settled sync promise clear its controller before the next event.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function startLead(env, reason = 'startup') {
  const fake = createFakePi();
  const runtime = extension(fake.pi);
  assert.ok(runtime);
  await fireLead(env, fake, reason);
  return { fake, runtime };
}

test('Test_Lead_startup_publishes_the_real_api_and_wires_sync_now', async () => {
  const env = await setupRepo();
  const { fake } = await startLead(env);

  const api = globalThis[API_KEY];
  assert.ok(api, 'the API is published');
  assert.equal(api.version, 1);
  assert.deepEqual(api.features, ['cards.read', 'cards.setStatus']);
  assert.equal(Object.keys(api).length, 4);
  assert.equal(typeof getSyncNow(), 'function');

  const store = openStore(env.repo);
  const created = await store.create({
    title: '수명 카드',
    description: '수명 카드',
    original: '원문',
    source: 'paste',
    sourceRef: 'test:lifecycle',
    via: 'paste',
    actor: 'owner',
  });
  assert.equal(created.ok, true);
  const ok = await api.handle({
    action: 'setStatus', id: created.id, status: 'planned', rev: created.rev, requestId: 'life-1',
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.discord, 'off');
  const stale = await api.handle({
    action: 'setStatus', id: created.id, status: 'done', rev: created.rev, requestId: 'life-2',
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'STALE', 'the published object is the real contract, not a stub');
  const state = api.state();
  assert.equal(state.schema, 'memento.board-state.v1');
  assert.equal(state.cards.some((card) => card.id === created.id), true);

  await waitForReceipt(env.receipts, (text) => /"event":"sync-complete"/.test(text));
  await fire(fake, 'session_shutdown', {}, fake.ctx);
  assert.equal(globalThis[API_KEY], undefined, 'shutdown removes its own API');
  assert.equal(getSyncNow(), null);
});

test('Test_Worker_and_child_sessions_publish_nothing', async () => {
  const env = await setupRepo();
  assert.equal(extension(createFakePi({ sessionKind: 'worker' }).pi), undefined);
  assert.equal(globalThis[API_KEY], undefined);

  const { fake } = await startLead(env);
  assert.ok(globalThis[API_KEY]);
  await fire(fake, 'session_start', { reason: 'startup' }, { ...fake.ctx, hasUI: false });  assert.equal(globalThis[API_KEY], undefined, 'a child session releases its own API');
  assert.equal(getSyncNow(), null);
});

test('Test_Configured_only_and_rebind_replaces_the_published_instance', async () => {
  const unconfigured = await setupRepo({ configured: false });
  const bare = createFakePi();
  assert.ok(extension(bare.pi));
  await fire(bare, 'session_start', { reason: 'startup' }, bare.ctx);
  assert.equal(globalThis[API_KEY], undefined, 'no API without config');
  assert.equal(getSyncNow(), null);
  await fire(bare, 'session_shutdown', {}, bare.ctx);

  const env = await setupRepo();
  const first = await startLead(env);
  const api1 = globalThis[API_KEY];
  assert.ok(api1);

  await fireLead(env, first.fake, 'new');
  const api2 = globalThis[API_KEY];
  assert.ok(api2);
  assert.notEqual(api2, api1, 'a rebind publishes a fresh own instance');
  assert.equal(shouldSync('new'), true);
  assert.equal(shouldSync('resume'), true);
  assert.equal(shouldSync('startup'), true);
  assert.equal(shouldSync('reload'), false);
  assert.equal(shouldSync('fork'), false);

  await fireLead(env, first.fake, 'reload');
  const api3 = globalThis[API_KEY];
  assert.notEqual(api3, api2, 'reload rebinds the config and the API instance');
  await fire(first.fake, 'session_shutdown', {}, first.fake.ctx);
  assert.equal(globalThis[API_KEY], undefined);
});

test('Test_Shutdown_unpublishes_only_its_own_api_not_a_newer_instance', async () => {
  const env = await setupRepo();
  const a = await startLead(env);
  const apiA = globalThis[API_KEY];
  assert.ok(apiA);

  // A stale second runtime: the first instance is no longer the registered runtime
  // but still owns the published object.
  globalThis[REGISTRATION_KEY].runtime = null;
  const bFake = createFakePi();
  const bRuntime = extension(bFake.pi);
  assert.ok(bRuntime);
  assert.notEqual(bRuntime, a.runtime);
  await fireLead(env, bFake, 'startup');
  assert.equal(globalThis[API_KEY], apiA, 'the second instance does not replace the first object');

  await fire(bFake, 'session_shutdown', {}, bFake.ctx);
  assert.equal(globalThis[API_KEY], apiA, 'the second instance never removes the first API');

  await fire(a.fake, 'session_shutdown', {}, a.fake.ctx);
  assert.equal(globalThis[API_KEY], undefined, 'the owner removes only its own object');
});

test('Test_Unknown_after_lead_revokes_write_and_a_lead_retry_works', async () => {
  const env = await setupRepo();
  const { fake, runtime } = await startLead(env, 'reload');
  assert.ok(globalThis[API_KEY]);
  assert.equal(typeof getSyncNow(), 'function');

  const unknownCtx = {
    ...fake.ctx,
    sessionManager: {
      getSessionFile() { throw new Error('identity-unreadable'); },
      getSessionId: () => 'unknown-session',
    },
  };
  await fire(fake, 'session_start', { reason: 'resume' }, unknownCtx);
  assert.equal(runtime.identity, 'unknown');
  assert.equal(runtime.active, false);
  assert.equal(globalThis[API_KEY], undefined, 'unknown identity unpublishes the lead API');
  assert.equal(getSyncNow(), null, 'unknown identity clears the lead syncNow callback');
  assert.equal(globalThis[REGISTRATION_KEY].runtime, runtime, 'unknown retains the registration for a retry');

  await fire(fake, 'session_start', { reason: 'reload' }, fake.ctx);
  assert.equal(runtime.identity, 'lead');
  assert.ok(globalThis[API_KEY], 'a proven lead retry republishes');
  assert.equal(typeof getSyncNow(), 'function');
  const api = globalThis[API_KEY];
  const store = openStore(env.repo);
  const created = await store.create({
    title: '재시도 카드',
    description: '재시도 카드',
    original: '원문',
    source: 'paste',
    sourceRef: 'test:lifecycle-retry',
    via: 'paste',
    actor: 'owner',
  });
  assert.equal(created.ok, true);
  const ok = await api.handle({
    action: 'setStatus', id: created.id, status: 'planned', rev: created.rev, requestId: 'retry-ok',
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.discord, 'off');
  const stale = await api.handle({
    action: 'setStatus', id: created.id, status: 'done', rev: created.rev, requestId: 'retry-stale',
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'STALE');
  await fire(fake, 'session_shutdown', {}, fake.ctx);
});

test('Test_Configured_to_unconfigured_clears_the_api_and_sync_now', async () => {
  const env = await setupRepo();
  const { fake } = await startLead(env, 'reload');
  assert.ok(globalThis[API_KEY]);
  assert.equal(typeof getSyncNow(), 'function');

  writeFileSync(join(env.agentDir, 'memento', 'config.json'), '{invalid json');
  await fire(fake, 'session_start', { reason: 'reload' }, fake.ctx);
  assert.equal(globalThis[API_KEY], undefined, 'unconfigured transition unpublishes the API');
  assert.equal(getSyncNow(), null, 'unconfigured transition clears the stale callback');
  assert.equal(globalThis[REGISTRATION_KEY].runtime !== undefined, true);
});

test('Test_A_stale_instance_cannot_clear_the_new_callback', async () => {
  const env = await setupRepo();
  const a = await startLead(env, 'reload');
  const aCallback = getSyncNow();
  assert.equal(typeof aCallback, 'function');

  globalThis[REGISTRATION_KEY].runtime = null;
  const bFake = createFakePi();
  const bRuntime = extension(bFake.pi);
  assert.ok(bRuntime);
  await fire(bFake, 'session_start', { reason: 'reload' }, bFake.ctx);
  const bCallback = getSyncNow();
  assert.equal(typeof bCallback, 'function');
  assert.notEqual(bCallback, aCallback);

  await fire(a.fake, 'session_shutdown', {}, a.fake.ctx);
  assert.equal(getSyncNow(), bCallback, 'a stale instance never clears the new callback');
  await fire(bFake, 'session_shutdown', {}, bFake.ctx);
  assert.equal(getSyncNow(), null);
});

test('Test_Session_start_does_not_await_the_sync', async () => {
  const env = await setupRepo();
  const held = await acquire(env.repo, 'write', { waitMs: 0 });
  assert.equal(held.ok, true);

  try {
    const fake = createFakePi();
    const runtime = extension(fake.pi);
    assert.ok(runtime);
    const watcher = waitForReceipt(env.receipts, (text) => /"event":"sync-complete"/.test(text), 10_000);
    await fire(fake, 'session_start', { reason: 'startup' }, fake.ctx);
    assert.equal(/sync-complete/.test(receiptText(env.receipts)), false,
      'the handler returned while the sync could not complete');

    await release(held);
    await watcher;
    assert.equal(/sync-complete/.test(receiptText(env.receipts)), true);
    await fire(fake, 'session_shutdown', {}, fake.ctx);
  } finally {
    await release(held).catch(() => {});
  }
});
