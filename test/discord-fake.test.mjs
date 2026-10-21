import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { createDiscordClient } from '../src/discord/client.mjs';
import { startFakeDiscord } from '../src/discord/fake-server.mjs';

const TOKEN = 'synthetic-discord-token-0123456789';
const fakes = [];
const tempDirs = [];

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'memento-fake-'));
  tempDirs.push(directory);
  return directory;
}

async function setup() {
  const fake = await startFakeDiscord({ token: TOKEN });
  fakes.push(fake);
  const directory = tempDir();
  const file = join(directory, 'discord-token');
  writeFileSync(file, `${TOKEN}\n`);
  const client = createDiscordClient({ tokenFile: file, baseUrl: fake.baseUrl, clock: fake.clock });
  return { fake, client };
}

async function forumAndPost(client, fake) {
  const forum = await client.createForumChannel({
    guildId: fake.ids.guildId, name: '메멘토', tags: ['메모', '완료', '보관'],
  });
  const post = await client.createForumPost({
    forumId: forum.data.id, name: '글', content: '원문', appliedTags: [forum.data.available_tags[0].id],
  });
  return { forum: forum.data, post: post.data, tags: forum.data.available_tags };
}

afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('Test_Fake_holdNext_blocks_the_response_until_released', async () => {
  const { fake } = await setup();
  const hold = fake.hooks.holdNext({ method: 'GET', path: '/users/@me' });
  let settled = false;
  const pending = fetch(`${fake.baseUrl}/users/@me`, {
    headers: { Authorization: `Bot ${TOKEN}` },
  }).then(response => {
    settled = true;
    return response;
  });

  await hold.arrived;
  assert.equal(settled, false);
  hold.release();
  const response = await pending;
  assert.equal(response.status, 200);
});

test('Test_Fake_delayed_thread_visibility_hides_a_created_post_until_revealed', async () => {
  const { fake, client } = await setup();
  const forum = await client.createForumChannel({ guildId: fake.ids.guildId, name: '메멘토', tags: [] });
  fake.hooks.delayCreatedThreadVisibility();
  const post = await client.createForumPost({
    forumId: forum.data.id, name: '숨김', content: '원문', appliedTags: [],
  });

  const hidden = await client.listActiveForumThreads({ guildId: fake.ids.guildId, forumId: forum.data.id });
  fake.hooks.revealThread(post.data.id);
  const visible = await client.listActiveForumThreads({ guildId: fake.ids.guildId, forumId: forum.data.id });

  assert.equal(hidden.data.length, 0);
  assert.equal(visible.data.length, 1);
  assert.equal(visible.data[0].id, post.data.id);
});

test('Test_Fake_owner_round_trip_returns_to_the_same_tags_with_two_audit_entries', async () => {
  const { fake, client } = await setup();
  const { post, tags } = await forumAndPost(client, fake);

  const roundTrip = fake.hooks.ownerRoundTrip({
    threadId: post.id, middleTags: [tags[1].id],
  });
  const thread = await client.getThread(post.id);
  const audit = await client.getAuditLog({
    guildId: fake.ids.guildId, actionType: 111, after: '0', limit: 100,
  });

  assert.deepEqual(roundTrip.before, [tags[0].id]);
  assert.deepEqual(roundTrip.after, [tags[0].id]);
  assert.equal(roundTrip.entries.length, 2);
  assert.deepEqual(thread.data.applied_tags, [tags[0].id]);
  assert.deepEqual(audit.data.map(entry => entry.changes[0].new_value), [[tags[1].id], [tags[0].id]]);
});

test('Test_Fake_dropped_and_delayed_audit_entries_are_not_visible', async () => {
  const { fake, client } = await setup();
  const { post, tags } = await forumAndPost(client, fake);
  const first = fake.hooks.ownerSetTags({ threadId: post.id, appliedTags: [tags[1].id] });

  fake.hooks.delayAuditVisibility();
  fake.hooks.ownerSetTags({ threadId: post.id, appliedTags: [tags[2].id] });
  const held = await client.getAuditLog({ guildId: fake.ids.guildId, actionType: 111, after: '0' });
  fake.hooks.releaseAuditVisibility();
  const released = await client.getAuditLog({ guildId: fake.ids.guildId, actionType: 111, after: '0' });
  fake.hooks.dropAuditEntries(entry => entry.id === first.id);
  const dropped = await client.getAuditLog({ guildId: fake.ids.guildId, actionType: 111, after: '0' });

  assert.deepEqual(held.data.map(entry => entry.id), [first.id]);
  assert.equal(released.data.length, 2);
  assert.equal(dropped.data.length, 1);
  assert.notEqual(dropped.data[0].id, first.id);
});

test('Test_Fake_seedThread_and_next_owner_support_foreign_creators', async () => {
  const { fake, client } = await setup();
  const forum = await client.createForumChannel({ guildId: fake.ids.guildId, name: '메멘토', tags: [] });
  const foreign = '999999999999999999';
  fake.hooks.setNextThreadOwner(foreign);
  const created = await client.createForumPost({
    forumId: forum.data.id, name: '남의 글', content: '원문', appliedTags: [],
  });
  const seeded = fake.hooks.seedThread({
    forumId: forum.data.id, name: '가져온 글', ownerId: foreign, archived: true, appliedTags: [],
  });

  assert.equal(created.data.owner_id, foreign);
  assert.equal(seeded.owner_id, foreign);
  assert.equal(seeded.thread_metadata.archived, true);
});

test('Test_Fake_waitForNoOpenSockets_reports_cleanup_after_client_calls', async () => {
  const { fake, client } = await setup();
  await forumAndPost(client, fake);

  assert.equal(await fake.waitForNoOpenSockets(2_000), true);
  assert.equal(fake.openSockets.size, 0);
});
