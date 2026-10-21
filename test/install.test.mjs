import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, filesUnder } from '../scripts/build.mjs';
import { install, isEnvironmentAgentDir } from '../scripts/install.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALLER = join(ROOT, 'scripts', 'install.mjs');
const ENV_KEYS = ['SENPI_CODING_AGENT_DIR', 'OMO_CODING_AGENT_DIR'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
let tempDirs = [];

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'memento-install-'));
  tempDirs.push(directory);
  return directory;
}

function setEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function listing(directory) {
  return existsSync(directory) ? filesUnder(directory) : [];
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function currentOf(agentDir) {
  return JSON.parse(readFileSync(join(agentDir, 'memento', 'current.json'), 'utf8'));
}

afterEach(() => {
  for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
  tempDirs = [];
});

test('Test_Build_manifest_lists_a_sha256_for_every_current_source_and_cli_file', () => {
  const sourceBefore = filesUnder(join(ROOT, 'src')).map(file => `src/${file}`);
  const binBefore = filesUnder(join(ROOT, 'bin')).map(file => `bin/${file}`);

  const report = build();
  const manifest = JSON.parse(readFileSync(join(ROOT, 'dist', 'manifest.json'), 'utf8'));

  assert.equal(manifest.entry, 'src/extension.mjs');
  assert.equal(manifest.cli, 'bin/memento.mjs');
  assert.deepEqual(report.files.sort(), Object.keys(manifest.sha256).sort());
  for (const file of [...sourceBefore, ...binBefore]) {
    assert.match(manifest.sha256[file] ?? '', /^[0-9a-f]{64}$/, `missing sha256 for ${file}`);
    assert.equal(manifest.sha256[file], sha256(join(ROOT, 'dist', file)));
  }
});

test('Test_Install_into_a_fresh_agent_dir writes generation, current and a loadable shim', async () => {
  const agentDir = tempDir();
  const report = install({ agentDir });

  assert.equal(report.status, 'installed');
  assert.equal(report.generation, 'generation-000001');
  assert.equal(report.generation_path, join(agentDir, 'memento', 'integration', 'generation-000001'));

  const current = currentOf(agentDir);
  assert.equal(current.generation, 'generation-000001');
  assert.equal(Number.isNaN(Date.parse(current.installedAt)), false);
  const installed = filesUnder(report.generation_path);
  assert.deepEqual(Object.keys(current.files).sort(), installed);
  for (const file of installed) {
    assert.equal(current.files[file], sha256(join(report.generation_path, file)));
  }
  assert.equal(installed.includes('src/extension.mjs'), true);
  assert.equal(installed.includes('bin/memento.mjs'), true);
  assert.equal(installed.includes('package.json'), true);
  assert.equal(installed.includes('dist/manifest.json'), true);

  const shim = readFileSync(report.shim_path, 'utf8');
  assert.ok(shim.startsWith('// managed by omo-memento\n'));
  assert.ok(shim.includes("'../memento/integration/generation-000001/src/extension.mjs'"));
  const loaded = await import(pathToFileURL(report.shim_path).href);
  assert.equal(typeof loaded.default, 'function');
});

test('Test_Install_again_creates_a_new_generation_and_keeps_the_old_bytes', () => {
  const agentDir = tempDir();
  const first = install({ agentDir });
  const firstBytes = readFileSync(join(first.generation_path, 'src', 'extension.mjs'));

  const second = install({ agentDir });

  assert.equal(second.generation, 'generation-000002');
  assert.deepEqual(readFileSync(join(first.generation_path, 'src', 'extension.mjs')), firstBytes);
  assert.equal(currentOf(agentDir).generation, 'generation-000002');
  assert.ok(readFileSync(second.shim_path, 'utf8').includes('generation-000002/src/extension.mjs'));
});

test('Test_Install_when_agent_dir_is_the_environment_dir refuses before writing', () => {
  const live = tempDir();
  setEnv('SENPI_CODING_AGENT_DIR', live);

  assert.equal(isEnvironmentAgentDir(live), true);
  assert.equal(isEnvironmentAgentDir(live.replaceAll('/', '\\')), true);
  assert.equal(isEnvironmentAgentDir(`${live}/sub/..`), true);
  assert.throws(
    () => install({ agentDir: live }),
    error => error.code === 'live_agent_dir_refused' && error.exitCode === 2,
  );
  assert.deepEqual(listing(live), []);
});

test('Test_Install_when_agent_dir_has_settings refuses without live and leaves it untouched', () => {
  const agentDir = tempDir();
  writeFileSync(join(agentDir, 'settings.json'), '{}\n');
  const before = listing(agentDir);

  assert.throws(
    () => install({ agentDir }),
    error => error.code === 'configured_agent_dir_refused' && error.exitCode === 2,
  );
  assert.deepEqual(listing(agentDir), before);
});

test('Test_Install_with_live_flag_into_a_settings_dir is allowed', () => {
  const agentDir = tempDir();
  writeFileSync(join(agentDir, 'settings.json'), '{}\n');

  const report = install({ agentDir, live: true });

  assert.equal(report.status, 'installed');
  assert.equal(existsSync(report.shim_path), true);
  assert.equal(readFileSync(join(agentDir, 'settings.json'), 'utf8'), '{}\n');
});

test('Test_Uninstall_removes_only_the_shim_and_keeps_generations_and_current', () => {
  const agentDir = tempDir();
  const report = install({ agentDir });
  const currentPath = join(agentDir, 'memento', 'current.json');
  const currentBytes = readFileSync(currentPath);

  const removed = install({ agentDir, uninstall: true });

  assert.equal(removed.status, 'uninstalled');
  assert.deepEqual(removed.removed, [report.shim_path]);
  assert.equal(existsSync(report.shim_path), false);
  assert.equal(existsSync(currentPath), true);
  assert.deepEqual(readFileSync(currentPath), currentBytes);
  assert.equal(existsSync(report.generation_path), true);
  assert.deepEqual(install({ agentDir, uninstall: true }).removed, []);
});

test('Test_Install_and_uninstall_when_the_shim_is_foreign refuse and keep it', () => {
  const agentDir = tempDir();
  const shim = join(agentDir, 'extensions', 'omo-memento.js');
  mkdirSync(dirname(shim), { recursive: true });
  writeFileSync(shim, '// owned by someone else\n');

  for (const uninstall of [false, true]) {
    assert.throws(() => install({ agentDir, uninstall }), { code: 'foreign_shim' });
    assert.equal(readFileSync(shim, 'utf8'), '// owned by someone else\n');
  }
});

test('Test_Cli_when_arguments_are_invalid fails non-zero without writing', () => {
  const agentDir = tempDir();
  const missing = spawnSync(process.execPath, [INSTALLER], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--agent-dir/);

  const unknown = spawnSync(process.execPath, [INSTALLER, '--agent-dir', agentDir, '--frobnicate'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
  });
  assert.notEqual(unknown.status, 0);
  assert.deepEqual(listing(agentDir), []);
});

test('Test_Cli_when_agent_dir_has_settings refuses with exit 2 and no writes', () => {
  const agentDir = tempDir();
  writeFileSync(join(agentDir, 'settings.json'), '{}\n');
  const before = listing(agentDir);

  const result = spawnSync(process.execPath, [INSTALLER, '--agent-dir', agentDir], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /configured_agent_dir_refused/);
  assert.deepEqual(listing(agentDir), before);
});

test('Test_Installed_cli_help_runs_from_the_generation', () => {
  const agentDir = tempDir();
  const report = install({ agentDir });
  const cli = join(report.generation_path, 'bin', 'memento.mjs');

  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 60000 });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: memento/);
});
