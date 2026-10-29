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

test('Test_Sync_conflicts_on_a_hidden_owner_race_when_the_guild_has_120_other_audit_entries', async () => {
  // Given 120 type-111 entries on another thread; when an owner tag change is hidden inside the write window;
  // then the late owner entry still becomes a conflict and the owner tag is restored.
  const env = await setup();
  const other = env.seedThread({ name: 'noise', appliedTags: [env.tags.idea], content: 'noise' });
  for (let i = 0; i < 120; i += 1) {
    env.fake.hooks.ownerSetTags({ threadId: other.id, appliedTags: [i % 2 ? env.tags.idea : env.tags.held] });
  }
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  const withDelay = env.readState();
  await env.store.writeSyncState({ ...withDelay, ownerAuditDelayMs: 1_000 });
  await env.run();
  await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });

  const pending = env.run();
  await hold.arrived;
  env.clock.advance(300);
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.clock.advance(300);
  hold.release();
  const first = await pending;
  assert.equal(first.actions.pushed, 1);

  env.fake.hooks.releaseAuditVisibility();
  env.clock.advance(6 * 60 * 1_000);
  const second = await env.run();

  assert.equal(second.actions.conflicts, 1, 'the late owner entry is found despite 120 other entries');
  const after = await env.card(card.id);
  assert.equal(after.discordState, 'conflict');
  assert.equal(after.status, 'done', 'the card value is kept');
  assert.equal(env.readState().recentWrites.length, 0);
  const remote = await env.plainClient.getThread(thread.id);
  assert.deepEqual(remote.data.applied_tags, [env.tags.held], 'the owner tag is restored');
});

test('Test_Sync_restores_a_late_owner_tag_when_120_later_audit_entries_follow', async () => {
  // Given an owner tag changed during a held PATCH and the restore PATCH fails once, leaving a pending restore;
  // when 120 later entries land in the guild and the next sync runs; then the restore is proven and retried.
  const env = await setup();
  let restoreAttempts = 0;
  env.client = {
    ...env.plainClient,
    patchThreadTags: (params, options) => {
      if (params.auditReason?.endsWith('restore') && restoreAttempts++ === 0) {
        return Promise.resolve({ ok: false, status: 500, error: 'injected-restore-failure' });
      }
      return env.plainClient.patchThreadTags(params, options);
    },
  };
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  const withDelay = env.readState();
  await env.store.writeSyncState({ ...withDelay, ownerAuditDelayMs: 1_000 });
  await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });

  const pending = env.run();
  await hold.arrived;
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  hold.release();
  await pending;
  assert.ok(env.readState().pending.some((op) => op.intent === 'restore'), 'the failed restore stays pending');

  const other = env.seedThread({ name: 'noise', appliedTags: [env.tags.idea], content: 'noise' });
  for (let i = 0; i < 120; i += 1) {
    env.fake.hooks.ownerSetTags({ threadId: other.id, appliedTags: [i % 2 ? env.tags.idea : env.tags.held] });
  }
  env.clock.advance(6 * 60 * 1_000);
  const second = await env.run();

  assert.equal(second.ok, true);
  assert.equal(env.readState().pending.filter((op) => op.intent === 'restore').length, 0, 'the pending restore is resolved');
  const after = await env.card(card.id);
  assert.equal(after.discordState, 'conflict');
  const remote = await env.plainClient.getThread(thread.id);
  assert.deepEqual(remote.data.applied_tags, [env.tags.held], 'the owner tag is restored');
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

async function ownerRaceAfterDonePick(env, card, thread) {
  await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const pending = env.run();
  await hold.arrived;
  env.clock.advance(300);
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.clock.advance(300);
  hold.release();
  await pending;
  env.fake.hooks.releaseAuditVisibility();
  env.clock.advance(6 * 60 * 1_000);
}

test('Test_Sync_a_later_phone_tag_beats_a_conflicted_write_without_a_measured_delay', async () => {
  // Given a done pick raced by an owner held tag, already a conflict, and no measured delay;
  // when the owner then picks planned on the phone; then planned wins on both sides and
  // the old owner tag is never restored over it.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await ownerRaceAfterDonePick(env, card, thread);
  await env.run();
  const conflicted = await env.card(card.id);
  assert.equal(conflicted.discordState, 'conflict');
  assert.ok(conflicted.conflictDiscord.includes('held'));
  env.clock.advance(60 * 1_000);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.planned] });
  env.clock.advance(6 * 60 * 1_000);
  await env.run();
  await env.run();
  const end = await env.card(card.id);
  assert.equal(end.discordState, 'linked');
  assert.equal(end.status, 'planned');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.planned]);
});

test('Test_Sync_a_later_phone_tag_beats_a_conflicted_write_with_a_measured_delay', async () => {
  // Control: the same race with a measured delay retires the write and planned wins.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.store.writeSyncState({ ...env.readState(), ownerAuditDelayMs: 63_529 });
  await env.run();
  await ownerRaceAfterDonePick(env, card, thread);
  await env.run();
  const conflicted = await env.card(card.id);
  assert.equal(conflicted.discordState, 'conflict');
  env.clock.advance(60 * 1_000);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.planned] });
  env.clock.advance(6 * 60 * 1_000);
  await env.run();
  const end = await env.card(card.id);
  assert.equal(end.discordState, 'linked');
  assert.equal(end.status, 'planned');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.planned]);
  assert.equal(env.readState().recentWrites.length, 0);
});

test('Test_Sync_an_unmeasured_late_phone_pick_is_not_restored_over', async () => {
  // Given a done pick raced by an owner held tag, conflicted, no measured delay; when the owner
  // picks planned while its audit entry is still hidden and a sync runs inside that delay; then
  // no restore PATCH lands over planned, and once the audit shows, planned wins on both sides.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await ownerRaceAfterDonePick(env, card, thread);
  await env.run();
  assert.equal((await env.card(card.id)).discordState, 'conflict');
  env.clock.advance(60 * 1_000);
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.planned] });
  env.clock.advance(30 * 1_000);
  const writesBefore = env.mutations().length;
  await env.run();
  assert.equal(env.mutations().length, writesBefore, 'no Discord write while the owner entry is hidden');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.planned]);
  env.fake.hooks.releaseAuditVisibility();
  env.clock.advance(6 * 60 * 1_000);
  await env.run();
  assert.equal(env.readState().recentWrites.length, 0);
  assert.ok(receiptEvents(env).some((event) => event.event === 'recent-write-superseded' && event.source === 'audit'));
  const end = await env.card(card.id);
  assert.equal(end.discordState, 'linked');
  assert.equal(end.status, 'planned');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.planned]);
});

async function conflictedDonePick(env) {
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await ownerRaceAfterDonePick(env, card, thread);
  await env.run();
  assert.equal((await env.card(card.id)).discordState, 'conflict');
  return { card, thread };
}

test('Test_Sync_a_board_resolution_to_a_new_value_supersedes_a_conflicted_write', async () => {
  // Given a done pick raced by an owner held tag and already a conflict; when the owner resolves
  // on the board to planned; then planned is pushed, the old write is retired as superseded, and
  // quiet syncs make no Discord write.
  const env = await setup();
  const { card, thread } = await conflictedDonePick(env);
  const oldKey = env.readState().recentWrites[0].key;
  env.clock.advance(60 * 1_000);
  await boardPick(env, card, 'planned');
  await env.run();
  const resolved = await env.card(card.id);
  assert.equal(resolved.discordState, 'linked');
  assert.equal(resolved.status, 'planned');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.planned]);
  assert.equal(env.readState().recentWrites.some((write) => write.key === oldKey), false);
  assert.ok(receiptEvents(env).some((event) => event.event === 'recent-write-superseded' && event.source === 'card-log'));
  const writes = env.mutations().length;
  env.clock.advance(10 * 60 * 1_000);
  await env.run();
  await env.run();
  assert.equal(env.mutations().length, writes, 'quiet syncs make no Discord write');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.planned]);
  assert.equal((await env.card(card.id)).discordState, 'linked');
});

test('Test_Sync_a_board_resolution_to_the_pushed_value_is_not_undone', async () => {
  // Given a done pick raced by an owner held tag and already a conflict; when the owner resolves
  // on the board to done, the value this write pushed; then done stays on Discord, the card is
  // linked, and quiet syncs make no Discord write.
  const env = await setup();
  const { card, thread } = await conflictedDonePick(env);
  env.clock.advance(60 * 1_000);
  await boardPick(env, card, 'done');
  await env.run();
  const resolved = await env.card(card.id);
  assert.equal(resolved.discordState, 'linked');
  assert.equal(resolved.status, 'done');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.done]);
  const writes = env.mutations().length;
  env.clock.advance(10 * 60 * 1_000);
  await env.run();
  await env.run();
  assert.equal(env.mutations().length, writes, 'quiet syncs make no Discord write');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.done]);
});

test('Test_Sync_quiet_syncs_after_a_conflict_do_not_restore_again_until_expiry', async () => {
  // Given a raced done pick already recorded as a conflict and no measured delay; when four quiet
  // syncs run ten minutes apart, then no Discord write and no new retained receipt, and the record
  // stays; after 46 days it retires with no new conflict event.
  const env = await setup();
  const { card } = await conflictedDonePick(env);
  const writes = env.mutations().length;
  const retained = receiptEvents(env).filter((event) => event.event === 'recent-write-retained').length;
  for (let index = 0; index < 4; index += 1) {
    env.clock.advance(10 * 60 * 1_000);
    await env.run();
  }
  assert.equal(env.mutations().length, writes, 'no Discord write in quiet syncs');
  assert.equal(receiptEvents(env).filter((event) => event.event === 'recent-write-retained').length, retained);
  assert.equal(env.readState().recentWrites.length, 1);
  const logLength = (await env.card(card.id)).log.length;
  env.clock.advance(46 * 24 * 60 * 60 * 1_000);
  await env.run();
  assert.equal(env.readState().recentWrites.length, 0);
  const after = await env.card(card.id);
  assert.equal(after.discordState, 'conflict');
  assert.equal(after.log.length, logLength, 'no new conflict event after expiry');
});

test('Test_Sync_a_board_resolution_with_a_measured_delay_stays_resolved', async () => {
  // Control: the same board resolution with a measured delay ends linked on the resolved value.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.store.writeSyncState({ ...env.readState(), ownerAuditDelayMs: 63_529 });
  await env.run();
  await ownerRaceAfterDonePick(env, card, thread);
  await env.run();
  assert.equal((await env.card(card.id)).discordState, 'conflict');
  env.clock.advance(60 * 1_000);
  await boardPick(env, card, 'planned');
  await env.run();
  const resolved = await env.card(card.id);
  assert.equal(resolved.discordState, 'linked');
  assert.equal(resolved.status, 'planned');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.planned]);
  const writes = env.mutations().length;
  env.clock.advance(10 * 60 * 1_000);
  await env.run();
  assert.equal(env.mutations().length, writes, 'quiet syncs make no Discord write');
  assert.equal(env.readState().recentWrites.length, 0);
});

test('Test_Sync_a_deleted_card_stays_deleted_past_the_audit_window', async () => {
  // Given a clean board push and then a deleted thread; when 46 days pass; then the card stays
  // deleted with no conflict event and the record expires with an audit-expired receipt.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await boardPick(env, card, 'done');
  await env.run();
  assert.equal(env.readState().recentWrites.length, 1);
  env.fake.hooks.deleteThread(thread.id);
  await env.run();
  assert.equal((await env.card(card.id)).discordState, 'deleted');
  const logLength = (await env.card(card.id)).log.length;
  env.clock.advance(46 * 24 * 60 * 60 * 1_000);
  await env.run();
  const after = await env.card(card.id);
  assert.equal(after.discordState, 'deleted');
  assert.equal(after.log.length, logLength, 'no conflict event on a deleted card');
  assert.equal(env.readState().recentWrites.length, 0);
  assert.ok(receiptEvents(env).some((event) => event.event === 'audit-expired'));
});

test('Test_Sync_a_day_ten_board_change_retires_the_first_write_only', async () => {
  // Given a clean board push, then a board change at day ten; when 46 days pass, the first write is
  // gone without a conflict; when 56 days pass, only the second write expires to a conflict.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await boardPick(env, card, 'done');
  await env.run();
  const first = env.readState().recentWrites[0];
  env.clock.advance(10 * 24 * 60 * 60 * 1_000);
  await boardPick(env, card, 'planned');
  await env.run();
  env.clock.advance(36 * 24 * 60 * 60 * 1_000);
  await env.run();
  assert.equal(env.readState().recentWrites.some((write) => write.key === first.key), false);
  assert.equal(env.readState().recentWrites.length, 1);
  assert.equal(receiptEvents(env).filter((event) => event.event === 'audit-expired').length, 0, 'the first write expires to nothing');
  env.clock.advance(10 * 24 * 60 * 60 * 1_000);
  await env.run();
  assert.equal(env.readState().recentWrites.length, 0);
  assert.equal((await env.card(card.id)).discordState, 'conflict');
  assert.ok(receiptEvents(env).some((event) => event.event === 'audit-expired'));
});

test('Test_Sync_an_imported_post_raced_by_an_owner_tag_keeps_the_owner_value', async () => {
  // Given an untagged phone post whose idea PATCH is in flight while the owner tags it held with the
  // audit entry hidden; when the audit shows and quiet syncs run; then the owner's held is a conflict
  // candidate and no later Discord write replaces it.
  const env = await setup();
  const thread = env.seedThread({ name: '태그 없는 글', appliedTags: [], content: '태그 없는 원문' });
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const pending = env.run();
  await hold.arrived;
  env.clock.advance(300);
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.clock.advance(300);
  hold.release();
  await pending;
  env.fake.hooks.releaseAuditVisibility();
  env.clock.advance(6 * 60 * 1_000);
  await env.run();
  const cards = await env.cards();
  assert.equal(cards.length, 1);
  const card = await env.card(cards[0].id);
  assert.equal(card.discordState, 'conflict');
  assert.ok(card.conflictDiscord.includes('held'), `owner held lost: ${JSON.stringify(card.conflictDiscord)}`);
  const writes = env.mutations().length;
  for (let index = 0; index < 4; index += 1) {
    env.clock.advance(10 * 60 * 1_000);
    await env.run();
  }
  assert.equal(env.mutations().length, writes, 'quiet syncs make no Discord write');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.idea]);
});

test('Test_Sync_a_member_change_over_a_raced_owner_value_keeps_the_owner_value', async () => {
  // Given our done PATCH overwrote the owner's held with the audit hidden; when a non-owner member
  // sets planned inside the delay and the audit later shows; then nothing is written over the member's
  // value and the owner's held is a conflict candidate.
  const memberId = '999999999999999999';
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const pending = env.run();
  await hold.arrived;
  env.clock.advance(300);
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.clock.advance(300);
  hold.release();
  await pending;
  env.clock.advance(60 * 1_000);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.planned], userId: memberId });
  env.clock.advance(30 * 1_000);
  const writes = env.mutations().length;
  await env.run();
  assert.equal(env.mutations().length, writes, 'no write while the audit entries are hidden');
  env.fake.hooks.releaseAuditVisibility();
  env.clock.advance(6 * 60 * 1_000);
  await env.run();
  const end = await env.card(card.id);
  assert.ok(end.conflictDiscord?.includes('held'), `owner held lost: ${JSON.stringify(end.conflictDiscord)}`);
  assert.equal(env.mutations().length, writes, 'no write over the member value');
  assert.ok(end.conflictDiscord?.includes('planned'), `member value not visible: ${JSON.stringify(end.conflictDiscord)}`);
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.planned]);
});

test('Test_Sync_a_board_push_raced_by_an_owner_tag_keeps_the_owner_value', async () => {
  // Given a board pick raced by the owner's held with the audit hidden;
  // when the audit shows and quiet syncs run; then the owner's held is restored once, recorded as a
  // conflict candidate, and no later Discord write follows.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  const at = env.clock.now();
  await env.updateCard(card.id, (current) => ({ ...current, status: 'done' }), {
    at: iso(at), actor: 'owner', via: 'board', change: 'status', from: card.status, to: 'done', reason: 'owner-board',
  });
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const pending = env.run();
  await hold.arrived;
  env.clock.advance(300);
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.clock.advance(300);
  hold.release();
  await pending;
  assert.equal(env.readState().recentWrites.length, 1);
  assert.ok(env.readState().recentWrites[0].eventId, 'the guarded push is anchored by its board event');
  env.fake.hooks.releaseAuditVisibility();
  env.clock.advance(6 * 60 * 1_000);
  await env.run();
  const end = await env.card(card.id);
  assert.ok(end.conflictDiscord?.includes('held'), `owner held lost: ${JSON.stringify(end.conflictDiscord)}`);
  const writes = env.mutations().length;
  for (let index = 0; index < 4; index += 1) {
    env.clock.advance(10 * 60 * 1_000);
    await env.run();
  }
  assert.equal(env.mutations().length, writes, 'quiet syncs make no Discord write');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.held]);
});

async function racedWithInWindowMember(env, card, thread) {
  const memberId = '999999999999999999';
  await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const pending = env.run();
  await hold.arrived;
  env.clock.advance(300);
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.planned], userId: memberId });
  env.clock.advance(300);
  hold.release();
  await pending;
  env.fake.hooks.releaseAuditVisibility();
  env.clock.advance(6 * 60 * 1_000);
}

test('Test_Sync_a_board_pick_after_an_in_window_member_change_stays_linked', async () => {
  // Given a done PATCH raced by the owner's held and a non-owner's planned inside the audit window;
  // when the owner picks held on the board after the conflict; then held stays linked and no later
  // sync re-conflicts it.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await racedWithInWindowMember(env, card, thread);
  await env.run();
  env.clock.advance(60 * 1_000);
  await boardPick(env, card, 'held');
  await env.run();
  const resolved = await env.card(card.id);
  assert.equal(resolved.discordState, 'linked');
  assert.equal(resolved.status, 'held');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.held]);
  const writes = env.mutations().length;
  const logLength = resolved.log.length;
  for (let index = 0; index < 4; index += 1) {
    env.clock.advance(10 * 60 * 1_000);
    await env.run();
  }
  const end = await env.card(card.id);
  assert.equal(end.discordState, 'linked', 'stays linked');
  assert.equal(end.log.length, logLength, 'quiet syncs add no card-log event');
  assert.equal(env.mutations().length, writes, 'quiet syncs make no Discord write');
});

test('Test_Sync_a_second_board_pick_after_an_in_window_member_change_stays_linked', async () => {
  // Given the same in-window race; when the owner picks held and then planned on the board; then the
  // last pick ends linked on planned and quiet syncs keep it linked.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await racedWithInWindowMember(env, card, thread);
  await env.run();
  env.clock.advance(60 * 1_000);
  await boardPick(env, card, 'held');
  await env.run();
  env.clock.advance(60 * 1_000);
  await boardPick(env, card, 'planned');
  await env.run();
  const resolved = await env.card(card.id);
  assert.equal(resolved.discordState, 'linked');
  assert.equal(resolved.status, 'planned');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.planned]);
  const writes = env.mutations().length;
  for (let index = 0; index < 4; index += 1) {
    env.clock.advance(10 * 60 * 1_000);
    await env.run();
  }
  assert.equal((await env.card(card.id)).discordState, 'linked', 'stays linked');
  assert.equal(env.mutations().length, writes, 'quiet syncs make no Discord write');
});

async function zeroOrTwoTagMemberRace(env, card, thread, appliedTags) {
  const memberId = '999999999999999999';
  await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const pending = env.run();
  await hold.arrived;
  env.clock.advance(300);
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.clock.advance(300);
  hold.release();
  await pending;
  env.clock.advance(60 * 1_000);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags, userId: memberId });
  env.fake.hooks.releaseAuditVisibility();
  env.clock.advance(6 * 60 * 1_000);
  await env.run();
}

test('Test_Sync_a_zero_tag_thread_after_a_raced_write_stays_invalid_without_churn', async () => {
  // Given a raced done write whose thread a member then leaves with no status tag; when synced
  // and quiet syncs run; then the card stays invalid, no Discord write is made, and the card log is flat.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await zeroOrTwoTagMemberRace(env, card, thread, []);
  const first = await env.card(card.id);
  assert.equal(first.discordState, 'invalid');
  const writes = env.mutations().length;
  const logLength = first.log.length;
  for (let index = 0; index < 4; index += 1) {
    env.clock.advance(10 * 60 * 1_000);
    await env.run();
  }
  const end = await env.card(card.id);
  assert.equal(end.discordState, 'invalid');
  assert.equal(end.log.length, logLength, 'quiet syncs add no card-log event');
  assert.equal(env.mutations().length, writes, 'quiet syncs make no Discord write');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, []);
});

test('Test_Sync_a_two_tag_thread_after_a_raced_write_stays_invalid_without_churn', async () => {
  // Given a raced done write whose thread a member then tags with two status tags; when synced and
  // quiet syncs run; then the card stays invalid, no Discord write is made, and the card log is flat.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await zeroOrTwoTagMemberRace(env, card, thread, [env.tags.planned, env.tags.idea]);
  const first = await env.card(card.id);
  assert.equal(first.discordState, 'invalid');
  const writes = env.mutations().length;
  const logLength = first.log.length;
  for (let index = 0; index < 4; index += 1) {
    env.clock.advance(10 * 60 * 1_000);
    await env.run();
  }
  const end = await env.card(card.id);
  assert.equal(end.discordState, 'invalid');
  assert.equal(end.log.length, logLength, 'quiet syncs add no card-log event');
  assert.equal(env.mutations().length, writes, 'quiet syncs make no Discord write');
});

test('Test_Sync_a_domain_miss_write_expires_after_45_days_with_a_current_audit', async () => {
  // Given a member's change recorded as a conflict over our raced write; when another card's push keeps
  // the audit cursor current and 46 days pass; then the raced write is retired with an audit-expired
  // receipt instead of being kept forever.
  const memberId = '999999999999999999';
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const pending = env.run();
  await hold.arrived;
  env.clock.advance(300);
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.clock.advance(300);
  hold.release();
  await pending;
  env.fake.hooks.releaseAuditVisibility();
  env.clock.advance(60 * 1_000);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.planned], userId: memberId });
  env.clock.advance(6 * 60 * 1_000);
  await env.run();
  const key = env.readState().recentWrites[0].key;
  const other = await env.newCard({ title: '다른 카드' });
  const otherThread = env.seedThread({ name: other.title, appliedTags: [env.tags.idea], content: other.original });
  await linkCard(env, other, otherThread);
  await env.run();
  env.clock.advance(45 * 24 * 60 * 60 * 1_000 - 60 * 60 * 1_000);
  await boardPick(env, other, 'done');
  await env.run();
  await env.run();
  env.clock.advance(3 * 60 * 60 * 1_000);
  await env.run();
  assert.equal(env.readState().recentWrites.some((write) => write.key === key), false, 'the raced write is retired');
  assert.ok(receiptEvents(env).some((event) => event.event === 'audit-expired' && event.id === card.id));
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

test('Test_Sync_never_posts_a_dropped_card_with_no_thread', async () => {
  // Given a never-posted card dropped before sync with no pending create; when synced; then no post.
  const env = await setup();
  const card = await env.newCard({ original: '드롭된 카드 원문' });
  const dropped = await env.updateCard(card.id, (current) => ({ ...current, status: 'dropped' }), {
    actor: 'owner', via: 'board', change: 'status', from: card.status, to: 'dropped', reason: 'owner-board',
  });
  assert.equal(dropped.status, 'dropped');
  assert.equal(dropped.discordState, 'none');
  assert.ok(!dropped.discordThread);
  assert.equal(env.readState().pending.length, 0);
  const before = await env.card(card.id);

  const result = await env.run();
  const after = await env.card(card.id);
  assert.equal(result.ok, true);
  assert.equal(result.actions.posted, 0);
  assert.equal(env.posts().length, 0);
  assert.equal(after.status, 'dropped');
  assert.equal(after.discordState, 'none');
  assert.ok(!after.discordThread);
  assert.equal(after.original, before.original);
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

// N4: an owner entry and an unknown actor's entry both sit in the audit window (plan line 70:
// unknown actor -> conflict; line 73: owner entry in the window -> visible conflict, no silent loss).
// A stranger value set inside the window before our PATCH lands is overwritten by that PATCH, so
// the stranger's value is shown only when it is set just after the PATCH, still inside the window.
const MEMBER_ID = '999999999999999999';
async function racedWithStrangerAfterPatch(env, card, thread, strangerTags) {
  await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const pending = env.run();
  await hold.arrived;
  env.clock.advance(300);
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.clock.advance(300);
  hold.release();
  await pending;
  env.clock.advance(400);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: strangerTags(env), userId: MEMBER_ID });
  env.fake.hooks.releaseAuditVisibility();
  env.clock.advance(6 * 60 * 1_000);
}

test('Test_Sync_an_unknown_actor_beside_a_raced_owner_tag_becomes_a_visible_conflict', async () => {
  // Given a done PATCH raced by the owner's held and a non-owner's planned inside the audit window;
  // when the audit is visible; then the card is in conflict with the owner's held as a candidate,
  // and the thread keeps the PATCH value with no write over it.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await racedWithInWindowMember(env, card, thread);
  await env.run();
  const conflicted = await env.card(card.id);
  assert.equal(conflicted.discordState, 'conflict');
  assert.ok(conflicted.conflictDiscord.includes('held'), 'owner held is a candidate');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.done]);
});

test('Test_Sync_an_unknown_race_conflict_is_idempotent_over_quiet_syncs', async () => {
  // Given the conflict from the in-window race; when four quiet syncs run; then the card log,
  // the candidates and the Discord state do not change.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await racedWithInWindowMember(env, card, thread);
  await env.run();
  const before = await env.card(card.id);
  const writes = env.mutations().length;
  for (let index = 0; index < 4; index += 1) {
    env.clock.advance(10 * 60 * 1_000);
    await env.run();
  }
  const after = await env.card(card.id);
  assert.equal(after.discordState, 'conflict');
  assert.deepEqual(after.conflictDiscord, before.conflictDiscord, 'candidates unchanged');
  assert.equal(after.log.length, before.log.length, 'quiet syncs add no card-log event');
  assert.equal(env.mutations().length, writes, 'quiet syncs make no Discord write');
});

test('Test_Sync_board_picks_after_an_unknown_race_conflict_end_linked_across_quiet_syncs', async () => {
  // Given the conflict from the in-window race; when the owner picks held and then planned on the
  // board; then each pick ends the conflict and four quiet syncs keep the card linked on planned.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await racedWithInWindowMember(env, card, thread);
  await env.run();
  env.clock.advance(60 * 1_000);
  await boardPick(env, card, 'held');
  await env.run();
  const held = await env.card(card.id);
  assert.equal(held.discordState, 'linked');
  assert.equal(held.status, 'held');
  env.clock.advance(60 * 1_000);
  await boardPick(env, card, 'planned');
  await env.run();
  const resolved = await env.card(card.id);
  assert.equal(resolved.discordState, 'linked');
  assert.equal(resolved.status, 'planned');
  assert.deepEqual((await env.plainClient.getThread(thread.id)).data.applied_tags, [env.tags.planned]);
  const writes = env.mutations().length;
  const logLength = resolved.log.length;
  for (let index = 0; index < 4; index += 1) {
    env.clock.advance(10 * 60 * 1_000);
    await env.run();
    assert.equal((await env.card(card.id)).discordState, 'linked', 'stays linked');
  }
  const end = await env.card(card.id);
  assert.equal(end.log.length, logLength, 'quiet syncs add no card-log event');
  assert.equal(env.mutations().length, writes, 'quiet syncs make no Discord write');
});

test('Test_Sync_an_unknown_value_set_after_the_patch_becomes_a_conflict_candidate', async () => {
  // Given our PATCH, then the owner's held and a non-owner's planned set just after it inside the
  // window; when the audit is visible and four quiet syncs run; then the card is in conflict with
  // both values as candidates, no write goes over the thread, and the conflict stays stable.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await racedWithStrangerAfterPatch(env, card, thread, (e) => [e.tags.planned]);
  await env.run();
  const first = await env.card(card.id);
  assert.equal(first.discordState, 'conflict');
  assert.ok(first.conflictDiscord.includes('held'), 'owner held is a candidate');
  assert.ok(first.conflictDiscord.includes('planned'), 'unknown actor value is a candidate');
  const writes = env.mutations().length;
  for (let index = 0; index < 4; index += 1) {
    env.clock.advance(10 * 60 * 1_000);
    await env.run();
  }
  const end = await env.card(card.id);
  assert.deepEqual(end.conflictDiscord, first.conflictDiscord, 'candidates stable');
  assert.equal(end.log.length, first.log.length, 'quiet syncs add no card-log event');
  assert.equal(env.mutations().length, writes, 'quiet syncs make no Discord write');
});

test('Test_Sync_an_unknown_zero_tag_after_the_patch_stays_invalid_without_writes', async () => {
  // Given our PATCH, then a non-owner removes every status tag inside the window; when four quiet
  // syncs run; then reconcile marks the card invalid, the card log stays flat and nothing writes.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await racedWithStrangerAfterPatch(env, card, thread, () => []);
  await env.run();
  const first = await env.card(card.id);
  assert.equal(first.discordState, 'invalid');
  const writes = env.mutations().length;
  for (let index = 0; index < 4; index += 1) {
    env.clock.advance(10 * 60 * 1_000);
    await env.run();
  }
  const end = await env.card(card.id);
  assert.equal(end.discordState, 'invalid');
  assert.equal(end.log.length, first.log.length, 'flat card log');
  assert.equal(env.mutations().length, writes, 'no Discord write');
});

test('Test_Sync_an_unknown_two_tag_after_the_patch_stays_invalid_without_writes', async () => {
  // Given our PATCH, then a non-owner leaves two status tags inside the window; when four quiet
  // syncs run; then the card is invalid, the card log stays flat and nothing writes.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await racedWithStrangerAfterPatch(env, card, thread, (e) => [e.tags.planned, e.tags.done]);
  await env.run();
  const first = await env.card(card.id);
  assert.equal(first.discordState, 'invalid');
  const writes = env.mutations().length;
  for (let index = 0; index < 4; index += 1) {
    env.clock.advance(10 * 60 * 1_000);
    await env.run();
  }
  const end = await env.card(card.id);
  assert.equal(end.discordState, 'invalid');
  assert.equal(end.log.length, first.log.length, 'flat card log');
  assert.equal(env.mutations().length, writes, 'no Discord write');
});

test('Test_Sync_an_unknown_race_record_expires_after_45_days_without_losing_the_conflict', async () => {
  // Given the conflict from the in-window race; when 46 days pass; then the write record is retired
  // with an audit-expired receipt and the conflict with the owner value stays on the card.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await racedWithInWindowMember(env, card, thread);
  await env.run();
  env.clock.advance(46 * 24 * 60 * 60 * 1_000);
  await env.run();
  assert.equal(env.readState().recentWrites.length, 0);
  const expired = await env.card(card.id);
  assert.equal(expired.discordState, 'conflict');
  assert.ok(expired.conflictDiscord.includes('held'));
  assert.ok(receiptEvents(env).some((line) => line.event === 'audit-expired'), 'expiry receipt');
});

test('Test_Sync_a_later_non_owner_value_keeps_the_earlier_conflict_candidates', async () => {
  // Given the conflict from an owner value and a non-owner value set after the PATCH; when a further
  // non-owner value lands on the thread after the window; then both earlier candidates stay on the
  // conflict, the new value is added, and no write goes over the thread.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await racedWithStrangerAfterPatch(env, card, thread, (e) => [e.tags.planned]);
  await env.run();
  const first = await env.card(card.id);
  const writes = env.mutations().length;
  env.clock.advance(60 * 1_000);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.idea], userId: MEMBER_ID });
  env.clock.advance(10 * 60 * 1_000);
  await env.run();
  const later = await env.card(card.id);
  for (const value of first.conflictDiscord) {
    assert.ok(later.conflictDiscord.includes(value), `${value} kept as a candidate`);
  }
  assert.ok(later.conflictDiscord.includes('idea'), 'new non-owner value is a candidate');
  assert.equal(env.mutations().length, writes, 'no Discord write');
});

test('Test_Sync_an_unknown_actor_with_a_later_owner_pick_is_superseded_by_the_audit', async () => {
  // Given an owner held and a non-owner planned inside the window, then a later owner pick visible
  // after the window; when the audit is visible; then the raced write is retired as superseded by
  // the later owner entry (plan IS-2: the later owner change wins) and is not kept as a conflict.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const pending = env.run();
  await hold.arrived;
  env.clock.advance(300);
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.planned], userId: MEMBER_ID });
  env.clock.advance(300);
  hold.release();
  await pending;
  env.clock.advance(2_000);
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.planned] });
  env.fake.hooks.releaseAuditVisibility();
  env.clock.advance(6 * 60 * 1_000);
  await env.run();
  assert.ok(receiptEvents(env).some((line) => line.event === 'recent-write-superseded' && line.source === 'audit'),
    'superseded by the later owner entry');
  assert.equal(env.readState().recentWrites.length, 0);
});

test('Test_Sync_an_unknown_only_window_entry_keeps_the_uncertain_receipt', async () => {
  // Given a non-owner's planned inside the audit window and no owner entry; when the audit is
  // visible; then the verify step keeps the write and records the uncertain receipt, with no restore.
  const env = await setup();
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await linkCard(env, card, thread);
  await env.run();
  await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const pending = env.run();
  await hold.arrived;
  env.clock.advance(300);
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.planned], userId: MEMBER_ID });
  env.clock.advance(300);
  hold.release();
  await pending;
  env.fake.hooks.releaseAuditVisibility();
  env.clock.advance(6 * 60 * 1_000);
  await env.run();
  assert.ok(receiptEvents(env).some((line) => line.event === 'recent-write-uncertain' && line.code === 'unknown-actor'),
    'uncertain receipt for the unknown-only window');
  assert.equal(env.readState().recentWrites.length, 1);
});

// N-Q5: an owner board pick that races a visible owner phone tag must not be re-applied by a
// quiet sync later (no new owner-ordered event). The restored owner value stays on the thread.
const NQ5_MEMBER = '999999999999999999';
const nq5Iso = (ms) => new Date(ms).toISOString();

async function nq5Linked(env) {
  const card = await env.newCard();
  const thread = env.seedThread({ name: card.title, appliedTags: [env.tags.idea], content: card.original });
  await env.updateCard(card.id, (current) => ({
    ...current, discordChannel: env.forumId, discordThread: thread.id,
    discordBase: 'idea', discordState: 'linked',
  }), { actor: 'memento', via: 'sync', change: 'link', reason: 'fixture-link' });
  const state = env.readState();
  await env.store.writeSyncState({
    ...state, bases: { ...(state.bases ?? {}), [card.id]: nq5Iso(env.clock.now() - 1_000) },
  });
  await env.run();
  return { card, thread };
}

async function nq5Snap(env, card, thread) {
  const c = await env.card(card.id);
  const got = await env.plainClient.getThread(thread.id);
  return {
    status: c.status,
    state: c.discordState,
    cand: c.conflictDiscord ?? null,
    remote: got.ok ? Object.entries(env.tags)
      .filter(([, id]) => got.data.applied_tags.includes(id)).map(([key]) => key) : null,
    mut: env.mutations().length,
    log: c.log.length,
  };
}

// Same race as the N4 gate: the owner's held and a member's planned land while our PATCH is in flight
// and the audit is hidden; the next sync sees them and records the conflict.
async function nq5Race(env, card, thread) {
  await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const pending = env.run();
  await hold.arrived;
  env.clock.advance(300);
  env.fake.hooks.delayAuditVisibility();
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.held] });
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.planned], userId: NQ5_MEMBER });
  env.clock.advance(300);
  hold.release();
  await pending;
  env.fake.hooks.releaseAuditVisibility();
}

// Conflict, then an owner board pick whose PATCH is raced by an owner phone tag (building);
// the sync restores building and records the owner-race conflict.
async function nq5RestoredRace(env, card, thread) {
  await nq5Race(env, card, thread);
  env.clock.advance(6 * 60 * 1_000);
  await env.run();
  env.clock.advance(60 * 1_000);
  await boardPick(env, card, 'done');
  const hold = env.fake.hooks.holdNext({ method: 'PATCH', path: `/channels/${thread.id}` });
  const pending = env.run();
  await hold.arrived;
  env.fake.hooks.ownerSetTags({ threadId: thread.id, appliedTags: [env.tags.building] });
  hold.release();
  await pending;
  return nq5Snap(env, card, thread);
}

async function nq5Quiet(env, card, thread, n = 4) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    env.clock.advance(10 * 60 * 1_000);
    await env.run();
    rows.push(await nq5Snap(env, card, thread));
  }
  return rows;
}

test('NQ5_restored_owner_phone_value_survives_quiet_syncs', async () => {
  const env = await setup();
  const { card, thread } = await nq5Linked(env);
  const restored = await nq5RestoredRace(env, card, thread);
  assert.equal(restored.state, 'conflict');
  assert.ok(restored.cand.includes('building'), 'owner phone value is a visible candidate');
  assert.deepEqual(restored.remote, ['building'], 'owner value restored on the thread');
  const rows = await nq5Quiet(env, card, thread);
  // The first sync after the race sees the owner's phone change in the audit and adopts it once
  // (one owner-remote event, no PATCH); every later quiet sync is flat.
  assert.equal(rows[0].status, 'building', 'owner phone value adopted, not overwritten');
  assert.equal(rows[0].log, restored.log + 1, 'exactly one adoption event');
  for (const row of rows) {
    assert.deepEqual(row.remote, ['building'], 'quiet sync must not overwrite the owner phone value');
    assert.equal(row.mut, restored.mut, 'quiet sync makes no PATCH');
  }
  for (const row of rows.slice(1)) {
    assert.equal(row.log, rows[0].log, 'quiet sync adds no card-log event');
  }
});

test('NQ5_later_owner_pick_after_race_wins_and_stays_linked', async () => {
  const env = await setup();
  const { card, thread } = await nq5Linked(env);
  const restored = await nq5RestoredRace(env, card, thread);
  assert.equal(restored.state, 'conflict');
  env.clock.advance(60 * 1_000);
  await boardPick(env, card, 'held');
  await env.run();
  const picked = await nq5Snap(env, card, thread);
  assert.equal(picked.state, 'linked', 'a genuine later owner pick ends the conflict');
  assert.deepEqual(picked.remote, ['held'], 'the later pick is written to the thread');
  const rows = await nq5Quiet(env, card, thread);
  for (const row of rows) {
    assert.equal(row.state, 'linked', 'stays linked on quiet syncs');
    assert.deepEqual(row.remote, ['held']);
    assert.equal(row.mut, picked.mut, 'quiet sync makes no PATCH');
    assert.equal(row.log, picked.log, 'quiet sync adds no card-log event');
  }
});
