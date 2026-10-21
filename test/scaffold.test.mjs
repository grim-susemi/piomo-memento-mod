import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import extension, { isChildSessionFile, REGISTRATION_KEY, sessionIdentity } from '../src/extension.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const ENV_KEYS = ['SENPI_CODING_AGENT_DIR', 'OMO_CODING_AGENT_DIR', 'OMO_MEMENTO'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
let tempDirs = [];

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'memento-scaffold-'));
  tempDirs.push(directory);
  return directory;
}

function setEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function writeConfig(agentDir, config) {
  mkdirSync(join(agentDir, 'memento'), { recursive: true });
  writeFileSync(join(agentDir, 'memento', 'config.json'), `${JSON.stringify(config)}\n`);
}

function createFakePi({
  sessionKind = 'interactive', sessionFile = 'owned/session.jsonl', hasUI = true, agentDir = '',
} = {}) {
  const calls = { on: [], registerTool: [], registerCommand: [] };
  const handlers = new Map();
  const ctx = {
    hasUI,
    agentDir,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => 'fake-session',
    },
    ui: { notify() {} },
  };
  const pi = {
    sessionKind,
    on(name, handler) {
      calls.on.push([name, handler]);
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    registerTool(definition) { calls.registerTool.push(definition); },
    registerCommand(name, definition) { calls.registerCommand.push([name, definition]); },
  };
  return {
    pi,
    ctx,
    calls,
    handlers,
    async emit(name, event = {}, handlerCtx = ctx) {
      const results = [];
      for (const handler of handlers.get(name) ?? []) results.push(await handler(event, handlerCtx));
      return results;
    },
  };
}

beforeEach(() => {
  delete globalThis[REGISTRATION_KEY];
  setEnv('OMO_MEMENTO', undefined);
});

afterEach(() => {
  delete globalThis[REGISTRATION_KEY];
  for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
  tempDirs = [];
});

test('Test_Factory_when_session_kind_is_worker registers nothing', () => {
  const agentDir = tempDir();
  setEnv('SENPI_CODING_AGENT_DIR', agentDir);
  const fake = createFakePi({ sessionKind: 'worker' });

  const runtime = extension(fake.pi);

  assert.equal(runtime, undefined);
  assert.deepEqual(fake.calls.on, []);
  assert.deepEqual(fake.calls.registerTool, []);
  assert.deepEqual(fake.calls.registerCommand, []);
  assert.equal(globalThis[REGISTRATION_KEY], undefined);
  assert.equal(existsSync(join(agentDir, 'logs', 'memento.jsonl')), false);
});

test('Test_Factory_when_disabled_by_env writes one receipt and registers nothing', () => {
  const agentDir = tempDir();
  setEnv('SENPI_CODING_AGENT_DIR', agentDir);
  setEnv('OMO_MEMENTO', '0');
  const first = createFakePi({ agentDir });
  const second = createFakePi({ agentDir });

  assert.equal(extension(first.pi), undefined);
  assert.equal(extension(second.pi), undefined);

  assert.deepEqual(first.calls.on, []);
  assert.deepEqual(second.calls.on, []);
  assert.deepEqual(first.calls.registerTool, []);
  assert.deepEqual(first.calls.registerCommand, []);
  assert.equal(globalThis[REGISTRATION_KEY].runtime, null);
  const lines = readFileSync(join(agentDir, 'logs', 'memento.jsonl'), 'utf8').trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const receipt = JSON.parse(lines[0]);
  assert.equal(receipt.event, 'disabled-by-env');
  assert.equal(Number.isNaN(Date.parse(receipt.at)), false);
});

test('Test_Factory_when_loaded_twice returns the same runtime and registers once', () => {
  setEnv('SENPI_CODING_AGENT_DIR', tempDir());
  const fake = createFakePi();
  const other = createFakePi();

  const first = extension(fake.pi);
  const registrations = fake.calls.on.map(([name]) => name).sort();
  const second = extension(fake.pi);
  const third = extension(other.pi);

  assert.deepEqual(registrations, ['session_shutdown', 'session_start']);
  assert.equal(first, second);
  assert.equal(first, third);
  assert.equal(fake.calls.on.length, registrations.length);
  assert.deepEqual(other.calls.on, []);
  assert.deepEqual(fake.calls.registerTool, []);
  assert.deepEqual(fake.calls.registerCommand, []);
});

test('Test_Session_start_when_hasUI_is_false publishes nothing and releases its slot', async () => {
  setEnv('SENPI_CODING_AGENT_DIR', tempDir());
  const fake = createFakePi({ hasUI: false });

  const runtime = extension(fake.pi);
  await fake.emit('session_start', { reason: 'startup' });

  assert.equal(runtime.active, false);
  assert.equal(runtime.getSessionStatus(), 'child');
  assert.equal(runtime.config, null);
  assert.equal(globalThis[REGISTRATION_KEY].runtime, null);
  assert.deepEqual(fake.calls.registerTool, []);
  assert.deepEqual(fake.calls.registerCommand, []);
});

test('Test_Session_start_when_session_file_is_a_child_path publishes nothing', async () => {
  const root = tempDir();
  const childDirectory = join(root, 'senpi-task', 'children');
  mkdirSync(childDirectory, { recursive: true });
  const childFile = join(childDirectory, 'owned.jsonl');
  writeFileSync(childFile, '');
  // Windows paths are case-insensitive; the lexical gate must be too.
  const mixedCase = childFile.replace('senpi-task', 'SeNpI-TaSk').replace('children', 'ChIlDrEn');
  const fake = createFakePi({ sessionFile: mixedCase });
  setEnv('SENPI_CODING_AGENT_DIR', root);

  assert.equal(isChildSessionFile(mixedCase), true);
  assert.equal(sessionIdentity(fake.pi, fake.ctx), 'child');
  const runtime = extension(fake.pi);
  await fake.emit('session_start', { reason: 'startup' });

  assert.equal(runtime.active, false);
  assert.equal(globalThis[REGISTRATION_KEY].runtime, null);
});

test('Test_Session_start_when_session_file_getter_throws keeps the slot for the next event', async () => {
  setEnv('SENPI_CODING_AGENT_DIR', tempDir());
  const fake = createFakePi();
  fake.ctx.sessionManager.getSessionFile = () => { throw new Error('session unavailable'); };

  const runtime = extension(fake.pi);
  await fake.emit('session_start', { reason: 'startup' });

  assert.equal(runtime.getSessionStatus(), 'unknown');
  assert.equal(globalThis[REGISTRATION_KEY].runtime, runtime);
});

test('Test_Registration_when_a_stale_instance_shuts_down keeps the newer registration', async () => {
  setEnv('SENPI_CODING_AGENT_DIR', tempDir());
  const firstHost = createFakePi();
  const first = extension(firstHost.pi);

  const worker = createFakePi({ sessionKind: 'worker' });
  assert.equal(extension(worker.pi), undefined);
  assert.equal(globalThis[REGISTRATION_KEY].runtime, first);

  // The first host turns non-lead and releases its own slot...
  const hidden = { ...firstHost.ctx, hasUI: false };
  await firstHost.emit('session_start', { reason: 'startup' }, hidden);
  assert.equal(globalThis[REGISTRATION_KEY].runtime, null);

  // ...then a newer generation registers, and the stale shutdown must not clear it.
  const secondHost = createFakePi();
  const second = extension(secondHost.pi);
  assert.notEqual(second, first);
  await firstHost.emit('session_shutdown', {});

  assert.equal(globalThis[REGISTRATION_KEY].runtime, second);
  assert.equal(second.active, false);
});

test('Test_Session_start_when_lead loads config and reports unconfigured without throwing', async () => {
  const agentDir = tempDir();
  const fake = createFakePi({ agentDir, sessionFile: join(tempDir(), 'lead.jsonl') });

  const runtime = extension(fake.pi);
  assert.equal(runtime.getSessionStatus(), 'inactive');
  assert.equal(runtime.config, null);

  await fake.emit('session_start', { reason: 'new' });

  assert.equal(runtime.active, true);
  assert.equal(runtime.getSessionStatus(), 'lead');
  assert.equal(runtime.config.state, 'unconfigured');
  assert.equal(runtime.config.reason, 'config-missing');
});

test('Test_Session_start_when_config_exists reports configured fields', async () => {
  const agentDir = tempDir();
  writeConfig(agentDir, { repoPath: 'C:/tmp/memento', tokenFile: 'C:/tmp/token', remote: 'https://example.invalid/memento.git' });
  const fake = createFakePi({ agentDir, sessionFile: join(tempDir(), 'lead.jsonl') });

  const runtime = extension(fake.pi);
  await fake.emit('session_start', { reason: 'resume' });

  assert.equal(runtime.config.state, 'configured');
  assert.equal(runtime.config.repoPath, 'C:/tmp/memento');
  assert.equal(runtime.config.tokenFile, 'C:/tmp/token');
  assert.equal(runtime.config.remote, 'https://example.invalid/memento.git');
});

test('Test_Session_shutdown_when_current releases the registration for a reload', async () => {
  setEnv('SENPI_CODING_AGENT_DIR', tempDir());
  const fake = createFakePi();
  const first = extension(fake.pi);
  await fake.emit('session_start', { reason: 'startup' });
  assert.equal(globalThis[REGISTRATION_KEY].runtime, first);

  await fake.emit('session_shutdown', {});
  assert.equal(globalThis[REGISTRATION_KEY].runtime, null);
  assert.equal(first.getSessionStatus(), 'inactive');

  const reloaded = createFakePi();
  const next = extension(reloaded.pi);
  assert.notEqual(next, first);
  assert.equal(globalThis[REGISTRATION_KEY].runtime, next);
});

test('Test_Should_not_sync_when_reason_is_reload_or_fork', async () => {
  const { shouldSync } = await import('../src/extension.mjs');
  assert.equal(shouldSync('startup'), true);
  assert.equal(shouldSync('new'), true);
  assert.equal(shouldSync('resume'), true);
  assert.equal(shouldSync('reload'), false);
  assert.equal(shouldSync('fork'), false);
});

// The real codec is owned by a concurrent worker; this copy isolates the CLI's
// routing contract: dynamic import on --parse, `unreadable: <reason>` and exit 2.
test('Test_Doctor_parse_routes_to_the_codec_and_exits_2_when_unreadable', () => {
  const root = tempDir();
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'src', 'card'), { recursive: true });
  cpSync(join(ROOT, 'bin', 'memento.mjs'), join(root, 'bin', 'memento.mjs'));
  cpSync(join(ROOT, 'src', 'config.mjs'), join(root, 'src', 'config.mjs'));
  writeFileSync(join(root, 'src', 'card', 'codec.mjs'), [
    'export function parse(bytes) {',
    "  return Buffer.from(bytes).includes(0x80)",
    "    ? { unreadable: true, reason: 'utf8' }",
    "    : { card: { id: '20261021-aaaa', status: 'idea' } };",
    '}',
    '',
  ].join('\n'));
  const invalid = join(root, 'cp949.md');
  writeFileSync(invalid, Buffer.from([0x81, 0x80, 0x0a]));
  const valid = join(root, 'valid.md');
  writeFileSync(valid, 'ok\n');

  const bad = spawnSync(process.execPath, [join(root, 'bin', 'memento.mjs'), 'doctor', '--parse', invalid], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout.trim(), 'unreadable: utf8');

  const good = spawnSync(process.execPath, [join(root, 'bin', 'memento.mjs'), 'doctor', '--parse', valid], {
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(good.status, 0);
  assert.match(good.stdout, /card: 20261021-aaaa \(idea\)/);
});
