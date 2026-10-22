import assert from 'node:assert/strict';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { serialize } from '../src/card/codec.mjs';
import { git, makeClientWrapper, makeSyncEnv } from './fixtures/sync/harness.mjs';

const envs = [];

async function setup() {
  const env = await makeSyncEnv();
  envs.push(env);
  return env;
}

afterEach(async () => {
  for (const env of envs.splice(0)) await env.close();
});

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function idFor(index) {
  return `20260101-${BASE32[(index >> 15) & 31]}${BASE32[(index >> 10) & 31]}${BASE32[(index >> 5) & 31]}${BASE32[index & 31]}`;
}

async function seedLinkedCards(env, count, { editSeen = false } = {}) {
  const at = new Date(env.clock.now()).toISOString();
  for (let index = 0; index < count; index += 1) {
    const thread = env.seedThread({
      name: `글 ${index}`,
      appliedTags: [env.tags.idea],
      content: `원문 ${index}`,
    });
    const card = {
      description: `설명 ${index}`,
      id: idFor(index),
      status: 'idea',
      created: at,
      updated: at,
      source: 'discord',
      sourceRef: `discord:${thread.id}`,
      rev: 1,
      discordChannel: env.forumId,
      discordThread: thread.id,
      discordBase: 'idea',
      discordState: 'linked',
      ...(editSeen ? { discordEditSeen: at } : {}),
      schema: 'memento.card.v1',
      title: `글 ${index}`,
      original: `원문 ${index}`,
      notes: '',
      log: [{
        at, eventId: `seed-${index}`, actor: 'owner', via: 'discord', change: 'create', reason: 'import',
      }],
    };
    env.writeFile(join('cards', `${card.id}.md`), serialize(card));
  }
  git(env.repo, ['add', '--', 'cards']);
  git(env.repo, ['-c', 'user.name=memento', '-c', 'user.email=memento@local', 'commit', '-m', 'fixture: linked cards']);
}

test('Test_Sync_five_hundred_threads_finish_inside_the_sixty_second_budget', async () => {
  // Given 500 linked cards and 100 ms per Discord call; when synced; then it finishes under 60 s.
  const env = await setup();
  await seedLinkedCards(env, 500);
  env.client = makeClientWrapper(env.plainClient, { perCallMs: 100, clock: env.clock });
  const started = env.clock.now();

  const result = await env.run();
  const elapsed = env.clock.now() - started;

  assert.equal(result.ok, true);
  assert.ok(elapsed < 60_000, `elapsed ${elapsed}`);
  assert.equal(env.mutations().length, 0);
});

test('Test_Sync_stops_discord_work_at_the_forty_second_budget_and_still_pushes', async () => {
  // Given 1 s per Discord call and 100 starters; when synced; then Discord stops at 40 s and the push runs.
  const env = await setup();
  await seedLinkedCards(env, 100);
  env.client = makeClientWrapper(env.plainClient, { perCallMs: 1_000, clock: env.clock });
  const started = env.clock.now();

  const result = await env.run();
  const elapsed = env.clock.now() - started;

  assert.equal(result.ok, true);
  assert.equal(result.discord, 'budget');
  assert.ok(elapsed >= 40_000 && elapsed < 45_000, `elapsed ${elapsed}`);
  assert.equal(result.push, 'ok');
  assert.equal(git(env.repo, ['rev-list', '--count', 'origin/main..HEAD']).trim(), '0');
});
