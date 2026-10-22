// TASK13: prove the extension leaves no resident work and the Korean path
// survives card -> commit -> clone -> API state -> fake Discord -> readback.
//
// The resource proof joins the real in-flight sync promise before shutdown.
// The static proofs inspect every actual timer and request destination and run
// the reviewer's exact memory mutations against the same analyzers.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import extension, { REGISTRATION_KEY } from '../src/extension.mjs';
import { getSyncNow } from '../src/intake/capture.mjs';
import { createDiscordClient } from '../src/discord/client.mjs';
import { createVirtualClock, startFakeDiscord } from '../src/discord/fake-server.mjs';
import { initRepo } from '../src/store/init.mjs';
import { openStore } from '../src/store/store.mjs';
import { makeApiEnv } from './fixtures/api/harness.mjs';
import { timerOffenders } from './fixtures/no-background/timer-rules.mjs';
import { requestOffenders } from './fixtures/no-background/request-rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'memento.mjs');
const API_KEY = Symbol.for('omo.memento.api.v1');
const ROUNDTRIP_INPUT = join(ROOT, 'test', 'fixtures', 'roundtrip', 'korean-roundtrip.txt');
const WATCHED = ['Timeout', 'TCPSocketWrap', 'ChildProcess'];
const savedAgentDir = process.env.SENPI_CODING_AGENT_DIR;
const tempDirs = [];
const envs = [];

function tempDir(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function sourceFiles() {
  const paths = [join(ROOT, 'bin', 'memento.mjs')];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) paths.push(path);
    }
  };
  walk(join(ROOT, 'src'));
  return paths.sort().map((path) => ({
    path: relative(ROOT, path).replaceAll('\\', '/'),
    source: readFileSync(path, 'utf8'),
  }));
}

function mutated(files, path, suffix) {
  return files.map((file) => (file.path === path
    ? { ...file, source: `${file.source}\n${suffix}\n` }
    : file));
}

function replaced(files, path, from, to) {
  let changed = false;
  const next = files.map((file) => {
    if (file.path !== path || !file.source.includes(from)) return file;
    changed = true;
    return { ...file, source: file.source.replace(from, to) };
  });
  assert.equal(changed, true, `expected ${path} to contain ${from}`);
  return next;
}

function watchedResources() {
  const info = process.getActiveResourcesInfo();
  return Object.fromEntries(WATCHED.map((kind) => [kind, info.filter((entry) => entry === kind).length]));
}

function bounded(promise, label, ms = 10_000) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
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
    let settled = false;
    const done = (value, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { watcher?.close(); } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const check = () => {
      if (predicate(receiptText(path))) done(true);
    };
    watcher = watch(dirname(path), check);
    timer = setTimeout(() => done(false, new Error('timed out waiting for receipt')), ms);
    check();
  });
}

function createFakePi() {
  const handlers = new Map();
  const ctx = {
    hasUI: true,
    agentDir: '',
    sessionManager: {
      getSessionFile: () => 'owned/session.jsonl',
      getSessionId: () => 'task13-no-background',
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

function boundedChild(command, args, { timeoutMs = 10_000, cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const done = (value, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        try {
          if (process.platform === 'win32') {
            execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              stdio: 'ignore', windowsHide: true,
            });
          } else {
            child.kill('SIGKILL');
          }
        } catch {}
        reject(error);
        return;
      }
      resolve(value);
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => done(null, error));
    child.once('exit', (code, signal) => done({ code, signal, stdout, stderr }));
    timer = setTimeout(() => done(null, new Error(`child timed out after ${timeoutMs} ms`)), timeoutMs);
  });
}

function alivePids(pids) {
  if (process.platform !== 'win32' || pids.length === 0) return [];
  const list = pids.join(',');
  const script = `$ids=@(${list}); foreach($id in $ids){ $p=Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue; if($p){ Write-Output $p.ProcessId } }`;
  const output = execFileSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  return output.split(/\s+/).filter(Boolean).map(Number);
}

function firstCsvField(line) {
  if (!line.startsWith('"')) return line.split(',')[0];
  let out = '';
  for (let index = 1; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (line[index + 1] === '"') {
        out += '"';
        index += 1;
      } else {
        break;
      }
    } else {
      out += char;
    }
  }
  return out;
}

function scheduledTaskNames() {
  if (process.platform !== 'win32') return null;
  const output = execFileSync('schtasks', ['/query', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  return output.split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(firstCsvField)
    .filter((name) => name.length > 0)
    .sort();
}

let tasksBefore = null;
before(() => {
  tasksBefore = scheduledTaskNames();
});

after(async () => {
  const tasksAfter = scheduledTaskNames();
  if (tasksBefore !== null && tasksAfter !== null) {
    console.log(JSON.stringify({
      event: 'task13-schtasks',
      before: tasksBefore.length,
      after: tasksAfter.length,
      equal: JSON.stringify(tasksBefore) === JSON.stringify(tasksAfter),
    }));
    assert.deepEqual(tasksAfter, tasksBefore, 'scheduled task name set changed during the task-13 run');
  }
  if (savedAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
  else process.env.SENPI_CODING_AGENT_DIR = savedAgentDir;
  for (const env of envs.splice(0)) await env.close().catch(() => {});
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  delete globalThis[REGISTRATION_KEY];
  delete globalThis[API_KEY];
});

test('Test_Extension_lifecycle_joins_the_real_sync_promise_before_shutdown', async () => {
  const env = await makeApiEnv();
  envs.push(env);
  const agentDir = join(env.parent, 'agent-background');
  mkdirSync(join(agentDir, 'memento'), { recursive: true });
  mkdirSync(join(agentDir, 'logs'), { recursive: true });
  writeFileSync(join(agentDir, 'memento', 'config.json'), JSON.stringify({
    repoPath: env.repo,
    tokenFile: env.tokenFile,
    remote: null,
  }));
  process.env.SENPI_CODING_AGENT_DIR = agentDir;
  const fake = createFakePi();
  const beforeResources = watchedResources();
  const runtime = extension(fake.pi, { client: env.client });
  assert.ok(runtime);
  assert.equal(typeof runtime.whenSyncIdle, 'function');
  const receipt = join(agentDir, 'logs', 'memento.jsonl');
  const completed = waitForReceipt(receipt, (text) => /"event":"sync-complete"/.test(text), 10_000);
  try {
    await fire(fake, 'session_start', { reason: 'startup' }, fake.ctx);
    const inFlight = runtime.whenSyncIdle();
    assert.ok(inFlight && typeof inFlight.then === 'function', 'whenSyncIdle returns the real promise');
    const syncResult = await bounded(inFlight, 'in-flight sync promise', 10_000);
    assert.ok(syncResult && typeof syncResult === 'object', 'the joined value is the sync result');
    assert.ok(Number.isInteger(syncResult.runs) && syncResult.runs >= 1, 'the sync actually ran');
    await completed;
    await fire(fake, 'session_shutdown', {}, fake.ctx);
    assert.equal(globalThis[API_KEY], undefined, 'shutdown removes its own API');
    assert.equal(getSyncNow(), null, 'shutdown clears the sync callback');
  } finally {
    await env.close().catch(() => {});
  }
  await env.fake.waitForNoOpenSockets(2_000);
  const afterResources = watchedResources();
  console.log(JSON.stringify({
    event: 'task13-resources',
    joinedSyncPromise: true,
    before: beforeResources,
    after: afterResources,
    active: process.getActiveResourcesInfo().toSorted(),
  }));
  for (const kind of WATCHED) {
    assert.ok(afterResources[kind] <= beforeResources[kind],
      `${kind} was added: before ${beforeResources[kind]}, after ${afterResources[kind]}`);
  }
});

test('Test_Timers_have_a_per_call_finally_and_reject_the_reviewer_mutation', () => {
  const files = sourceFiles();
  const baseline = timerOffenders(files);
  assert.deepEqual(baseline, []);

  const deadClear = mutated(files, 'src/discord/client.mjs',
    'const leaked = setTimeout(() => {}, 60000); if (false) { clearTimeout(leaked); }');
  const deadOffenders = timerOffenders(deadClear);
  assert.equal(deadOffenders.some((entry) => entry.reason.includes('leaked')), true,
    JSON.stringify(deadOffenders));
  assert.equal(deadOffenders.some((entry) => entry.reason.includes('not cleared in a finally')), true,
    JSON.stringify(deadOffenders));

  const unrelated = mutated(files, 'src/api.mjs',
    'function unrelatedTimer(){const timer=setTimeout(()=>{},60000);return timer;}');
  const unrelatedOffenders = timerOffenders(unrelated);
  assert.equal(unrelatedOffenders.some((entry) => entry.path === 'src/api.mjs'
    && entry.reason.includes('timer')), true, JSON.stringify(unrelatedOffenders));

  const falseGuard = replaced(files, 'src/api.mjs',
    'if (timer) clearTimeout(timer);', 'if (false) clearTimeout(timer);');
  const falseOffenders = timerOffenders(falseGuard);
  assert.equal(falseOffenders.some((entry) => entry.path === 'src/api.mjs'
    && entry.reason.includes('timer')), true, JSON.stringify(falseOffenders));

  const sameClassGuard = replaced(files, 'src/api.mjs',
    'if (timer) clearTimeout(timer);', 'if (1 === 2) clearTimeout(timer);');
  const sameClassOffenders = timerOffenders(sameClassGuard);
  assert.equal(sameClassOffenders.some((entry) => entry.path === 'src/api.mjs'
    && entry.reason.includes('timer')), true, JSON.stringify(sameClassOffenders));

  const voidDelay = replaced(files, 'src/probe/probe.mjs', 'return delay(', 'void delay(');
  const voidOffenders = timerOffenders(voidDelay);
  assert.equal(voidOffenders.some((entry) => entry.path === 'src/probe/probe.mjs'
    && entry.reason.includes('promise timer')), true, JSON.stringify(voidOffenders));

  console.log(JSON.stringify({
    event: 'task13-timer-mutation',
    baseline: 0,
    deadClear: deadOffenders.length,
    unrelated: unrelatedOffenders.length,
    falseGuard: falseOffenders.length,
    sameClassGuard: sameClassOffenders.length,
    voidDelay: voidOffenders.length,
  }));
});

test('Test_Cli_sync_records_every_child_spawn_and_exit_and_leaves_none_alive', async () => {
  const parent = tempDir('memento-task13-pid-');
  const repo = join(parent, 'repo');
  const pidLog = join(parent, 'children.jsonl');
  const init = await initRepo({ dir: repo });
  assert.equal(init.ok, true);
  const fake = await startFakeDiscord({ clock: createVirtualClock({ start: Date.now() }) });
  let fakeClosed = false;
  try {
    const tokenFile = join(parent, 'discord-token');
    writeFileSync(tokenFile, `${fake.token}\n`);
    const client = createDiscordClient({ tokenFile, baseUrl: fake.baseUrl, clock: fake.clock });
    const forum = await client.createForumChannel({
      guildId: fake.ids.guildId,
      name: '메멘토',
      tags: ['메모'],
    });
    assert.equal(forum.ok, true);
    const store = openStore(repo);
    const current = await store.readSyncState();
    assert.equal(current.ok, true);
    const written = await store.writeSyncState({
      ...current.state,
      guildId: fake.ids.guildId,
      forumId: forum.data.id,
      tagIds: { idea: forum.data.available_tags[0].id },
      ownerUserId: fake.ids.ownerUserId,
      botUserId: fake.ids.botUserId,
      clock: { offsetMs: 0, rttMs: 0, dateSkewMs: 0, measuredAt: new Date(fake.clock.now()).toISOString() },
      audit: { lastEntryId: null, coveredSince: new Date(fake.clock.now() - 45 * 24 * 60 * 60 * 1_000).toISOString(), ingested: [] },
      bases: {},
      starterCursor: 0,
      nameSeen: {},
      quarantine: [],
    });
    assert.equal(written.ok, true);
    const created = await store.create({
      title: 'PID 시험',
      description: '자식 프로세스 기록 시험',
      original: '카드 원문',
      source: 'paste',
      sourceRef: 'task13:pid',
      via: 'paste',
      actor: 'owner',
    });
    assert.equal(created.ok, true);

    const run = await boundedChild(process.execPath, [
      CLI, 'sync', '--repo', repo, '--discord-base', fake.baseUrl, '--pid-log', pidLog,
    ], { timeoutMs: 10_000 });
    assert.equal(run.code, 0, `sync exited ${run.code}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.match(run.stdout, /sync:/);
    assert.equal(existsSync(pidLog), true);
    const events = readFileSync(pidLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const spawns = events.filter((entry) => entry.event === 'spawn');
    const exits = events.filter((entry) => entry.event === 'exit');
    assert.ok(spawns.length > 0, `expected at least one git child spawn, got ${JSON.stringify(events)}`);
    assert.equal(spawns.length, exits.length, 'every spawn has one exit');
    assert.equal(new Set(spawns.map((entry) => entry.pid)).size, spawns.length, 'spawn pids are unique');

    const byPid = new Map();
    for (const event of events) {
      if (!byPid.has(event.pid)) byPid.set(event.pid, []);
      byPid.get(event.pid).push(event);
    }
    let maxDurationMs = 0;
    for (const [pid, group] of byPid) {
      const spawn = group.filter((entry) => entry.event === 'spawn');
      const exit = group.filter((entry) => entry.event === 'exit');
      assert.equal(spawn.length, 1, `pid ${pid} has exactly one spawn`);
      assert.equal(exit.length, 1, `pid ${pid} has exactly one exit`);
      const duration = exit[0].at - spawn[0].at;
      assert.ok(Number.isFinite(duration) && duration >= 0 && duration <= 10_000,
        `pid ${pid} exit bound: ${duration} ms`);
      assert.ok(Number.isInteger(exit[0].code) || typeof exit[0].signal === 'string',
        `pid ${pid} has a terminal status`);
      maxDurationMs = Math.max(maxDurationMs, duration);
    }
    const alive = alivePids(spawns.map((entry) => entry.pid));
    console.log(JSON.stringify({
      event: 'task13-pids',
      spawns: spawns.length,
      exits: exits.length,
      maxDurationMs,
      pids: spawns.map((entry) => entry.pid),
      alive,
      requests: fake.requests.length,
    }));
    assert.deepEqual(alive, [], `child processes still alive: ${alive.join(',')}`);
  } finally {
    if (!fakeClosed) {
      fakeClosed = true;
      await fake.close();
    }
  }
});

test('Test_Production_request_sites_are_complete_and_reject_the_reviewer_mutation', async () => {
  const files = sourceFiles();
  const baseline = requestOffenders(files);
  assert.deepEqual(baseline.offenders, []);
  assert.equal(baseline.presentationLiteral?.status, 'approved-423A');
  assert.equal(baseline.presentationLiteral?.value,
    'https://discord.com/channels/${guildId}/${card.discordThread}');

  const direct = mutated(files, 'src/discord/client.mjs',
    'httpsRequest("https:" + "//example.invalid/");');
  const directOffenders = requestOffenders(direct).offenders;
  assert.equal(directOffenders.some((entry) => entry.reason.includes('unapproved request call httpsRequest')), true,
    JSON.stringify(directOffenders));

  const ternary = mutated(files, 'src/discord/client.mjs',
    '(secure ? httpsRequest : httpRequest)("https:" + "//example.invalid/");');
  const ternaryOffenders = requestOffenders(ternary).offenders;
  assert.equal(ternaryOffenders.some((entry) => entry.reason.includes('request first argument is not target')
    || entry.reason.includes('approved request call count')), true, JSON.stringify(ternaryOffenders));

  const targetMutation = replaced(files, 'src/discord/client.mjs',
    'target = new URL(url);',
    'target = new URL(url);\n        target.hostname = "example.invalid";');
  const targetOffenders = requestOffenders(targetMutation).offenders;
  assert.equal(targetOffenders.some((entry) => entry.reason.includes('target is written or read')), true,
    JSON.stringify(targetOffenders));

  const portMutation = replaced(files, 'src/discord/client.mjs',
    'target = new URL(url);',
    'target = new URL(url);\n        target.port = "443";');
  const portOffenders = requestOffenders(portMutation).offenders;
  assert.equal(portOffenders.some((entry) => entry.reason.includes('target is written or read')), true,
    JSON.stringify(portOffenders));

  const extraPresentation = mutated(files, 'src/discord/client.mjs',
    "const extra = 'https://discord.com/channels/1/2';");
  const extraPresentationOffenders = requestOffenders(extraPresentation).offenders;
  assert.equal(extraPresentationOffenders.some((entry) => entry.reason.includes('unapproved URL literal')), true,
    JSON.stringify(extraPresentationOffenders));

  const changedPresentation = replaced(files, 'src/api.mjs',
    'https://discord.com/channels/${guildId}/${card.discordThread}',
    'https://discord.com/channels/${guildId}/${card.discordThread}?x=1');
  const changedPresentationOffenders = requestOffenders(changedPresentation).offenders;
  assert.equal(changedPresentationOffenders.some((entry) => entry.reason.includes('unapproved URL literal')
    || entry.reason.includes('expected exactly one 423A')), true,
  JSON.stringify(changedPresentationOffenders));

  const fake = await startFakeDiscord();
  const tokenFile = join(tempDir('memento-task13-url-'), 'token');
  writeFileSync(tokenFile, `${fake.token}\n`);
  try {
    const client = createDiscordClient({ tokenFile, baseUrl: fake.baseUrl });
    const me = await client.getMe();
    assert.equal(me.ok, true);
    assert.equal(fake.requests.some((request) => request.path === '/users/@me' && request.authorized), true);
  } finally {
    await fake.close();
  }
  console.log(JSON.stringify({
    event: 'task13-request-mutation',
    baseline: 0,
    direct: directOffenders.length,
    ternary: ternaryOffenders.length,
    target: targetOffenders.length,
    port: portOffenders.length,
    extraPresentation: extraPresentationOffenders.length,
    changedPresentation: changedPresentationOffenders.length,
    presentationLiteral: baseline.presentationLiteral.status,
  }));
});

test('Test_Roundtrip_preserves_utf8_bytes_through_card_commit_clone_api_and_fake_discord', async () => {
  const { runRoundtrip } = await import('../src/doctor/roundtrip.mjs');
  const work = tempDir('memento-task13-roundtrip-');
  const result = await runRoundtrip({ workDir: work, inputFile: ROUNDTRIP_INPUT });
  console.log(JSON.stringify({ event: 'task13-roundtrip', ...result }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.bytesEqual, true);
  assert.equal(result.replacementChars, 0);
  assert.equal(result.cardBytesEqual, true);
  assert.equal(result.cloneBytesEqual, true);
  assert.equal(result.apiBytesEqual, true);
  assert.equal(result.discordBytesEqual, true);
});
