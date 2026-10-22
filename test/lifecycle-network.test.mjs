// TASK12 lifecycle attempt 2: full-extension held-network verification.
//
// The real extension is given an actual createDiscordClient pointed at an owned
// loopback fake through the public factory client dependency; the real
// createBoardApi and runSync consume it. No API/runner replacement.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import extension, { REGISTRATION_KEY } from '../src/extension.mjs';
import { getSyncNow } from '../src/intake/capture.mjs';
import { acquire, release } from '../src/store/lock.mjs';
import { makeApiEnv } from './fixtures/api/harness.mjs';

const API_KEY = Symbol.for('omo.memento.api.v1');
const savedEnv = process.env.SENPI_CODING_AGENT_DIR;
const envs = [];

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
  else process.env.SENPI_CODING_AGENT_DIR = savedEnv;
  delete globalThis[REGISTRATION_KEY];
  delete globalThis[API_KEY];
  for (const env of envs.splice(0)) await env.close();
});

function bounded(promise, label, ms = 10_000) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createFakePi() {
  const handlers = new Map();
  const ctx = {
    hasUI: true,
    agentDir: '',
    sessionManager: {
      getSessionFile: () => 'owned/session.jsonl',
      getSessionId: () => 'lifecycle-network',
    },
    ui: { notify() {} },
  };
  const pi = {
    sessionKind: 'interactive',
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

async function setup() {
  const env = await makeApiEnv();
  envs.push(env);
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title,
    appliedTags: [env.tags.idea],
    content: card.original,
  });
  const linked = await env.linkCard(card, thread, 'idea');
  const agentDir = join(env.parent, 'life-agent');
  mkdirSync(join(agentDir, 'memento'), { recursive: true });
  writeFileSync(join(agentDir, 'memento', 'config.json'), JSON.stringify({
    repoPath: env.repo,
    tokenFile: env.tokenFile,
    remote: null,
  }));
  process.env.SENPI_CODING_AGENT_DIR = agentDir;
  return {
    env,
    card: linked,
    thread,
    agentDir,
    receipts: join(agentDir, 'logs', 'memento.jsonl'),
  };
}

function captureSockets(fake) {
  const sockets = new Set();
  const listener = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  fake.server.on('connection', listener);
  return {
    sockets,
    stop: () => fake.server.off('connection', listener),
  };
}

function waitForSocketClose(socket, ms = 10_000) {
  if (!socket) return Promise.resolve(true);
  if (socket.destroyed) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    let timer = null;
    const done = (value, error) => {
      if (timer) clearTimeout(timer);
      socket.off('close', onClose);
      if (error) reject(error);
      else resolve(value);
    };
    const onClose = () => done(true);
    timer = setTimeout(() => done(false, new Error('held socket did not close')), ms);
    socket.once('close', onClose);
  });
}

function receiptText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

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

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

async function lockIsFree(repo, name) {
  const lock = await acquire(repo, name, { waitMs: 500 });
  const free = lock.ok === true;
  if (free) await release(lock);
  return free;
}

test('Test_Shutdown_aborts_the_published_api_held_request_and_keeps_pending', async () => {
  const { env, card, thread, receipts } = await setup();
  const captured = captureSockets(env.fake);
  const fake = createFakePi();
  assert.ok(extension(fake.pi, { client: env.client }));
  const hold = env.fake.hooks.holdNext({ method: 'GET', path: `/channels/${thread.id}` });

  try {
    await fire(fake, 'session_start', { reason: 'reload' }, fake.ctx);
    const api = globalThis[API_KEY];
    assert.ok(api);
    const replyPromise = api.handle({
      action: 'setStatus', id: card.id, status: 'done', rev: card.rev, requestId: 'net-api',
    });
    await bounded(hold.arrived, 'held API GET');
    const heldSocket = [...captured.sockets].filter((socket) => !socket.destroyed).at(-1);
    assert.ok(heldSocket, 'the held HTTP request has a live socket');

    await fire(fake, 'session_shutdown', {}, fake.ctx);
    const reply = await bounded(replyPromise, 'API reply');
    assert.equal(reply.body.discord, 'pending');
    await bounded(waitForSocketClose(heldSocket), 'held API socket close');
    await waitForReceipt(receipts, (text) => /"event":"board-thread-read-failed"/.test(text));

    assert.equal(globalThis[API_KEY], undefined);
    assert.equal(getSyncNow(), null);
    const state = JSON.parse(readFileSync(join(env.repo, 'sync', 'state.json'), 'utf8'));
    assert.equal(state.pending.some((entry) => entry.cardId === card.id), true, 'durable pending op');
    const stored = await env.card(card.id);
    assert.ok(stored.rev > card.rev, 'the local card commit completed before the abort');
    assert.equal(existsSync(join(env.repo, '.git', 'index.lock')), false);
    assert.equal(git(env.repo, ['status', '--porcelain', '--untracked-files=all']), '');
    assert.equal(await lockIsFree(env.repo, 'write'), true, 'the write lock is released');
    assert.equal(await lockIsFree(env.repo, 'sync'), true, 'the sync lock is released');
  } finally {
    hold.release();
    captured.stop();
  }
});

test('Test_Shutdown_aborts_the_sync_held_request_and_releases_locks', async () => {
  const { env, receipts } = await setup();
  const captured = captureSockets(env.fake);
  const fake = createFakePi();
  assert.ok(extension(fake.pi, { client: env.client }));
  const hold = env.fake.hooks.holdNext({ method: 'GET', path: '/users/@me' });

  try {
    await fire(fake, 'session_start', { reason: 'startup' }, fake.ctx);
    await bounded(hold.arrived, 'held sync getMe');
    const heldSocket = [...captured.sockets].filter((socket) => !socket.destroyed).at(-1);
    assert.ok(heldSocket);

    await fire(fake, 'session_shutdown', {}, fake.ctx);
    await bounded(waitForSocketClose(heldSocket), 'held sync socket close');
    await waitForReceipt(receipts, (text) => /"event":"sync-(?:aborted|complete)"/.test(text));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(getSyncNow(), null);
    assert.equal(await lockIsFree(env.repo, 'sync'), true);
    assert.equal(await lockIsFree(env.repo, 'write'), true);
    assert.equal(existsSync(join(env.repo, '.git', 'index.lock')), false);
    assert.equal(git(env.repo, ['status', '--porcelain', '--untracked-files=all']), '');
    const head = git(env.repo, ['rev-parse', 'HEAD']).trim();
    assert.match(head, /^[0-9a-f]{40}$/);
  } finally {
    hold.release();
    captured.stop();
  }
});

test('Test_Rebind_aborts_the_old_sync_and_publishes_a_new_api', async () => {
  const { env, receipts } = await setup();
  const captured = captureSockets(env.fake);
  const fake = createFakePi();
  assert.ok(extension(fake.pi, { client: env.client }));
  const hold = env.fake.hooks.holdNext({ method: 'GET', path: '/users/@me' });

  try {
    await fire(fake, 'session_start', { reason: 'startup' }, fake.ctx);
    const apiBefore = globalThis[API_KEY];
    assert.ok(apiBefore);
    await bounded(hold.arrived, 'held sync getMe before rebind');
    const heldSocket = [...captured.sockets].filter((socket) => !socket.destroyed).at(-1);
    assert.ok(heldSocket);

    await fire(fake, 'session_start', { reason: 'new' }, fake.ctx);
    await bounded(waitForSocketClose(heldSocket), 'old sync socket close');
    // The old sync settles (aborted); the replacement sync may find the sync lock
    // still held and report busy, which is the runner's documented behavior.
    await waitForReceipt(receipts, (text) => {
      const terminals = text.match(/"event":"sync-(?:aborted|complete)"/g) ?? [];
      return terminals.length >= 1;
    });
    const apiAfter = globalThis[API_KEY];
    assert.ok(apiAfter, 'the rebind publishes a fresh API');
    assert.notEqual(apiAfter, apiBefore, 'the old facade is replaced');
    assert.equal(typeof getSyncNow(), 'function');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await lockIsFree(env.repo, 'sync'), true);
    assert.equal(existsSync(join(env.repo, '.git', 'index.lock')), false);

    await fire(fake, 'session_shutdown', {}, fake.ctx);
    assert.equal(globalThis[API_KEY], undefined);
  } finally {
    hold.release();
    captured.stop();
  }
});
