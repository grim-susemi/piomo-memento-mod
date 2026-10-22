import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDiscordClient } from '../src/discord/client.mjs';
import { startFakeDiscord } from '../src/discord/fake-server.mjs';

const TOKEN = 'synthetic-discord-token-0123456789';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GUILD_NAME = '수세미 서버';
const FORUM_NAME = '메멘토';
const TAGS = ['메모', '조사중', '계획됨', '구현중', '완료', '보류', '폐기'];
const PROBE_TITLE = '[probe] 한글 왕복 확인 ㅋㅋㅋ 👍';
const OWNER_TITLE = '[시험] 소유자 글';
const ALL_PERMISSIONS = (1n << 10n) | (1n << 16n) | (1n << 11n) | (1n << 38n)
  | (1n << 34n) | (1n << 7n) | (1n << 4n);
const RUNTIME_PERMISSIONS = ALL_PERMISSIONS & ~(1n << 4n);

const fakes = [];
const tempDirs = [];

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'bin', 'memento.mjs'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('probe cli timed out'));
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

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'memento-probe-'));
  tempDirs.push(directory);
  return directory;
}

async function setupProbe({
  applicationFlags = 1 << 18,
  permissions = ALL_PERMISSIONS,
  guildName = GUILD_NAME,
} = {}) {
  const fake = await startFakeDiscord({ token: TOKEN, applicationFlags });
  fakes.push(fake);
  fake.state.guild.name = guildName;
  fake.state.guilds[0].name = guildName;
  fake.state.roles = [{
    id: fake.ids.guildId, name: '@everyone', permissions: permissions.toString(),
    position: 0, managed: false,
  }];
  const directory = tempDir();
  const tokenFile = join(directory, 'discord-token');
  writeFileSync(tokenFile, TOKEN);
  const outDir = join(directory, 'out');
  const client = createDiscordClient({
    tokenFile, baseUrl: fake.baseUrl, clock: fake.clock,
  });
  return { fake, directory, tokenFile, outDir, client };
}

function probeArgs(context, extra = {}) {
  const { fake, directory, tokenFile, outDir, client } = context;
  return {
    client,
    outDir,
    tokenFile,
    agentDir: directory,
    repoPath: join(directory, 'memento-repo'),
    guildName: GUILD_NAME,
    phase: 'setup',
    now: fake.clock.now,
    sleep: fake.clock.sleep,
    uuid: () => 'probe-uuid-0001',
    auditReads: 3,
    auditIntervalMs: 20_000,
    ...extra,
  };
}

async function runProbe(args) {
  const { runProbe: probe } = await import('../src/probe/probe.mjs');
  return probe(args);
}

function forums(fake) {
  return [...fake.state.channels.values()].filter(channel => channel.type === 15);
}

function threads(fake) {
  return [...fake.state.channels.values()].filter(channel => channel.type === 11);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function allFileText(root) {
  const found = [];
  const visit = directory => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const info = statSync(path);
      if (info.isDirectory()) visit(path);
      else found.push(readFileSync(path, 'utf8'));
    }
  };
  visit(root);
  return found.join('\n');
}

afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('Test_Probe_setup_when_approved creates one private forum with seven tags and stops at the owner boundary', async () => {
  const context = await setupProbe();
  const { fake, outDir } = context;

  const result = await runProbe(probeArgs(context));

  assert.equal(result.code, 4, JSON.stringify(result));
  assert.equal(result.phase, 'awaiting-owner');
  assert.equal(existsSync(join(outDir, 'probe-state.json')), true);
  assert.equal(existsSync(join(outDir, 'probe-partial.json')), true);
  assert.equal(existsSync(join(outDir, 'owner-action.md')), true);
  assert.equal(existsSync(join(outDir, 'probe.json')), false);

  const state = readJson(join(outDir, 'probe-state.json'));
  const partial = readJson(join(outDir, 'probe-partial.json'));
  assert.equal(state.phase, 'awaiting-owner');
  assert.equal(typeof state.forumId, 'string');
  assert.equal(typeof state.probePostId, 'string');
  assert.equal(Object.keys(state.tagIds).length, 7);
  assert.deepEqual(Object.keys(state.tagIds).sort(), ['building', 'done', 'dropped', 'held', 'idea', 'planned', 'researching']);

  assert.equal(partial.intent, true);
  assert.equal(partial.forumPrivate, true);
  assert.equal(partial.permissions.viewChannel, true);
  assert.equal(partial.permissions.readMessageHistory, true);
  assert.equal(partial.permissions.sendMessages, true);
  assert.equal(partial.permissions.sendMessagesInThreads, true);
  assert.equal(partial.permissions.manageThreads, true);
  assert.equal(partial.permissions.viewAuditLog, true);
  assert.equal(partial.permissions.manageChannels, true);
  assert.equal(partial.auditHasAppliedTags, true);
  assert.equal(partial.reasonEchoed, true);
  assert.equal(partial.koreanRoundTrip, true);
  assert.equal(partial.archivedListed, true);
  assert.equal(partial.archivedPatchPlain, false);
  assert.equal(partial.archivedPatchPlainCode, 50083);
  assert.equal(partial.archivedPatchUnarchive, true);
  assert.equal(partial.clockOffsetMs, 0);
  assert.equal(partial.rttMs, 0);

  const forumList = forums(fake);
  assert.equal(forumList.length, 1);
  const forum = forumList[0];
  assert.equal(forum.name, FORUM_NAME);
  assert.deepEqual(forum.available_tags.map(tag => tag.name), TAGS);
  assert.equal(forum.default_auto_archive_duration, 10080);
  const everyone = forum.permission_overwrites.find(entry => entry.id === fake.ids.guildId);
  const bot = forum.permission_overwrites.find(entry => entry.id === fake.ids.botUserId);
  assert.ok((BigInt(everyone.deny) & 1024n) === 1024n);
  assert.equal((BigInt(everyone.allow) & 1024n) === 0n, true);
  assert.ok((BigInt(bot.allow) & 1024n) === 1024n);

  const postList = threads(fake);
  assert.equal(postList.length, 1);
  const post = postList[0];
  assert.equal(post.name, PROBE_TITLE);
  assert.equal(post.thread_metadata.archived, false);
  assert.equal(post.parent_id, forum.id);
  assert.equal(fake.state.audit.filter(entry => entry.action_type === 110).length, 1);

  const ownerAction = readFileSync(join(outDir, 'owner-action.md'), 'utf8');
  assert.match(ownerAction, /\[시험\] 소유자 글/);
  assert.match(ownerAction, /\[probe\] 한글 왕복 확인/);
  assert.match(ownerAction, /메멘토/);
  assert.match(ownerAction, /계획됨/);
  assert.match(ownerAction, /완료/);

  assert.equal(allFileText(outDir).includes(TOKEN), false);
});

test('Test_Probe_setup_when_rerun reuses the forum and probe post without duplicates', async () => {
  const context = await setupProbe();
  const { fake, outDir } = context;
  await runProbe(probeArgs(context));
  const firstState = readJson(join(outDir, 'probe-state.json'));

  const second = await runProbe(probeArgs(context, { phase: 'setup' }));

  assert.equal(second.code, 4, JSON.stringify(second));
  assert.equal(forums(fake).length, 1);
  assert.equal(threads(fake).length, 1);
  assert.equal(fake.state.audit.filter(entry => entry.action_type === 110).length, 1);
  const secondState = readJson(join(outDir, 'probe-state.json'));
  assert.equal(secondState.forumId, firstState.forumId);
  assert.equal(secondState.probePostId, firstState.probePostId);
});

test('Test_Probe_setup_when_state_file_is_lost adopts the existing forum and marker post', async () => {
  const context = await setupProbe();
  const { fake, outDir } = context;
  await runProbe(probeArgs(context));
  const before = readJson(join(outDir, 'probe-state.json'));
  rmSync(join(outDir, 'probe-state.json'));

  const second = await runProbe(probeArgs(context, { phase: 'setup' }));

  assert.equal(second.code, 4, JSON.stringify(second));
  assert.equal(forums(fake).length, 1);
  assert.equal(threads(fake).length, 1);
  assert.equal(fake.state.audit.filter(entry => entry.action_type === 110).length, 1);
  const after = readJson(join(outDir, 'probe-state.json'));
  assert.equal(after.forumId, before.forumId);
  assert.equal(after.probePostId, before.probePostId);
});

test('Test_Probe_owner_phase_when_owner_acted patches the owner post, deletes both posts and completes', async () => {
  const context = await setupProbe();
  const { fake, outDir, directory, tokenFile } = context;
  await runProbe(probeArgs(context));
  const state = readJson(join(outDir, 'probe-state.json'));

  const ownerPost = fake.hooks.seedThread({
    forumId: state.forumId,
    name: OWNER_TITLE,
    ownerId: fake.ids.ownerUserId,
    appliedTags: [state.tagIds.idea],
    content: '소유자 시험 글 ㅋㅋㅋ 👍',
  });
  fake.hooks.ownerSetTags({ threadId: ownerPost.id, appliedTags: [state.tagIds.planned] });
  fake.hooks.ownerSetTags({ threadId: state.probePostId, appliedTags: [state.tagIds.done] });

  const result = await runProbe(probeArgs(context, { phase: 'owner' }));

  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(existsSync(join(outDir, 'probe.json')), true);
  const probeJson = readJson(join(outDir, 'probe.json'));
  assert.equal(probeJson.complete, true);
  assert.equal(probeJson.ownerAuditSeen, true);
  assert.equal(probeJson.ownerAuditHasAppliedTags, true);
  assert.equal(probeJson.ownerProbeAuditSeen, true);
  assert.equal(probeJson.ownerAuditDelayMs, 0);
  assert.equal(probeJson.botPatchOwnerPost, true);
  assert.equal(probeJson.deleteObserved, true);
  assert.equal(probeJson.deleteAuditSeen, true);
  assert.equal(probeJson.archivedPatchUnarchive, true);
  assert.equal(probeJson.forumPrivate, true);

  assert.equal(fake.state.channels.has(ownerPost.id), false);
  assert.equal(fake.state.channels.has(state.probePostId), false);
  assert.equal(fake.state.audit.filter(entry => entry.action_type === 112).length >= 2, true);
  const ownerPatch = fake.requests.find(request => request.method === 'PATCH'
    && request.path === `/channels/${ownerPost.id}`);
  assert.ok(ownerPatch);
  assert.equal(ownerPatch.body.applied_tags.some(tag => tag !== state.tagIds.planned), true);

  const config = readJson(join(directory, 'memento', 'config.json'));
  assert.deepEqual(config, {
    repoPath: join(directory, 'memento-repo'), tokenFile, remote: null,
  });
  assert.equal(allFileText(outDir).includes(TOKEN), false);
});

test('Test_Probe_owner_phase_when_audit_is_delayed uses the bounded reads and records the delay', async () => {
  const context = await setupProbe();
  const { fake, outDir } = context;
  await runProbe(probeArgs(context));
  const state = readJson(join(outDir, 'probe-state.json'));

  const ownerPost = fake.hooks.seedThread({
    forumId: state.forumId, name: OWNER_TITLE, ownerId: fake.ids.ownerUserId,
    appliedTags: [state.tagIds.idea], content: '소유자 시험 글',
  });
  fake.hooks.delayAuditVisibility();
  fake.hooks.ownerSetTags({ threadId: ownerPost.id, appliedTags: [state.tagIds.planned] });
  fake.hooks.ownerSetTags({ threadId: state.probePostId, appliedTags: [state.tagIds.done] });

  const sleep = async ms => {
    fake.hooks.releaseAuditVisibility();
    fake.clock.advance(ms);
  };
  const result = await runProbe(probeArgs(context, { phase: 'owner', sleep }));

  assert.equal(result.code, 0, JSON.stringify(result));
  const probeJson = readJson(join(outDir, 'probe.json'));
  assert.equal(probeJson.ownerAuditSeen, true);
  assert.equal(probeJson.ownerAuditDelayMs, 20_000);
});

test('Test_Probe_setup_when_bot_audit_lacks_applied_tags stops and cleans up the probe post', async () => {
  const context = await setupProbe();
  const { fake, outDir, client } = context;
  let auditReads = 0;
  const wrapped = {
    ...client,
    getAuditLog: async (params, options) => {
      const result = await client.getAuditLog(params, options);
      if (params.actionType === 111 && result.ok) {
        auditReads += 1;
        if (auditReads >= 2) {
          for (const entry of result.data) {
            if (typeof entry.reason === 'string' && entry.reason.startsWith('memento-probe ')) {
              entry.changes = [{ key: 'archived', old_value: false, new_value: true }];
            }
          }
        }
      }
      return result;
    },
  };

  const result = await runProbe(probeArgs(context, { client: wrapped }));

  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.reason, 'audit-without-applied-tags');
  assert.equal(existsSync(join(outDir, 'probe.json')), false);
  const partial = readJson(join(outDir, 'probe-partial.json'));
  assert.equal(partial.auditHasAppliedTags, false);
  assert.equal(threads(fake).length, 0);
});

test('Test_Probe_owner_phase_when_owner_audit_lacks_applied_tags stops without completing', async () => {
  const context = await setupProbe();
  const { fake, outDir } = context;
  await runProbe(probeArgs(context));
  const state = readJson(join(outDir, 'probe-state.json'));
  const ownerPost = fake.hooks.seedThread({
    forumId: state.forumId, name: OWNER_TITLE, ownerId: fake.ids.ownerUserId,
    appliedTags: [state.tagIds.idea], content: '소유자 시험 글',
  });
  const entry = fake.hooks.ownerSetTags({
    threadId: ownerPost.id, appliedTags: [state.tagIds.planned],
  });
  fake.hooks.ownerSetTags({ threadId: state.probePostId, appliedTags: [state.tagIds.done] });
  entry.changes = [{ key: 'archived', old_value: false, new_value: true }];

  const result = await runProbe(probeArgs(context, { phase: 'owner' }));

  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.reason, 'owner-audit-without-applied-tags');
  assert.equal(existsSync(join(outDir, 'probe.json')), false);
  const partial = readJson(join(outDir, 'probe-partial.json'));
  assert.equal(partial.ownerAuditHasAppliedTags, false);
  assert.equal(fake.state.channels.has(ownerPost.id), false);
  assert.equal(fake.state.channels.has(state.probePostId), false);
});

test('Test_Probe_setup_when_a_runtime_permission_is_missing stops before any channel write', async () => {
  const context = await setupProbe({ permissions: RUNTIME_PERMISSIONS & ~(1n << 34n) });
  const { fake, outDir } = context;

  const result = await runProbe(probeArgs(context));

  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.reason, 'missing-permissions');
  assert.equal(existsSync(join(outDir, 'probe.json')), false);
  assert.equal(fake.requests.some(request => request.method === 'POST'
    && request.path === `/guilds/${fake.ids.guildId}/channels`), false);
  const partial = readJson(join(outDir, 'probe-partial.json'));
  assert.equal(partial.permissions.manageThreads, false);
});

test('Test_Probe_setup_when_message_content_intent_is_off stops before any channel write', async () => {
  const context = await setupProbe({ applicationFlags: 0 });
  const { fake, outDir } = context;

  const result = await runProbe(probeArgs(context));

  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.reason, 'message-content-intent-off');
  assert.equal(fake.requests.some(request => request.method === 'POST'
    && request.path === `/guilds/${fake.ids.guildId}/channels`), false);
  assert.equal(existsSync(join(outDir, 'probe.json')), false);
});

test('Test_Probe_setup_when_manage_channels_is_missing_without_a_forum asks the owner to create it', async () => {
  const context = await setupProbe({ permissions: RUNTIME_PERMISSIONS });
  const { fake, outDir } = context;

  const result = await runProbe(probeArgs(context));

  assert.equal(result.code, 4, JSON.stringify(result));
  assert.equal(result.reason, 'forum-create-requires-manage-channels');
  assert.equal(fake.requests.some(request => request.method === 'POST'
    && request.path === `/guilds/${fake.ids.guildId}/channels`), false);
  assert.equal(existsSync(join(outDir, 'owner-create-forum.md')), true);
  const instruction = readFileSync(join(outDir, 'owner-create-forum.md'), 'utf8');
  assert.match(instruction, /메멘토/);
  assert.match(instruction, /메모/);
});

test('Test_Probe_setup_when_the_forum_is_not_private stops', async () => {
  const context = await setupProbe();
  const { fake, outDir, client } = context;
  const created = await client.createForumChannel({
    guildId: fake.ids.guildId, name: FORUM_NAME, tags: TAGS, permissionOverwrites: [],
  });
  assert.equal(created.ok, true);

  const result = await runProbe(probeArgs(context, { forumId: created.data.id }));

  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.reason, 'forum-not-private');
  assert.equal(existsSync(join(outDir, 'probe.json')), false);
});

test('Test_Probe_setup_when_the_forum_tags_differ stops', async () => {
  const context = await setupProbe();
  const { fake, outDir, client } = context;
  const created = await client.createForumChannel({
    guildId: fake.ids.guildId,
    name: FORUM_NAME,
    tags: ['메모', '완료'],
    permissionOverwrites: [{
      id: fake.ids.guildId, type: 0, allow: '0', deny: String(1n << 10n),
    }],
  });
  assert.equal(created.ok, true);

  const result = await runProbe(probeArgs(context, { forumId: created.data.id }));

  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.reason, 'forum-tags-mismatch');
});

test('Test_Probe_setup_when_the_Date_header_is_skewed records both clock estimates', async () => {
  const context = await setupProbe();
  const { fake, outDir } = context;
  fake.hooks.setDateSkew(3000);

  const result = await runProbe(probeArgs(context));

  assert.equal(result.code, 4, JSON.stringify(result));
  const partial = readJson(join(outDir, 'probe-partial.json'));
  assert.equal(partial.clockOffsetMs, 0);
  assert.equal(partial.dateOffsetMs >= 2500 && partial.dateOffsetMs <= 3500, true);
  assert.equal(partial.clockOffsetWarning, false);
});

test('Test_Probe_owner_phase_when_no_owner_post_is_visible_yet waits without deleting', async () => {
  const context = await setupProbe();
  const { fake, outDir } = context;
  await runProbe(probeArgs(context));

  const result = await runProbe(probeArgs(context, { phase: 'owner' }));

  assert.equal(result.code, 5, JSON.stringify(result));
  assert.equal(result.reason, 'owner-post-not-found');
  assert.equal(existsSync(join(outDir, 'probe.json')), false);
  assert.equal(threads(fake).length, 1);
  assert.equal(fake.requests.some(request => request.method === 'DELETE'), false);
});

test('Test_Probe_owner_phase_when_two_owner_posts_exist stops with both ids and deletes nothing', async () => {
  const context = await setupProbe();
  const { fake, outDir } = context;
  await runProbe(probeArgs(context));
  const state = readJson(join(outDir, 'probe-state.json'));
  const first = fake.hooks.seedThread({
    forumId: state.forumId, name: OWNER_TITLE, ownerId: fake.ids.ownerUserId,
    appliedTags: [state.tagIds.idea], content: '첫 번째',
  });
  const second = fake.hooks.seedThread({
    forumId: state.forumId, name: OWNER_TITLE, ownerId: fake.ids.ownerUserId,
    appliedTags: [state.tagIds.idea], content: '두 번째',
  });

  const result = await runProbe(probeArgs(context, { phase: 'owner' }));

  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.reason, 'multiple-owner-posts');
  assert.equal(result.fields.ownerPostIds.length, 2);
  assert.equal(fake.state.channels.has(first.id), true);
  assert.equal(fake.state.channels.has(second.id), true);
  assert.equal(fake.requests.some(request => request.method === 'DELETE'), false);
});

test('Test_Probe_when_getMe_is_forbidden exits before creating the output directory', async () => {
  const context = await setupProbe();
  const { outDir, directory, client } = context;
  writeFileSync(join(directory, 'discord-token'), 'synthetic-wrong-token');

  const result = await runProbe(probeArgs(context, { client }));

  assert.equal(result.code, 1, JSON.stringify(result));
  assert.equal(result.reason, 'discord-forbidden');
  assert.equal(result.status, 401);
  assert.equal(existsSync(outDir), false);
});

test('Test_ProbeCli_setup_when_approved exits 4 at the owner boundary and never prints the token', async () => {
  const context = await setupProbe();
  const { fake, directory } = context;
  const agentDir = join(directory, 'agent');
  const tokenFile = join(agentDir, 'memento', 'secrets', 'discord-bot-token');
  mkdirSync(join(agentDir, 'memento', 'secrets'), { recursive: true });
  writeFileSync(tokenFile, TOKEN);
  const outDir = join(directory, 'cli-out');

  const result = await runCli([
    'probe', '--out', outDir, '--agent-dir', agentDir,
    '--repo-path', join(directory, 'memento-repo'), '--base-url', fake.baseUrl,
    '--audit-interval-ms', '0',
  ]);

  assert.equal(result.status, 4, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
  assert.equal(result.stdout.includes(TOKEN), false);
  assert.equal(result.stderr.includes(TOKEN), false);
  assert.match(result.stdout, /probe: awaiting-owner/);
  assert.equal(existsSync(join(outDir, 'owner-action.md')), true);
  assert.equal(forums(fake).length, 1);
  assert.equal(allFileText(outDir).includes(TOKEN), false);
});

test('Test_Probe_prepare_only_when_setup_succeeds deletes the disposable post and leaves no thread', async () => {
  const context = await setupProbe();
  const { fake, outDir } = context;

  const result = await runProbe(probeArgs(context, { prepareOnly: true }));

  assert.equal(result.code, 4, JSON.stringify(result));
  assert.equal(result.phase, 'prepared-awaiting-owner');
  assert.equal(threads(fake).length, 0);
  assert.equal(existsSync(join(outDir, 'probe.json')), false);
  const state = readJson(join(outDir, 'probe-state.json'));
  assert.equal(state.phase, 'prepared');
  assert.equal(state.probePostId, null);
  const partial = readJson(join(outDir, 'probe-partial.json'));
  assert.equal(partial.phase, 'prepared-awaiting-owner');
  assert.equal(partial.disposablePostsDeleted, true);
  assert.equal(partial.ownerCeremonyPending, true);
  assert.equal(fake.state.audit.filter(entry => entry.action_type === 112).length >= 1, true);
});

test('Test_Probe_after_prepare_only_the_next_run_creates_a_fresh_probe_post and stops at the owner boundary', async () => {
  const context = await setupProbe();
  const { fake, outDir } = context;
  const prepared = await runProbe(probeArgs(context, { prepareOnly: true }));
  assert.equal(prepared.phase, 'prepared-awaiting-owner');

  const resumed = await runProbe(probeArgs(context, { phase: 'auto' }));

  assert.equal(resumed.code, 4, JSON.stringify(resumed));
  assert.equal(resumed.phase, 'awaiting-owner');
  assert.equal(threads(fake).length, 1);
  assert.notEqual(resumed.fields.probePostId, null);
  const state = readJson(join(outDir, 'probe-state.json'));
  assert.equal(state.phase, 'awaiting-owner');
  assert.notEqual(state.probePostId, null);
  assert.equal(fake.state.audit.filter(entry => entry.action_type === 110).length, 2);
});

test('Test_Probe_when_already_complete makes no network call and creates nothing', async () => {
  const context = await setupProbe();
  const { fake, outDir } = context;
  await runProbe(probeArgs(context));
  const state = readJson(join(outDir, 'probe-state.json'));
  const ownerPost = fake.hooks.seedThread({
    forumId: state.forumId, name: OWNER_TITLE, ownerId: fake.ids.ownerUserId,
    appliedTags: [state.tagIds.idea], content: '소유자 시험 글',
  });
  fake.hooks.ownerSetTags({ threadId: ownerPost.id, appliedTags: [state.tagIds.planned] });
  fake.hooks.ownerSetTags({ threadId: state.probePostId, appliedTags: [state.tagIds.done] });
  const completed = await runProbe(probeArgs(context, { phase: 'owner' }));
  assert.equal(completed.code, 0);
  const requestCount = fake.requests.length;

  const result = await runProbe(probeArgs(context, { phase: 'auto' }));

  assert.equal(result.code, 0);
  assert.equal(result.alreadyComplete, true);
  assert.equal(fake.requests.length, requestCount);
});
