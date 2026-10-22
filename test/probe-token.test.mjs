import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFakeDiscord } from '../src/discord/fake-server.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'src', 'probe', 'token-move.mjs');
const TOKEN = 'synthetic-discord-token-0123456789';
const fakes = [];
const tempDirs = [];

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'memento-probe-token-'));
  tempDirs.push(directory);
  return directory;
}

function writeEnv(directory, body) {
  const file = join(directory, 'hermes.env');
  writeFileSync(file, body);
  return file;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function runCli(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('token-move cli timed out'));
    }, 30_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, pid: child.pid });
    });
  });
}

afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('Test_MoveToken_when_single_matching_key saves the stripped token unchanged', async () => {
  const fake = await startFakeDiscord({ token: TOKEN });
  fakes.push(fake);
  const directory = tempDir();
  const envBody = [
    'KIMI_API_KEY=sk-synthetic',
    'DISCORD_BOT_TOKEN = " synthetic-discord-token-0123456789 "',
    'GLM_API_KEY=glm-synthetic',
  ].join('\r\n');
  const envPath = writeEnv(directory, envBody);
  const envBefore = readFileSync(envPath);
  const tokenFile = join(directory, 'secrets', 'discord-bot-token');
  const { moveToken } = await import('../src/probe/token-move.mjs');

  const result = await moveToken({ envPath, tokenFile, baseUrl: fake.baseUrl });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.key, 'DISCORD_BOT_TOKEN');
  assert.equal(result.length, TOKEN.length);
  assert.equal(result.sha256First8, sha256(TOKEN).slice(0, 8));
  assert.equal(result.envUnchanged, true);
  assert.equal(result.envSha256Before, sha256(envBefore));
  assert.equal(result.envSha256After, result.envSha256Before);
  assert.equal(readFileSync(tokenFile, 'utf8'), TOKEN);
  assert.equal(readFileSync(tokenFile).includes(Buffer.from('\n')), false);
  assert.equal(readFileSync(tokenFile).includes(Buffer.from('\r')), false);
  assert.equal(readFileSync(envPath).equals(envBefore), true);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].path, '/users/@me');
  assert.equal(fake.requests[0].authorized, true);
});

test('Test_MoveToken_when_zero_matching_keys reports key names and writes nothing', async () => {
  const directory = tempDir();
  const envPath = writeEnv(directory, 'KIMI_API_KEY=sk-synthetic\nGLM_API_KEY=glm-synthetic\n');
  const tokenFile = join(directory, 'secrets', 'discord-bot-token');
  const { moveToken } = await import('../src/probe/token-move.mjs');

  const result = await moveToken({ envPath, tokenFile, baseUrl: 'http://127.0.0.1:1/api/v10' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-token-key');
  assert.deepEqual(result.keyNames, ['KIMI_API_KEY', 'GLM_API_KEY']);
  assert.equal(existsSync(tokenFile), false);
  assert.equal(JSON.stringify(result).includes('sk-synthetic'), false);
});

test('Test_MoveToken_when_several_matching_keys reports key names and writes nothing', async () => {
  const directory = tempDir();
  const envPath = writeEnv(directory, [
    'DISCORD_BOT_TOKEN=synthetic-one',
    'GATEWAY_BOT_TOKEN=synthetic-two',
  ].join('\n'));
  const tokenFile = join(directory, 'secrets', 'discord-bot-token');
  const { moveToken } = await import('../src/probe/token-move.mjs');

  const result = await moveToken({ envPath, tokenFile, baseUrl: 'http://127.0.0.1:1/api/v10' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'multiple-token-keys');
  assert.deepEqual(result.keyNames, ['DISCORD_BOT_TOKEN', 'GATEWAY_BOT_TOKEN']);
  assert.equal(existsSync(tokenFile), false);
  assert.equal(JSON.stringify(result).includes('synthetic-one'), false);
});

test('Test_MoveToken_when_getMe_rejects does not save the token and keeps the env bytes', async () => {
  const fake = await startFakeDiscord({ token: TOKEN });
  fakes.push(fake);
  const directory = tempDir();
  const envPath = writeEnv(directory, 'DISCORD_BOT_TOKEN=synthetic-wrong-token\n');
  const envBefore = readFileSync(envPath);
  const tokenFile = join(directory, 'secrets', 'discord-bot-token');
  const { moveToken } = await import('../src/probe/token-move.mjs');

  const result = await moveToken({ envPath, tokenFile, baseUrl: fake.baseUrl });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'forbidden');
  assert.equal(result.status, 401);
  assert.equal(existsSync(tokenFile), false);
  assert.equal(readFileSync(envPath).equals(envBefore), true);
  assert.equal(JSON.stringify(result).includes('synthetic-wrong-token'), false);
  assert.equal(fake.requests.length, 1);
});

test('Test_MoveToken_when_token_file_already_holds_the_same_token reuses it', async () => {
  const fake = await startFakeDiscord({ token: TOKEN });
  fakes.push(fake);
  const directory = tempDir();
  const envPath = writeEnv(directory, 'DISCORD_BOT_TOKEN="synthetic-discord-token-0123456789"\n');
  const tokenFile = join(directory, 'secrets', 'discord-bot-token');
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, TOKEN);
  const { moveToken } = await import('../src/probe/token-move.mjs');

  const result = await moveToken({ envPath, tokenFile, baseUrl: fake.baseUrl });

  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.wrote, false);
  assert.equal(readFileSync(tokenFile, 'utf8'), TOKEN);
});

test('Test_MoveToken_when_token_file_differs refuses to overwrite', async () => {
  const fake = await startFakeDiscord({ token: TOKEN });
  fakes.push(fake);
  const directory = tempDir();
  const envPath = writeEnv(directory, 'DISCORD_BOT_TOKEN="synthetic-discord-token-0123456789"\n');
  const tokenFile = join(directory, 'secrets', 'discord-bot-token');
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, 'a-different-secret');
  const { moveToken } = await import('../src/probe/token-move.mjs');

  const result = await moveToken({ envPath, tokenFile, baseUrl: fake.baseUrl });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'token-file-differs');
  assert.equal(readFileSync(tokenFile, 'utf8'), 'a-different-secret');
});

test('Test_TokenMoveCli_prints_only_safe_fields_and_never_the_token', async () => {
  const fake = await startFakeDiscord({ token: TOKEN });
  fakes.push(fake);
  const directory = tempDir();
  const envPath = writeEnv(directory, 'DISCORD_BOT_TOKEN="synthetic-discord-token-0123456789"\n');
  const tokenFile = join(directory, 'secrets', 'discord-bot-token');
  const receipt = join(directory, 'token-move-receipt.json');

  const result = await runCli([
    '--env', envPath, '--token-file', tokenFile,
    '--base-url', fake.baseUrl, '--receipt', receipt,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(TOKEN), false);
  assert.equal(result.stderr.includes(TOKEN), false);
  const printed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(printed).sort(), ['key', 'length', 'sha256First8']);
  assert.equal(printed.key, 'DISCORD_BOT_TOKEN');
  assert.equal(readFileSync(tokenFile, 'utf8'), TOKEN);
  const recorded = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.equal(recorded.envUnchanged, true);
  assert.equal(recorded.envSha256Before, recorded.envSha256After);
  assert.equal(JSON.stringify(recorded).includes(TOKEN), false);
});

test('Test_TokenMoveCli_when_forbidden exits non-zero without the token', async () => {
  const fake = await startFakeDiscord({ token: TOKEN });
  fakes.push(fake);
  const directory = tempDir();
  const envPath = writeEnv(directory, 'DISCORD_BOT_TOKEN=synthetic-wrong-token\n');
  const tokenFile = join(directory, 'secrets', 'discord-bot-token');

  const result = await runCli([
    '--env', envPath, '--token-file', tokenFile, '--base-url', fake.baseUrl,
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), 'token: forbidden (401)');
  assert.equal(result.stdout.includes('synthetic-wrong-token'), false);
  assert.equal(result.stderr.includes('synthetic-wrong-token'), false);
  assert.equal(existsSync(tokenFile), false);
});
