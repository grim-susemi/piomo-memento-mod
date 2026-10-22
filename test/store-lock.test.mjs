import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import {
  acquire,
  clearRerunFlag,
  hasRerunFlag,
  isPidAlive,
  lockPath,
  release,
  setRerunFlag,
} from '../src/store/lock.mjs';
import {
  makeRepo,
  removeDirs,
  send,
  spawnLockChild,
  stopChildren,
  waitForExit,
  waitForMessage,
} from './fixtures/store/harness.mjs';

const directories = [];
const children = [];

afterEach(async () => {
  stopChildren(children);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) await waitForExit(child).catch(() => {});
  }
  children.length = 0;
  removeDirs(directories);
  directories.length = 0;
});

function repo() {
  const directory = makeRepo();
  directories.push(directory);
  return directory;
}

async function holdLock(repoPath, name = 'write') {
  const child = spawnLockChild(repoPath, name, 'hold');
  children.push(child);
  const message = await waitForMessage(child, (item) => item.type === 'acquired');
  assert.equal(message.ok, true);
  return child;
}

function writeRawLock(repoPath, name, value) {
  const target = lockPath(repoPath, name);
  mkdirSync(join(repoPath, '.git', 'memento'), { recursive: true });
  writeFileSync(target, value);
  return target;
}

test('Test_Acquire_when_two_processes_compete_grants_exactly_one', async () => {
  const directory = repo();
  const holder = await holdLock(directory, 'write');
  const contender = spawnLockChild(directory, 'write', 'probe');
  children.push(contender);

  const result = await waitForMessage(contender, (item) => item.type === 'result');

  assert.equal(result.ok, false);
  assert.equal(result.busy, true);
  assert.equal(existsSync(lockPath(directory, 'write')), true);
  await send(holder, { type: 'release' });
  const released = await waitForMessage(holder, (item) => item.type === 'released');
  assert.equal(released.released, true);
  await waitForExit(holder);
  await waitForExit(contender);
  assert.equal(existsSync(lockPath(directory, 'write')), false);
});

test('Test_Acquire_when_lock_is_held_stops_at_the_bounded_wait_budget', async () => {
  const directory = repo();
  const holder = await holdLock(directory, 'write');
  const delays = [];
  let elapsed = 0;
  const base = Date.now();

  const result = await acquire(directory, 'write', {
    waitMs: 80,
    now: () => base + elapsed,
    scheduler: {
      sleep: async (ms) => {
        delays.push(ms);
        elapsed += ms;
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.busy, true);
  assert.ok(delays.length >= 1, 'retries with a bounded backoff');
  assert.ok(delays.every((delay) => delay > 0 && delay <= 80));
  assert.ok(delays.reduce((sum, delay) => sum + delay, 0) <= 80);
  await send(holder, { type: 'release' });
  await waitForMessage(holder, (item) => item.type === 'released');
});

test('Test_Acquire_when_pid_is_dead_takes_over_the_stale_lock', async () => {
  const directory = repo();
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await waitForExit(dead);
  writeRawLock(directory, 'write', `${JSON.stringify({
    pid: dead.pid,
    startedAt: new Date().toISOString(),
    hostname: 'test-host',
    sessionId: 'dead-owner',
  })}\n`);

  const result = await acquire(directory, 'write', { waitMs: 0, sessionId: 'test-session' });

  assert.equal(result.ok, true);
  assert.equal(result.stolen, true);
  assert.equal(JSON.parse(readFileSync(result.path, 'utf8')).sessionId, 'test-session');
  await release(result);
});

test('Test_Acquire_when_lock_is_older_than_five_minutes_takes_over_even_if_pid_is_alive', async () => {
  const directory = repo();
  writeRawLock(directory, 'write', `${JSON.stringify({
    pid: process.pid,
    startedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
    hostname: 'test-host',
    sessionId: 'slow-owner',
  })}\n`);

  const result = await acquire(directory, 'write', { waitMs: 0, sessionId: 'test-session' });

  assert.equal(result.ok, true);
  assert.equal(result.stolen, true);
  await release(result);
});

test('Test_Acquire_when_kill_reports_EPERM_keeps_the_lock_busy', async () => {
  const directory = repo();
  const kill = () => {
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  };
  assert.equal(isPidAlive(424242, kill), true);
  writeRawLock(directory, 'write', `${JSON.stringify({
    pid: 424242,
    startedAt: new Date().toISOString(),
    hostname: 'test-host',
    sessionId: 'foreign-owner',
  })}\n`);

  const result = await acquire(directory, 'write', { waitMs: 0, kill });

  assert.equal(result.ok, false);
  assert.equal(result.busy, true);
});

test('Test_Acquire_when_a_fresh_lock_is_corrupt_reports_busy_instead_of_stealing', async () => {
  const directory = repo();
  writeRawLock(directory, 'write', 'not-json\n');

  const result = await acquire(directory, 'write', { waitMs: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.busy, true);
  assert.equal(readFileSync(lockPath(directory, 'write'), 'utf8'), 'not-json\n');
});

test('Test_Release_when_the_lock_was_replaced_does_not_remove_the_new_owner', async () => {
  const directory = repo();
  const held = await acquire(directory, 'write', { sessionId: 'first-owner' });
  assert.equal(held.ok, true);
  writeFileSync(held.path, `${JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: 'test-host',
    sessionId: 'replacement-owner',
  })}\n`);

  const released = await release(held);

  assert.equal(released, false);
  assert.equal(existsSync(held.path), true);
  rmSync(held.path);
});

test('Test_Acquire_when_sync_lock_is_held_does_not_block_the_write_lock', async () => {
  const directory = repo();
  const holder = await holdLock(directory, 'sync');

  const write = await acquire(directory, 'write', { waitMs: 0 });
  assert.equal(write.ok, true);
  await release(write);
  const sync = await acquire(directory, 'sync', { waitMs: 0 });
  assert.equal(sync.ok, false);
  assert.equal(sync.busy, true);

  await send(holder, { type: 'release' });
  await waitForMessage(holder, (item) => item.type === 'released');
});

test('Test_Acquire_when_sync_lock_is_busy_sets_the_rerun_flag', async () => {
  const directory = repo();
  const holder = await holdLock(directory, 'sync');

  const result = await acquire(directory, 'sync', { waitMs: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.busy, true);
  assert.equal(result.rerun, true);
  assert.equal(await hasRerunFlag(directory), true);
  await clearRerunFlag(directory);
  await send(holder, { type: 'release' });
  await waitForMessage(holder, (item) => item.type === 'released');
});

test('Test_LockFile_when_acquired_carries_pid_startedAt_hostname_and_sessionId', async () => {
  const directory = repo();
  const held = await acquire(directory, 'sync', { hostname: 'host-1', sessionId: 'sess-1' });
  const record = JSON.parse(readFileSync(held.path, 'utf8'));

  assert.deepEqual(Object.keys(record).sort(), ['hostname', 'pid', 'sessionId', 'startedAt']);
  assert.equal(record.pid, process.pid);
  assert.equal(record.hostname, 'host-1');
  assert.equal(record.sessionId, 'sess-1');
  assert.equal(Number.isNaN(Date.parse(record.startedAt)), false);
  await release(held);
});

test('Test_RerunFlag_when_set_is_visible_until_cleared', async () => {
  const directory = repo();
  assert.equal(await hasRerunFlag(directory), false);
  await setRerunFlag(directory);
  assert.equal(await hasRerunFlag(directory), true);
  assert.equal(await clearRerunFlag(directory), true);
  assert.equal(await hasRerunFlag(directory), false);
});
