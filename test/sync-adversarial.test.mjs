import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { serialize } from '../src/card/codec.mjs';
import {
  git,
  makeClientWrapper,
  makeSyncEnv,
} from './fixtures/sync/harness.mjs';

const envs = [];
const iso = (ms) => new Date(ms).toISOString();
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

async function setup(options = {}) {
  const env = await makeSyncEnv(options);
  envs.push(env);
  return env;
}

afterEach(async () => {
  for (const env of envs.splice(0)) await env.close();
});

async function linkCard(env, card, thread, base = 'idea') {
  const linked = await env.updateCard(card.id, (current) => ({
    ...current,
    discordChannel: env.forumId,
    discordThread: thread.id,
    discordBase: base,
    discordState: 'linked',
  }), { actor: 'memento', via: 'sync', change: 'link', reason: 'fixture-link' });
  const state = env.readState();
  await env.store.writeSyncState({
    ...state,
    bases: { ...(state.bases ?? {}), [card.id]: iso(env.clock.now() - 1_000) },
  });
  return linked;
}

async function boardPick(env, card, to, at = env.clock.now()) {
  return env.updateCard(card.id, (current) => ({ ...current, status: to }), {
    at: iso(at),
    eventId: `board-${at}-${to}`,
    actor: 'owner',
    via: 'board',
    change: 'status',
    from: card.status,
    to,
    reason: 'owner-board',
  });
}

function receiptEvents(env) {
  const path = join(env.agentDir, 'logs', 'memento.jsonl');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return raw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function idFor(index) {
  return `20260101-${BASE32[(index >> 15) & 31]}${BASE32[(index >> 10) & 31]}${BASE32[(index >> 5) & 31]}${BASE32[index & 31]}`;
}

async function seedLinkedCards(env, count, ownerId) {
  const at = new Date(env.clock.now()).toISOString();
  for (let index = 0; index < count; index += 1) {
    const thread = env.seedThread({
      name: `글 ${index}`,
      ownerId,
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

test('Test_B1_late_owner_audit_behind_a_newer_bot_cursor_still_conflicts', async () => {
  // Given a hidden owner entry below a visible bot entry; when six minutes and then eight days pass;
  // then the original write window is reread and the owner tag is restored as a conflict.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const running = env.run();
  await hold.arrived;
  env.clock.advance(1_000);
  env.fake.hooks.delayAuditVisibility();
  const hidden = env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  hold.release();
  const first = await running;
  assert.equal(first.ok, true);
  assert.equal((await env.card(card.id)).discordState, 'linked');
  assert.equal(env.readState().recentWrites.length, 1);

  // Only the newer bot entry is visible to the next sync.
  const botEntry = env.fake.state.audit.find((entry) => entry.user_id === env.fake.ids.botUserId
    && entry.reason?.startsWith('memento-sync') && entry.changes?.some((change) => change.key === 'applied_tags'));
  assert.ok(botEntry, 'our PATCH audit entry exists');
  botEntry.visible = true;

  env.clock.advance(6 * 60 * 1_000);
  await env.run();
  assert.equal(env.readState().recentWrites.length, 1, 'the write window is retained past the five-minute floor');

  env.clock.advance(8 * 24 * 60 * 60 * 1_000);
  env.fake.hooks.releaseAuditVisibility();
  const last = await env.run();

  assert.equal(hidden.visible, true);
  assert.equal(last.actions.conflicts, 1);
  const after = await env.card(card.id);
  assert.equal(after.discordState, 'conflict');
  assert.ok(after.conflictDiscord.includes('held'));
  const remote = await env.plainClient.getThread(thread.id);
  assert.deepEqual(remote.data.applied_tags, [env.tags.held], 'the held owner tag is restored');
});

test('Test_B2_secret_in_a_phone_title_writes_nothing', async () => {
  // Given an owner post whose title carries a key; when synced; then no card and only the pattern.
  const env = await setup();
  env.seedThread({
    name: `ghp_${'Q'.repeat(40)}`,
    appliedTags: [env.tags.idea],
    content: 'Harmless body',
  });

  const result = await env.run();
  assert.equal(result.actions.imported, 0);
  assert.equal(result.actions.skippedSecrets, 1);
  assert.equal((await env.cards()).length, 0);
  const state = env.readState();
  assert.equal(state.skipped.length, 1);
  assert.equal(state.skipped[0].reason, 'secret');
  assert.ok(receiptEvents(env).some((entry) => entry.event === 'skipped-secret' && entry.pattern === 'github-token'));
  assert.ok(!JSON.stringify(receiptEvents(env)).includes('ghp_'));
});

test('Test_B2b_a_clean_title_only_rename_rechecks_a_skipped_post', async () => {
  // Given a skipped secret-title post; when only the title becomes clean;
  // then the post is rechecked without storing the secret text and becomes a card.
  const env = await setup();
  const thread = env.seedThread({
    name: `ghp_${'Q'.repeat(40)}`,
    appliedTags: [env.tags.idea],
    content: 'Harmless body',
  });
  await env.run();
  assert.equal((await env.cards()).length, 0);
  assert.equal(env.readState().skipped.length, 1);
  assert.ok(!JSON.stringify(env.readState().skipped).includes('ghp_'));

  env.fake.state.channels.get(thread.id).name = 'Clean owner title';
  const result = await env.run();

  assert.equal(result.actions.imported, 1);
  const cards = await env.cards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'Clean owner title');
  assert.equal(cards[0].original, 'Harmless body');
  assert.equal(env.readState().skipped.length, 0);
});

test('Test_B3_unmarked_owner_edit_preserves_the_entire_original', async () => {
  // Given an imported owner post; when the owner edits the same title-prefixed body;
  // then every normalized character is kept.
  const env = await setup();
  const thread = env.seedThread({
    name: 'Phone title', appliedTags: [env.tags.idea], content: 'Harmless body',
  });
  await env.run();
  const message = env.fake.state.messages.get(thread.id);
  message.content = 'Phone title\n\nOwner meant both lines';
  message.edited_timestamp = new Date(env.clock.now() + 1_000).toISOString();

  const result = await env.run();
  assert.equal(result.actions.edits, 1);
  const card = (await env.cards())[0];
  assert.equal(card.original, 'Phone title\n\nOwner meant both lines');
});

test('Test_B4_duplicate_markers_quarantine_instead_of_linking_arbitrarily', async () => {
  // Given two posts carrying the same marker; when synced; then the card is a durable conflict.
  const env = await setup();
  const card = await env.newCard();
  const key = 'ambiguous-key';
  const postingAt = iso(env.clock.now());
  const posting = await env.updateCard(card.id, (current) => ({
    ...current, discordState: 'posting', discordPostingSince: postingAt,
  }), { actor: 'memento', via: 'sync', change: 'link', reason: 'posting' });
  const state = env.readState();
  await env.store.writeSyncState({
    ...state,
    pending: [{ kind: 'create', key, cardId: card.id, at: postingAt, sent: true }],
  });
  const marker = `메멘토 카드 ${card.id} · memento:v1:${state.repoId}:${card.id}:${key}`;
  const first = env.seedThread({
    name: posting.title, ownerId: env.fake.ids.botUserId,
    appliedTags: [env.tags.idea], content: `${posting.title}\n\n${posting.original}\n\n${marker}`,
  });
  const second = env.seedThread({
    name: posting.title, ownerId: env.fake.ids.botUserId,
    appliedTags: [env.tags.idea], content: `${posting.title}\n\n${posting.original}\n\n${marker}`,
  });

  const result = await env.run();
  const after = await env.card(card.id);
  assert.equal(result.actions.conflicts, 1);
  assert.equal(after.discordState, 'conflict');
  assert.equal(after.discordThread, '', 'no arbitrary marker link');
  assert.deepEqual(after.conflictDiscord, ['idea']);
  const stored = env.readState();
  assert.equal(stored.pending.length, 0);
  assert.equal(stored.quarantine.length, 1);
  assert.deepEqual(stored.quarantine[0].threads.sort(), [first.id, second.id].sort());
});

test('Test_B5_owner_thread_rename_is_mirrored_to_the_card_title', async () => {
  // Given an imported owner post; when the owner renames it; then the card title follows with a log.
  const env = await setup();
  const thread = env.seedThread({
    name: 'Phone title', appliedTags: [env.tags.idea], content: 'Body',
  });
  await env.run();
  env.fake.state.channels.get(thread.id).name = 'Renamed title';

  const result = await env.run();
  assert.equal(result.ok, true);
  const card = (await env.cards())[0];
  assert.equal(card.title, 'Renamed title');
  assert.ok(card.log.some((entry) => entry.change === 'original' && entry.reason === 'owner-title-rename'));
});

test('Test_B5b_a_denied_owner_restore_stays_pending_until_it_succeeds', async () => {
  // Given an owner race; when the restoring PATCH is denied; then the intent stays pending,
  // no restored success is claimed, and the next sync restores the owner tag.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  const picked = await boardPick(env, card, 'done');
  const withDelay = env.readState();
  await env.store.writeSyncState({ ...withDelay, ownerAuditDelayMs: 1_000 });
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  let patchCalls = 0;
  const realPatch = env.plainClient.patchThreadTags;
  env.client = {
    ...env.plainClient,
    patchThreadTags: async (params, options) => {
      patchCalls += 1;
      if (patchCalls === 2) {
        return {
          ok: false, status: 403, data: null, headers: {}, date: null,
          sentAt: null, receivedAt: null, error: 'http', forbidden: true,
        };
      }
      return realPatch(params, options);
    },
  };

  const first = env.run();
  await hold.arrived;
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  hold.release();
  const denied = await first;

  assert.equal(denied.actions.failures >= 1, true);
  const conflicted = await env.card(picked.id);
  assert.equal(conflicted.discordState, 'conflict');
  const pending = env.readState().pending.filter((entry) => entry.intent === 'restore');
  assert.equal(pending.length, 1, 'the restoration intent is durable');
  assert.deepEqual(Object.keys(pending[0]).sort(), [
    'attempts', 'cardId', 'conflictSince', 'eventId', 'intent', 'key', 'kind',
    'ownerEntryId', 'ownerStatus', 'patchAt', 'pushedStatus', 'reason', 'schema',
    't0', 'targetStatus', 'thread', 'writer',
  ].sort());
  assert.equal(pending[0].schema, 'memento.restore.v1');
  assert.equal(pending[0].writer, 'sync');
  assert.equal(pending[0].targetStatus, 'held');
  assert.equal(pending[0].pushedStatus, 'done');
  assert.equal(pending[0].reason, 'owner-race');
  assert.equal(pending[0].attempts, 0);
  assert.ok(receiptEvents(env).some((entry) => entry.event === 'owner-restore-pending'));
  assert.ok(!receiptEvents(env).some((entry) => entry.event === 'owner-race-restored'));
  const stillDone = await env.plainClient.getThread(thread.id);
  assert.deepEqual(stillDone.data.applied_tags, [env.tags.done]);

  env.client = env.plainClient;
  const recovered = await env.run();
  assert.equal(recovered.ok, true);
  assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 1,
    'success is retained until the D floor');
  assert.ok(receiptEvents(env).some((entry) => entry.event === 'owner-restore-retained'));
  const restored = await env.plainClient.getThread(thread.id);
  assert.deepEqual(restored.data.applied_tags, [env.tags.held]);

  env.clock.advance(5 * 60 * 1_000);
  await env.run();
  assert.equal(env.readState().pending.filter((entry) => entry.intent === 'restore').length, 0);
  assert.ok(receiptEvents(env).some((entry) => entry.event === 'owner-restore-completed'));
});

test('Test_B6_shared_discord_deadline_stops_nine_second_calls_at_forty_seconds', async () => {
  // Given five 9 s calls; when synced; then the shared Discord phase reports budget, not ok.
  const env = await setup();
  env.client = makeClientWrapper(env.plainClient, { perCallMs: 9_000, clock: env.clock });
  const started = env.clock.now();

  const result = await env.run();
  const elapsed = env.clock.now() - started;

  assert.equal(result.discord, 'budget');
  assert.ok(elapsed >= 40_000, `elapsed ${elapsed}`);
  assert.equal(result.push, 'ok');
});

test('Test_B7_five_hundred_linked_bot_threads_fetch_only_the_rotation', async () => {
  // Given 500 normal linked bot threads; when synced; then only the 100-card edit window is read.
  const env = await setup();
  await seedLinkedCards(env, 500, env.fake.ids.botUserId);
  env.client = makeClientWrapper(env.plainClient, { perCallMs: 100, clock: env.clock });
  const started = env.clock.now();

  const result = await env.run();
  const starterFetches = env.fake.requests.filter((entry) => entry.path.includes('/messages/')).length;
  const elapsed = env.clock.now() - started;

  assert.equal(result.discord, 'ok');
  assert.ok(starterFetches <= 100, `starter fetches ${starterFetches}`);
  assert.ok(elapsed < 60_000, `elapsed ${elapsed}`);
});

test('Test_B8_missing_forum_still_commits_and_pushes_the_configured_repo', async () => {
  // Given a configured repo with a bare remote but no forum identity; when synced;
  // then the local card reaches the remote even though Discord is inert.
  const env = await setup();
  const card = await env.newCard();
  const state = env.readState();
  await env.store.writeSyncState({
    ...state,
    guildId: null,
    forumId: null,
    tagIds: {},
  });

  const result = await env.run();

  assert.equal(result.discord, 'unconfigured');
  assert.equal(result.push, 'ok');
  assert.equal(env.remoteHas(`cards/${card.id}.md`), true);
  assert.equal(git(env.repo, ['rev-list', '--count', 'origin/main..HEAD']).trim(), '0');
});
