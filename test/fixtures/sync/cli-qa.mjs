import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiscordClient } from '../../../src/discord/client.mjs';
import { startFakeDiscord } from '../../../src/discord/fake-server.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const TOKEN = 'synthetic-cli-token-0123456789';
const summary = { schema: 'memento.task11.cli-qa.v1', ok: false };
const parent = mkdtempSync(join(tmpdir(), 'memento-cli-qa-'));
const fake = await startFakeDiscord({ token: TOKEN });
try {
  const repo = join(parent, 'repo');
  const bare = join(parent, 'remote.git');
  const agentDir = join(parent, 'agent');
  const tokenFile = join(parent, 'token');
  writeFileSync(tokenFile, `${TOKEN}\n`);
  spawnSync('git', ['init', '--bare', '--quiet', bare], { windowsHide: true, stdio: 'ignore' });

  const init = spawnSync(process.execPath, [join(ROOT, 'bin', 'memento.mjs'), 'init', repo, '--remote', bare], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, SENPI_CODING_AGENT_DIR: agentDir },
  });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(existsSync(join(repo, 'sync', 'state.json')), true);
  assert.equal(existsSync(join(repo, 'cards')), true);

  const forum = await createDiscordClient({
    tokenFile,
    baseUrl: fake.baseUrl,
    clock: fake.clock,
  }).createForumChannel({ guildId: fake.ids.guildId, name: '메멘토', tags: ['메모'] });
  assert.equal(forum.ok, true);

  mkdirSync(join(agentDir, 'memento'), { recursive: true });
  writeFileSync(join(agentDir, 'memento', 'config.json'), `${JSON.stringify({
    repoPath: repo, tokenFile, remote: bare,
  })}\n`);

  const doctor = await runCli([
    join(ROOT, 'bin', 'memento.mjs'), 'doctor', '--discord', '--base-url', fake.baseUrl,
  ], { ...process.env, SENPI_CODING_AGENT_DIR: agentDir });
  assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`);
  assert.match(doctor.stdout, /discord: ok/);
  assert.ok(!doctor.stdout.includes(TOKEN) && !doctor.stderr.includes(TOKEN));

  summary.ok = true;
  summary.init = { exit: init.status, hasState: true, hasCards: true };
  summary.doctor = { exit: doctor.status, lines: doctor.stdout.trim().split(/\r?\n/), tokenLeaked: false };
} catch (error) {
  summary.error = String(error?.stack ?? error);
} finally {
  await fake.close();
  const sockets = fake.openSockets.size;
  rmSync(parent, { recursive: true, force: true });
  summary.cleanup = { tempRemoved: !existsSync(parent), openSockets: sockets };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
}
