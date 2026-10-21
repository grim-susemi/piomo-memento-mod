import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadConfig, resolveAgentDir } from '../src/config.mjs';

let tempDirs = [];

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'memento-config-'));
  tempDirs.push(directory);
  return directory;
}

function writeConfig(agentDir, body) {
  mkdirSync(join(agentDir, 'memento'), { recursive: true });
  writeFileSync(join(agentDir, 'memento', 'config.json'), body);
}

afterEach(() => {
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
  tempDirs = [];
});

test('Test_ResolveAgentDir_prefers_the_senpi_variable', () => {
  const senpi = tempDir();
  const omo = tempDir();
  assert.equal(resolveAgentDir({ SENPI_CODING_AGENT_DIR: senpi, OMO_CODING_AGENT_DIR: omo }), senpi);
  assert.equal(resolveAgentDir({ OMO_CODING_AGENT_DIR: omo }), omo);
});

test('Test_ResolveAgentDir_when_nothing_is_configured derives nothing from a checkout path', () => {
  const repoModule = pathToFileURL(join(process.cwd(), 'src', 'config.mjs')).href;
  assert.equal(resolveAgentDir({}, repoModule), '');
});

test('Test_ResolveAgentDir_when_loaded_from_an_installed_generation derives the agent dir', () => {
  const agentDir = tempDir();
  const generation = join(agentDir, 'memento', 'integration', 'generation-000002');
  mkdirSync(join(generation, 'src'), { recursive: true });
  const moduleUrl = pathToFileURL(join(generation, 'src', 'config.mjs')).href;
  assert.equal(resolveAgentDir({}, moduleUrl), agentDir);
});

test('Test_LoadConfig_when_the_file_is_missing is unconfigured and never throws', () => {
  const agentDir = tempDir();
  const config = loadConfig({ agentDir, env: {} });
  assert.equal(config.state, 'unconfigured');
  assert.equal(config.reason, 'config-missing');
  assert.equal(config.agentDir, agentDir);
  assert.equal(config.configPath, join(agentDir, 'memento', 'config.json'));
});

test('Test_LoadConfig_when_no_agent_dir_is_known is unconfigured', () => {
  const config = loadConfig({ env: {} });
  assert.equal(config.state, 'unconfigured');
  assert.equal(config.reason, 'agent-dir-unknown');
  assert.equal(config.agentDir, '');
});

test('Test_LoadConfig_when_json_is_invalid is unconfigured', () => {
  const agentDir = tempDir();
  writeConfig(agentDir, '{ not json');
  const config = loadConfig({ agentDir, env: {} });
  assert.equal(config.state, 'unconfigured');
  assert.equal(config.reason, 'config-invalid');
});

test('Test_LoadConfig_when_required_fields_are_missing is unconfigured', () => {
  const agentDir = tempDir();
  writeConfig(agentDir, JSON.stringify({ repoPath: 'C:/tmp/memento' }));
  const config = loadConfig({ agentDir, env: {} });
  assert.equal(config.state, 'unconfigured');
  assert.equal(config.reason, 'config-invalid');
});

test('Test_LoadConfig_when_the_path_is_a_directory reports unreadable without throwing', () => {
  const agentDir = tempDir();
  mkdirSync(join(agentDir, 'memento', 'config.json'), { recursive: true });
  const config = loadConfig({ agentDir, env: {} });
  assert.equal(config.state, 'unconfigured');
  assert.equal(config.reason, 'config-unreadable');
});

test('Test_LoadConfig_when_valid names the token file but never opens it', () => {
  const agentDir = tempDir();
  const tokenFile = join(agentDir, 'secrets', 'discord-bot-token');
  writeConfig(agentDir, JSON.stringify({ repoPath: 'C:/tmp/memento', tokenFile, remote: '' }));
  const config = loadConfig({ agentDir, env: {} });
  assert.equal(config.state, 'configured');
  assert.equal(config.repoPath, 'C:/tmp/memento');
  assert.equal(config.tokenFile, tokenFile);
  assert.equal(config.remote, null);
});
