import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import {
  git,
  makeClientWrapper,
  makeSyncEnv,
  remoteGit,
} from './fixtures/sync/harness.mjs';

const envs = [];

async function setup(options = {}) {
  const env = await makeSyncEnv(options);
  envs.push(env);
  return env;
}

afterEach(async () => {
  for (const env of envs.splice(0)) await env.close();
});

const iso = (ms) => new Date(ms).toISOString();

async function linkCard(env, card, thread, base = 'idea') {
  const linked = await env.updateCard(card.id, (current) => ({
    ...current,
    discordChannel: env.forumId,
    discordThread: thread.id,
    discordBase: base,
    discordState: 'linked',
  }), {
    actor: 'memento', via: 'sync', change: 'link', reason: 'fixture-link',
  });
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

test('Test_Sync_pushes_the_card_before_creating_the_post_and_never_duplicates', async () => {
  // Given one PC card; when synced five times; then one marked post, pushed first, no later writes.
  const env = await setup();
  const card = await env.newCard({ original: '첫째 원문 ㅋㅋㅋ 👍' });
  let remoteHadCardAtPost = null;
  env.client = {
    ...env.plainClient,
    createForumPost: async (params, options) => {
      remoteHadCardAtPost = env.remoteHas(`cards/${card.id}.md`);
      return env.plainClient.createForumPost(params, options);
    },
  };

  const first = await env.run();
  assert.equal(first.ok, true);
  assert.equal(first.actions.posted, 1);
  assert.equal(remoteHadCardAtPost, true, 'the card must be on the remote before the post exists');

  const threads = await env.plainClient.listActiveForumThreads({
    guildId: env.fake.ids.guildId, forumId: env.forumId,
  });
  assert.equal(threads.data.length, 1);
  const starter = await env.plainClient.getStarterMessage(threads.data[0].id);
  assert.ok(starter.data.content.includes(`memento:v1:${env.readState().repoId}:${card.id}:`));

  const mutations = env.mutations().length;
  for (let index = 0; index < 4; index += 1) {
    const repeated = await env.run();
    assert.equal(repeated.ok, true);
  }
  assert.equal(env.mutations().length, mutations, 'later syncs make no Discord writes');
  assert.equal(env.readState().pending.length, 0);
});

test('Test_Sync_when_the_push_fails_posts_nothing_and_posts_after_the_push_succeeds', async () => {
  // Given a push failure; when synced; then no post, waiting-for-push, and the next sync posts.
  const env = await setup();
  const card = await env.newCard();
  const realPush = env.store.push;
  let fail = true;
  env.store = {
    ...env.store,
    push: async (options) => (fail
      ? { ok: false, code: 'PUSH_FAILED', stderr: 'synthetic' }
      : realPush(options)),
  };

  const first = await env.run();
  assert.equal(first.waitingForPush, true);
  assert.equal(env.posts().length, 0);
  assert.equal((await env.card(card.id)).discordState, 'posting');
  assert.equal(env.readState().pending[0].sent, false);

  fail = false;
  const second = await env.run();
  assert.equal(second.actions.posted, 1);
  assert.equal(env.posts().length, 1);
  assert.equal((await env.card(card.id)).discordState, 'linked');
});

test('Test_Sync_recovers_a_saved_create_response_without_its_link', async () => {
  // Given a posting card and a pending create whose marker already exists; when synced; then link, no repost.
  const env = await setup();
  const card = await env.newCard();
  const key = 'create-key-recover';
  const state = env.readState();
  const postingAt = iso(env.clock.now());
  const posting = await env.updateCard(card.id, (current) => ({
    ...current, discordState: 'posting', discordPostingSince: postingAt,
  }), { actor: 'memento', via: 'sync', change: 'link', reason: 'posting' });
  await env.store.writeSyncState({
    ...state,
    pending: [{ kind: 'create', key, cardId: card.id, at: postingAt, sent: true }],
  });
  const marker = `메멘토 카드 ${card.id} · memento:v1:${state.repoId}:${card.id}:${key}`;
  const thread = env.seedThread({
    name: posting.title,
    ownerId: env.fake.ids.botUserId,
    appliedTags: [env.tags.idea],
    content: `${posting.title}\n\n${posting.original}\n\n${marker}`,
  });

  const result = await env.run();
  assert.equal(result.actions.linked, 1);
  assert.equal(env.posts().length, 0);
  const linked = await env.card(card.id);
  assert.equal(linked.discordThread, thread.id);
  assert.equal(linked.discordState, 'linked');
  assert.equal(env.readState().pending.length, 0);
});

test('Test_Sync_adopts_a_cut_orphan_post_and_names_it', async () => {
  // Given a bot post whose card is gone; when synced; then one adopted card with original_incomplete.
  const env = await setup();
  const state = env.readState();
  const cardId = '20260101-aaaa';
  const cut = '잘린 원문 첫 줄…(잘림)';
  const marker = `메멘토 카드 ${cardId} · memento:v1:${state.repoId}:${cardId}:orphan-key`;
  const thread = env.seedThread({
    name: '복원된 제목',
    ownerId: env.fake.ids.botUserId,
    appliedTags: [env.tags.idea],
    content: `복원된 제목\n\n${cut}\n\n${marker}`,
  });

  const result = await env.run();
  assert.equal(result.actions.adopted, 1);
  assert.match(result.notify ?? '', new RegExp(cardId));
  const adopted = await env.card(cardId);
  assert.ok(adopted, 'the orphan becomes a card');
  assert.equal(adopted.source, 'discord');
  assert.equal(adopted.sourceRef, `discord:${thread.id}`);
  assert.equal(adopted.originalIncomplete, true);
  assert.equal(adopted.original, cut);
  assert.equal(adopted.discordThread, thread.id);
  assert.ok(adopted.log.some((event) => event.change === 'adopted-orphan'));
});

test('Test_Sync_restoring_from_the_bare_remote_keeps_every_link_and_acts_zero_times', async () => {
  // Given a pushed card and post; when the bare remote is restored into an empty folder; then no actions.
  const env = await setup();
  const card = await env.newCard({ original: '복원 원문 👍 ㅋㅋㅋ' });
  await env.run();
  const linked = await env.card(card.id);
  const restoredPath = env.cloneRestored();
  const { openStore } = await import('../src/store/store.mjs');
  const { runSync } = await import('../src/sync/run.mjs');
  const restored = openStore(restoredPath, { sleep: async () => {}, lockWaitMs: 500 });
  const before = env.mutations().length;

  const result = await runSync({
    reason: 'startup',
    config: { ...env.config(), repoPath: restoredPath },
    store: restored,
    client: env.client,
    receipts: env.receipts,
    now: env.clock.now,
  });

  assert.equal(result.ok, true);
  assert.equal(env.mutations().length, before);
  const restoredCard = await restored.get(card.id);
  assert.equal(restoredCard.ok, true);
  assert.equal(restoredCard.card.discordThread, linked.discordThread);
  assert.equal(restoredCard.card.discordState, 'linked');
  assert.equal(restoredCard.card.original, card.original.normalize('NFC'));
});

test('Test_Sync_imports_owner_phone_posts_and_ignores_foreign_authors', async () => {
  // Given three owner posts (one untagged) and one foreign post; then three verbatim cards and one ignore.
  const env = await setup();
  const tagged = env.seedThread({
    name: '첫째 아이디어', appliedTags: [env.tags.researching], content: '첫째 원문 ㅋㅋㅋ',
  });
  const untagged = env.seedThread({ name: '둘째 아이디어', appliedTags: [], content: '둘째 원문 👍' });
  const third = env.seedThread({
    name: '셋째 아이디어', appliedTags: [env.tags.planned], content: '셋째 원문\n둘째 줄',
  });
  env.seedThread({
    name: '남의 글',
    ownerId: '999999999999999999',
    appliedTags: [],
    content: '남의 원문',
  });

  const result = await env.run();
  assert.equal(result.actions.imported, 3);
  assert.equal(result.actions.ignoredAuthors, 1);
  const cards = await env.cards();
  assert.equal(cards.length, 3);
  const byThread = new Map(cards.map((entry) => [entry.discordThread, entry]));
  assert.equal(byThread.get(tagged.id).original, '첫째 원문 ㅋㅋㅋ');
  assert.equal(byThread.get(tagged.id).source, 'discord');
  assert.equal(byThread.get(tagged.id).sourceRef, `discord:${tagged.id}`);
  assert.equal(byThread.get(tagged.id).status, 'researching');
  assert.equal(byThread.get(untagged.id).status, 'idea');
  assert.equal(byThread.get(untagged.id).discordBase, 'idea');
  assert.equal(byThread.get(third.id).original, '셋째 원문\n둘째 줄');
  const applied = env.fake.requests.filter((entry) => entry.method === 'PATCH');
  assert.equal(applied.length, 1, 'only the untagged owner post gets 메모');
  assert.ok(receiptEvents(env).some((entry) => entry.event === 'ignored-author'));
});

test('Test_Sync_takes_an_owner_phone_tag_change', async () => {
  // Given a linked idea card; when the owner tags the phone post held; then the card follows.
  const env = await setup();
  const thread = env.seedThread({ appliedTags: [env.tags.idea], content: '전화 원문' });
  await env.run();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });

  const result = await env.run();
  assert.equal(result.actions.taken, 1);
  const card = (await env.cards())[0];
  assert.equal(card.status, 'held');
  assert.equal(card.discordBase, 'held');
  assert.equal(card.discordState, 'linked');
});

test('Test_Sync_restores_an_owner_tag_changed_between_the_reread_and_the_patch', async () => {
  // Given a held PATCH; when the owner changes the tag during the hold; then restore and conflict.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  const picked = await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });

  const pending = env.run();
  await hold.arrived;
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  hold.release();
  const result = await pending;

  assert.equal(result.actions.conflicts, 1);
  const after = await env.card(picked.id);
  assert.equal(after.discordState, 'conflict');
  assert.equal(after.discordBase, 'idea');
  assert.deepEqual(after.conflictDiscord?.sort(), ['done', 'held']);
  const remote = await env.plainClient.getThread(thread.id);
  assert.deepEqual(remote.data.applied_tags, [env.tags.held], 'the owner tag is restored');
  const patches = env.fake.requests.filter((entry) => entry.method === 'PATCH');
  assert.equal(patches.length, 2, 'our PATCH plus the restoring PATCH');
});

test('Test_Sync_conflicts_when_an_owner_entry_is_visible_only_at_the_next_sync', async () => {
  // Given an owner tag change whose audit entry is hidden; when synced; then no guessing, a conflict.
  const env = await setup();
  const thread = env.seedThread({ appliedTags: [env.tags.idea], content: '숨은 변경' });
  await env.run();
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });

  const first = await env.run();
  assert.equal(first.actions.conflicts, 1);
  const conflicted = (await env.cards())[0];
  assert.equal(conflicted.discordState, 'conflict');
  assert.deepEqual(conflicted.conflictDiscord, ['held']);
  assert.equal(conflicted.status, 'idea', 'the card value is kept');

  env.fake.hooks.releaseAuditVisibility();
  const second = await env.run();
  assert.equal(second.ok, true);
  const after = (await env.cards())[0];
  assert.equal(after.status, 'idea', 'the hidden entry does not silently overwrite the conflict');
  assert.ok(['conflict', 'linked'].includes(after.discordState));
});

test('Test_Sync_finds_a_late_owner_entry_after_an_eight_day_gap', async () => {
  // Given no session for eight days; when the owner changed the tag; then the entry is still found and taken.
  const env = await setup();
  const thread = env.seedThread({ appliedTags: [env.tags.idea], content: '팔일 뒤' });
  await env.run();
  env.clock.advance(8 * 24 * 60 * 60 * 1_000);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.researching] });

  const result = await env.run();
  assert.equal(result.actions.taken, 1);
  const card = (await env.cards())[0];
  assert.equal(card.status, 'researching');
  assert.equal(card.discordBase, 'researching');
});

test('Test_Sync_keeps_a_conflict_when_a_hidden_owner_entry_appears_after_eight_days', async () => {
  // Given a hidden owner entry and a conflict; when it becomes visible eight days later;
  // then it is ingested and the conflict is not silently overwritten.
  const env = await setup();
  const thread = env.seedThread({ appliedTags: [env.tags.idea], content: '늦게 보이는 변경' });
  await env.run();
  env.fake.hooks.delayAuditVisibility();
  const hidden = env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  const first = await env.run();
  assert.equal(first.actions.conflicts, 1);

  env.clock.advance(8 * 24 * 60 * 60 * 1_000);
  env.fake.hooks.releaseAuditVisibility();
  const second = await env.run();

  assert.equal(second.ok, true);
  const state = env.readState();
  assert.ok(state.audit.ingested.some((entry) => entry.id === hidden.id), 'the late entry is ingested');
  const card = (await env.cards())[0];
  assert.equal(card.discordState, 'conflict');
  assert.equal(card.status, 'idea');
});

test('Test_Sync_resumes_an_unfinished_status_op', async () => {
  // Given a persisted status op from an interrupted run; when synced; then it is completed once.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  const picked = await boardPick(env, card, 'done');
  const state = env.readState();
  await env.store.writeSyncState({
    ...state,
    pending: [{
      kind: 'status', key: 'unfinished-key', thread: thread.id, cardId: picked.id,
      t0: new Date(env.clock.now()).toISOString(),
    }],
  });

  const result = await env.run();
  assert.equal(result.actions.pushed, 1);
  assert.equal(env.readState().pending.length, 0);
  const remote = await env.plainClient.getThread(thread.id);
  assert.deepEqual(remote.data.applied_tags, [env.tags.done]);
  assert.ok(receiptEvents(env).some((entry) => entry.event === 'pending-status-resumed'));
});

test('Test_Sync_notices_an_owner_starter_edit_and_keeps_a_secret_edit_out', async () => {
  // Given a posted card; when the owner edits the starter; then the original follows, but not a secret.
  const env = await setup();
  const card = await env.newCard({ original: '처음 원문' });
  await env.run();
  const linked = await env.card(card.id);
  const message = env.fake.state.messages.get(linked.discordThread);
  const markerLine = message.content.split('\n').at(-1);

  message.content = `${linked.title}\n\n수정된 원문 😀\n\n${markerLine}`;
  message.edited_timestamp = new Date(env.clock.now() + 1_000).toISOString();
  const first = await env.run();
  assert.equal(first.actions.edits, 1);
  let after = await env.card(card.id);
  assert.equal(after.original, '수정된 원문 😀');
  assert.ok(after.log.some((event) => event.change === 'original' && event.reason === 'owner-edit'));

  env.clock.advance(2_000);
  message.content = `${linked.title}\n\nsk-${'B'.repeat(32)}\n\n${markerLine}`;
  message.edited_timestamp = new Date(env.clock.now() + 1_000).toISOString();
  await env.run();
  after = await env.card(card.id);
  assert.equal(after.original, '수정된 원문 😀');
  assert.ok(after.log.some((event) => event.change === 'skipped-secret'));
});

test('Test_Sync_verifies_a_recent_write_after_the_measured_delay', async () => {
  // Given an explicit measured audit delay; when a quiet six minutes pass with complete reads;
  // then the verified write is retired without a false expiry.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  const withDelay = env.readState();
  await env.store.writeSyncState({ ...withDelay, ownerAuditDelayMs: 1_000 });
  await boardPick(env, card, 'done');
  const first = await env.run();
  assert.equal(first.actions.pushed, 1);
  assert.equal(env.readState().recentWrites.length, 1);
  const mutations = env.mutations().length;

  env.clock.advance(6 * 60 * 1_000);
  const second = await env.run();

  assert.equal(second.ok, true);
  assert.equal(env.readState().recentWrites.length, 0, 'measured delay + complete window retires the write');
  assert.equal(env.mutations().length, mutations);
});

test('Test_Sync_imports_a_two_tag_owner_post_as_a_conflict', async () => {
  // Given an owner post with two status tags; when imported; then both candidates are kept and nothing is written.
  const env = await setup();
  env.seedThread({
    name: '두 태그',
    appliedTags: [env.tags.done, env.tags.held],
    content: '두 태그 원문',
  });

  const result = await env.run();
  assert.equal(result.actions.imported, 1);
  assert.equal(result.actions.conflicts, 1);
  const card = (await env.cards())[0];
  assert.equal(card.discordState, 'conflict');
  assert.equal(card.status, 'idea');
  assert.deepEqual(card.conflictDiscord.sort(), ['done', 'held']);
  assert.equal(env.posts().length, 0);
  assert.equal(env.fake.requests.filter((entry) => entry.method === 'PATCH').length, 0);
});

test('Test_Sync_cuts_a_long_post_but_keeps_the_card_original_verbatim', async () => {
  // Given a 2600-character original; when posted; then the post fits 2000 and the card keeps every byte.
  const env = await setup();
  const original = `${'가'.repeat(2_100)}👍${'나'.repeat(500)}`;
  const card = await env.newCard({ original });

  const result = await env.run();
  assert.equal(result.actions.posted, 1);
  const linked = await env.card(card.id);
  assert.equal(linked.original, original.normalize('NFC'));
  const starter = await env.plainClient.getStarterMessage(linked.discordThread);
  assert.ok(starter.data.content.length <= 2_000, `length ${starter.data.content.length}`);
  assert.ok(starter.data.content.includes('…(잘림)'));
  assert.ok(starter.data.content.includes('memento:v1:'));
  assert.ok(!starter.data.content.includes('\uFFFD'));
});

test('Test_Sync_conflicts_when_a_recent_write_is_unverified_after_forty_five_days', async () => {
  // Given an unverifiable write older than the audit retention; when synced; then conflict and a notice.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  const state = env.readState();
  const old = iso(env.clock.now() - 46 * 24 * 60 * 60 * 1_000);
  await env.store.writeSyncState({
    ...state,
    recentWrites: [{ thread: thread.id, t0: old, patchAt: old, key: 'unverified-old', cardId: card.id }],
  });

  const result = await env.run();
  assert.equal(result.actions.conflicts, 1);
  assert.match(result.notify ?? '', /감사 만료|45일|확인/);
  const after = await env.card(card.id);
  assert.equal(after.discordState, 'conflict');
  assert.ok(receiptEvents(env).some((entry) => entry.event === 'audit-expired'));
});

test('Test_Sync_a_three_second_date_skew_turns_a_proven_winner_into_a_conflict', async () => {
  // Given a board pick five seconds after the phone entry; when Discord's Date is +3 s; then overlap.
  const env = await setup();
  const start = env.clock.now();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.researching], content: card.original,
  });
  await linkCard(env, card, thread);
  env.clock.advance(5_000);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.researching] });
  env.fake.hooks.setDateSkew(3_000);
  await boardPick(env, card, 'done', start + 10_000);

  const result = await env.run();
  assert.equal(result.actions.conflicts, 1);
  const after = await env.card(card.id);
  assert.equal(after.discordState, 'conflict');
  assert.equal(after.status, 'done');
});

test('Test_Sync_without_skew_orders_the_later_board_pick_and_pushes', async () => {
  // Given the same history without a skew; when synced; then the proven board pick wins.
  const env = await setup();
  const start = env.clock.now();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.researching], content: card.original,
  });
  await linkCard(env, card, thread);
  env.clock.advance(5_000);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.researching] });
  await boardPick(env, card, 'done', start + 10_000);

  const result = await env.run();
  assert.equal(result.actions.pushed, 1);
  const remote = await env.plainClient.getThread(thread.id);
  assert.deepEqual(remote.data.applied_tags, [env.tags.done]);
  const after = await env.card(card.id);
  assert.equal(after.discordBase, 'done');
});

test('Test_Sync_writes_tags_to_an_archived_thread_with_unarchive', async () => {
  // Given an archived linked thread; when a board pick is pushed; then the PATCH unarchives.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original, archived: true,
    archiveTimestamp: iso(env.clock.now() - 60_000),
  });
  await linkCard(env, card, thread);
  await boardPick(env, card, 'done');

  const result = await env.run();
  assert.equal(result.actions.pushed, 1);
  const patch = env.fake.requests.find((entry) => entry.method === 'PATCH');
  assert.equal(patch.body.archived, false);
  assert.deepEqual(patch.body.applied_tags, [env.tags.done]);
});

test('Test_Sync_skips_a_secret_phone_post_and_reports_it', async () => {
  // Given an owner post containing a key; when synced; then no card, a skipped entry and a notice.
  const env = await setup();
  const thread = env.seedThread({
    name: '비밀 글', appliedTags: [], content: `sk-${'A'.repeat(32)}`,
  });

  const result = await env.run();
  assert.equal(result.actions.imported, 0);
  assert.equal(result.actions.skippedSecrets, 1);
  assert.match(result.notify ?? '', /비밀값/);
  assert.equal((await env.cards()).length, 0);
  const state = env.readState();
  assert.equal(state.skipped.length, 1);
  assert.equal(state.skipped[0].thread, thread.id);
  assert.equal(state.skipped[0].reason, 'secret');
});

test('Test_Sync_two_simultaneous_starts_run_once_and_once_more', async () => {
  // Given two session starts at once; when the second finds the lock; then it flags one rerun.
  const env = await setup();
  const hold = env.fake.hooks.holdNext({ method: 'GET', path: '/users/@me' });
  const first = env.run();
  await hold.arrived;
  const second = await env.run();
  assert.equal(second.skipped, 'busy');
  hold.release();
  const firstResult = await first;

  assert.equal(firstResult.ok, true);
  const starts = receiptEvents(env).filter((entry) => entry.event === 'sync-start');
  assert.equal(starts.length, 2);
  assert.equal(env.mutations().length, 0);
});

test('Test_Sync_allows_a_concurrent_card_write', async () => {
  // Given a held guarded re-read; when another process updates the card; then that write succeeds.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  const picked = await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'GET', path: `/channels/${thread.id}` });

  const running = env.run();
  await hold.arrived;
  const external = await env.store.update(picked.id, {
    expectRev: picked.rev,
    mutate: (current) => ({ ...current, notes: '외부 메모' }),
    log: { actor: 'owner', via: 'board', change: 'status', from: 'done', to: 'done', reason: 'external' },
  });
  hold.release();
  const result = await running;

  assert.equal(external.ok, true);
  assert.equal((await env.card(card.id)).notes, '외부 메모');
  assert.equal(result.ok, true);
});

test('Test_Sync_keeps_a_deleted_thread_without_reposting', async () => {
  // Given a thread deleted on Discord; when synced; then the card stays with deleted and is not reposted.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  await linkCard(env, card, thread);
  env.fake.hooks.deleteThread(thread.id);

  const result = await env.run();
  assert.equal(result.actions.deleted, 1);
  const after = await env.card(card.id);
  assert.equal(after.discordState, 'deleted');
  assert.ok(after.log.some((event) => event.change === 'remote-deleted'));
  assert.equal(env.posts().length, 0);
});

test('Test_Sync_when_discord_is_unreachable_still_commits_and_pushes', async () => {
  // Given an unreachable Discord; when synced; then a warning and a successful push.
  const env = await setup();
  const card = await env.newCard();
  const failure = {
    ok: false, status: null, data: null, headers: {}, date: null,
    sentAt: null, receivedAt: null, error: 'network', message: 'synthetic',
  };
  env.client = { ...env.plainClient, getMe: async () => failure };

  const result = await env.run();
  assert.equal(result.discord, 'unreachable');
  assert.equal(result.notify, '메멘토: 디스코드에 연결하지 못했어요. 다음 세션에서 다시 맞춥니다');
  assert.equal(result.push, 'ok');
  assert.equal(git(env.repo, ['rev-list', '--count', 'origin/main..HEAD']).trim(), '0');
  assert.equal(env.remoteHas(`cards/${card.id}.md`), true);
});

test('Test_Sync_resolves_invalid_remote_tags_only_from_the_owner_board_pick', async () => {
  // Given two status tags; when synced; then invalid and no write, then the board pick resolves it.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title,
    appliedTags: [env.tags.done, env.tags.held],
    content: card.original,
  });
  await linkCard(env, card, thread);

  const first = await env.run();
  assert.equal(first.actions.invalid, 1);
  const invalid = await env.card(card.id);
  assert.equal(invalid.discordState, 'invalid');
  assert.equal(env.fake.requests.filter((entry) => entry.method === 'PATCH').length, 0);

  env.clock.advance(5_000);
  await boardPick(env, card, 'done', env.clock.now());
  const second = await env.run();
  assert.equal(second.actions.pushed, 1);
  const remote = await env.plainClient.getThread(thread.id);
  assert.deepEqual(remote.data.applied_tags, [env.tags.done]);
  const after = await env.card(card.id);
  assert.equal(after.discordState, 'linked');
  assert.equal(after.discordBase, 'done');
});

test('Test_Sync_abort_stops_network_steps_and_keeps_the_pending_op', async () => {
  // Given a held PATCH; when shutdown aborts; then the request stops, the lock is free and the op stays pending.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({
    name: card.title, appliedTags: [env.tags.idea], content: card.original,
  });
  const linked = await linkCard(env, card, thread);
  await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const controller = new AbortController();

  const running = env.run({ signal: controller.signal });
  await hold.arrived;
  controller.abort();
  hold.release();
  const result = await running;

  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(env.repo, '.git', 'memento', 'sync.lock')), false);
  const state = env.readState();
  assert.equal(state.pending.filter((entry) => entry.kind === 'status').length, 1);
  const after = await env.card(card.id);
  assert.equal(after.discordBase, linked.discordBase);
  assert.equal(git(env.repo, ['status', '--porcelain']).trim(), '');
  assert.ok(receiptEvents(env).some((entry) => entry.event === 'sync-aborted'));
});

test('Test_Sync_makes_no_write_when_the_repository_is_uninitialized', async () => {
  // Given a repo without sync state; when synced; then a receipt and no remote/Discord work.
  const env = await setup();
  const { rmSync } = await import('node:fs');
  rmSync(join(env.repo, 'sync', 'state.json'));
  const before = env.fake.requests.length;

  const result = await env.run();
  assert.equal(result.ok, false);
  assert.equal(result.skipped, 'repo-uninitialized');
  assert.equal(env.fake.requests.length, before);
});

export { makeClientWrapper, remoteGit };
