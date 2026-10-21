import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFakeDiscord } from '../src/discord/fake-server.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'memento.mjs');
const TOKEN = 'synthetic-discord-token-0123456789';
const fakes = [];
const tempDirs = [];

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'memento-cli-'));
  tempDirs.push(directory);
  return directory;
}

function writeAgentConfig(agentDir) {
  const tokenFile = join(agentDir, 'discord-token');
  writeFileSync(tokenFile, `${TOKEN}\n`);
  mkdirSync(join(agentDir, 'memento'), { recursive: true });
  writeFileSync(join(agentDir, 'memento', 'config.json'), `${JSON.stringify({
    repoPath: join(agentDir, 'repo'), tokenFile, remote: null,
  })}\n`);
  return { tokenFile };
}

function runCli(args, agentDir) {
  const env = { ...process.env, SENPI_CODING_AGENT_DIR: agentDir };
  delete env.OMO_CODING_AGENT_DIR;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('cli timed out'));
    }, 30_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, pid: child.pid });
    });
  });
}

afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('Test_Doctor_discord_when_fake_returns_401 prints forbidden and exits 1', async () => {
  const fake = await startFakeDiscord({ token: TOKEN });
  fakes.push(fake);
  fake.hooks.forceStatus({
    method: 'GET', path: '/users/@me', status: 401, body: { message: '401: Unauthorized', code: 0 },
  });
  const agentDir = tempDir();
  writeAgentConfig(agentDir);

  const result = await runCli(['doctor', '--discord', '--base-url', fake.baseUrl], agentDir);

  assert.equal(result.status, 1, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
  assert.equal(result.stdout.trim(), 'discord: forbidden (401)');
  assert.equal(result.stderr.trim(), '');
  assert.equal(result.stdout.includes(TOKEN), false);
  assert.equal(result.stderr.includes(TOKEN), false);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].path, '/users/@me');
  assert.equal(fake.requests[0].authorized, true);
});

test('Test_Doctor_discord_when_authorized prints ok and exits 0', async () => {
  const fake = await startFakeDiscord({ token: TOKEN });
  fakes.push(fake);
  const agentDir = tempDir();
  writeAgentConfig(agentDir);

  const result = await runCli(['doctor', '--discord', '--base-url', fake.baseUrl], agentDir);

  assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
  assert.match(result.stdout.trim(), /^discord: ok \(memento-bot \d+\)$/);
  assert.equal(result.stdout.includes(TOKEN), false);
  assert.equal(fake.requests.length, 1);
});

test('Test_Doctor_discord_when_config_is_missing exits 2 without network', async () => {
  const fake = await startFakeDiscord({ token: TOKEN });
  fakes.push(fake);
  const agentDir = tempDir();

  const result = await runCli(['doctor', '--discord', '--base-url', fake.baseUrl], agentDir);

  assert.equal(result.status, 2);
  assert.equal(result.stdout.trim(), 'discord: unconfigured (config-missing)');
  assert.equal(fake.requests.length, 0);
});

test('Test_Help_still_lists_parse_discord_and_base_url', async () => {
  const result = await runCli(['--help'], tempDir());

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--parse/);
  assert.match(result.stdout, /--discord/);
  assert.match(result.stdout, /--base-url/);
});
