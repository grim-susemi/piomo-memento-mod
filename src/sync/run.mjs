import { createHash, randomUUID } from 'node:crypto';
import { openStore } from '../store/store.mjs';
import {
  STALE_MS,
  acquire,
  clearRerunFlag,
  hasRerunFlag,
  release,
} from '../store/lock.mjs';
import { createDiscordClient, snowflakeTime, withStatusTag } from '../discord/client.mjs';
import { findSecret } from '../card/secrets.mjs';
import { idForThread } from '../card/id.mjs';
import { normalizeIntake } from '../card/codec.mjs';
import { isStatus } from '../card/status.mjs';
import { reconcile } from './reconcile.mjs';
import { mergeSyncState } from './state-tx.mjs';
import {
  auditEntriesFor,
  boardEventsOf,
  composePostContent,
  conflictBoundary,
  descriptionFrom,
  extractPostOriginal,
  findMarker,
  markerLine,
  singleStatus,
  statusesOf,
  statusTagIds,
  titleFrom,
  uncertaintyFor,
} from './threads.mjs';

export const BUDGETS = Object.freeze({ totalMs: 60_000, discordMs: 40_000, pushMs: 15_000 });
export const AUDIT_RETENTION_MS = 45 * 24 * 60 * 60 * 1_000;
export const VERIFY_MIN_MS = 5 * 60 * 1_000;
export const RESTORE_SCHEMA = 'memento.restore.v1';
export const STARTER_WINDOW = 100;
export const DISCONNECT_NOTICE = '메멘토: 디스코드에 연결하지 못했어요. 다음 세션에서 다시 맞춥니다';
const DEADLINE_NOTICE = '메멘토: 디스코드 응답이 늦어 이번 동기화를 줄였어요';
const CARD_ID = /^\d{8}-[a-z2-7]{4}$/;

const iso = (ms) => new Date(ms).toISOString();
const titleHash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function deadlineFailure() {
  return {
    ok: false, status: null, data: null, headers: {}, date: null,
    sentAt: null, receivedAt: null, error: 'timeout', message: 'deadline', attempts: 0,
  };
}

/** One bounded Discord deadline; the timer is unref'd and cleared by dispose(). */
function createDeadline(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(ms) || 1));
  timer.unref?.();
  let disposed = false;
  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
    },
  };
}

/** Every client method carries the shared deadline signal and is clock-gated. */
function gateClient(client, { now, deadline, signal, deadlineSignal, onBudget }) {
  if (!client) return client;
  const wrapped = {};
  for (const [name, value] of Object.entries(client)) {
    if (typeof value !== 'function') {
      wrapped[name] = value;
      continue;
    }
    wrapped[name] = async (...args) => {
      if (signal?.aborted) return deadlineFailure();
      if (now() >= deadline) {
        onBudget();
        return deadlineFailure();
      }
      const last = args.length > 0 ? args[args.length - 1] : undefined;
      if (last && typeof last === 'object' && !Array.isArray(last)) {
        args[args.length - 1] = { ...last, ...(deadlineSignal ? { deadlineSignal } : {}) };
      } else {
        args.push(deadlineSignal ? { deadlineSignal } : {});
      }
      const result = await value(...args);
      if (now() >= deadline) onBudget();
      return result;
    };
  }
  return wrapped;
}

/**
 * Dry-run client: reads are forwarded unchanged; every Discord write is answered
 * with the success envelope the planner already handles. The synthetic create id
 * never reaches a card, so the same sync flow computes the would-be actions while
 * the repo, git and Discord stay untouched.
 */
function guardReadOnlyClient(client) {
  if (!client) return client;
  let synthetic = 0;
  const simulated = (data) => ({
    ok: true, status: 200, data, headers: {}, date: null,
    sentAt: null, receivedAt: null, attempts: 0,
  });
  return {
    ...client,
    patchThreadTags: async (params) => simulated({ applied_tags: [...(params?.appliedTags ?? [])] }),
    createForumPost: async () => simulated({ id: `dry-run-${(synthetic += 1)}` }),
    archiveThread: async () => simulated({}),
    deleteThread: async () => simulated({}),
  };
}


function emptyActions() {
  return {
    imported: 0,
    adopted: 0,
    adoptedIds: [],
    linked: 0,
    posted: 0,
    pushed: 0,
    taken: 0,
    base: 0,
    conflicts: 0,
    invalid: 0,
    deleted: 0,
    edits: 0,
    skippedSecrets: 0,
    ignoredAuthors: 0,
    ignoredForeign: 0,
    cardUnreadable: 0,
    expired: 0,
    failures: 0,
  };
}

function record(receipts, entry) {
  receipts?.append(entry);
}

function notifyLine(actions) {
  const parts = [];
  const add = (count, text) => {
    if (count > 0) parts.push(`${text} ${count}`);
  };
  add(actions.imported, '카드 추가');
  if (actions.adoptedIds.length > 0) parts.push(`카드 복원 ${actions.adoptedIds.join(', ')}`);
  else add(actions.adopted, '카드 복원');
  add(actions.posted, '글 게시');
  add(actions.pushed, '상태 반영');
  add(actions.taken, '상태 가져옴');
  add(actions.linked, '연결');
  add(actions.conflicts, '충돌');
  add(actions.invalid, '태그 이상');
  add(actions.deleted, '삭제된 글');
  add(actions.edits, '원문 갱신');
  add(actions.skippedSecrets, '비밀값 건너뜀');
  add(actions.ignoredAuthors, '다른 작성자 무시');
  add(actions.cardUnreadable, '읽을 수 없는 카드');
  add(actions.expired, '감사 만료');
  add(actions.failures, '실패');
  return parts.length > 0 ? `메멘토: ${parts.join(' · ')}` : null;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function networkFailure(envelope) {
  return !envelope?.ok && (envelope?.status === null || envelope?.status === undefined
    || ['network', 'timeout', 'aborted'].includes(envelope?.error));
}

/**
 * One session-start sync. Never throws for expected failures; the caller gets a
 * result object and the lock, sockets and state are released in finally paths.
 */
export async function runSync(options = {}) {
  const reason = options.reason ?? 'startup';
  const now = options.now ?? Date.now;
  const startedAt = now();
  const config = options.config;
  const dryRun = options.dryRun === true;
  const receipts = dryRun ? null : options.receipts;
  const signal = options.signal;
  const dryResult = (result) => (dryRun
    ? {
      ...result,
      dryRun: true,
      complete: false,
      incomplete: [result.skipped ?? result.reason ?? 'unavailable'],
    }
    : result);
  if (!config || config.state !== 'configured') {
    record(receipts, { event: 'sync-skipped', reason: 'unconfigured' });
    return dryResult({
      ok: false, reason, skipped: 'unconfigured', actions: emptyActions(), runs: 0,
      discord: 'unconfigured', push: 'skipped', notify: null, waitingForPush: false,
    });
  }
  const store = options.store ?? openStore(config.repoPath, { now });
  const budget = { ...BUDGETS, ...(options.budget ?? {}) };
  const deadlines = { total: startedAt + budget.totalMs, discord: startedAt + budget.discordMs };
  const preflight = await store.readSyncState();
  if (!preflight.ok) {
    record(receipts, { event: 'sync-skipped', reason: 'repo-uninitialized', code: preflight.code });
    return dryResult({
      ok: false, reason, skipped: 'repo-uninitialized', actions: emptyActions(), runs: 0,
      discord: 'skipped', push: 'skipped', notify: null, waitingForPush: false,
    });
  }
  const context = {
    reason, now, config, store, receipts, signal, budget, deadlines,
    ctx: options.ctx,
    client: options.client,
    hooks: dryRun ? {} : (options.hooks ?? {}),
    emptySyncState: options.emptySyncState,
    dryRun,
  };

  if (dryRun) {
    const discordDeadline = createDeadline(Math.max(1, Math.min(budget.discordMs, deadlines.discord - now())));
    const dryRunIncomplete = [];
    let result;
    try {
      result = await runPass({ ...context, discordDeadline, dryRunIncomplete });
    } finally {
      discordDeadline.dispose();
    }
    const listed = await store.list();
    return {
      ...result,
      runs: 1,
      dryRun: true,
      complete: result.ok === true && result.discord === 'ok' && dryRunIncomplete.length === 0,
      incomplete: [...dryRunIncomplete],
      inspected: {
        cards: listed.cards.length,
        linked: listed.cards.filter((card) => typeof card.discordThread === 'string'
          && card.discordThread.length > 0).length,
      },
    };
  }

  let runs = 0;
  let last = null;
  for (let pass = 0; pass < 2; pass += 1) {
    const lock = await acquire(config.repoPath, 'sync', {
      waitMs: 0,
      now,
      staleMs: STALE_MS,
      ...(typeof config.sessionId === 'string' ? { sessionId: config.sessionId } : {}),
    });
    if (!lock.ok) {
      if (runs === 0) {
        return {
          ok: true, reason, skipped: 'busy', rerun: Boolean(lock.rerun),
          actions: emptyActions(), runs: 0, discord: 'skipped', push: 'skipped',
          notify: null, waitingForPush: false,
        };
      }
      break;
    }
    runs += 1;
    const discordDeadline = createDeadline(Math.max(1, Math.min(budget.discordMs, deadlines.discord - now())));
    try {
      last = await runPass({ ...context, discordDeadline });
    } finally {
      discordDeadline.dispose();
      await release(lock);
    }
    if (signal?.aborted) break;
    if (pass === 0 && await hasRerunFlag(config.repoPath)) {
      await clearRerunFlag(config.repoPath);
      continue;
    }
    break;
  }
  return { ...last, runs };
}

async function runPass(context) {
  const {
    reason, now, config, store, receipts, signal, budget, deadlines, ctx, hooks, discordDeadline,
    dryRun, dryRunIncomplete,
  } = context;
  const actions = emptyActions();
  record(receipts, { event: 'sync-start', reason });

  const loaded = await store.readSyncState();
  if (!loaded.ok) {
    record(receipts, { event: 'sync-skipped', reason: 'repo-uninitialized', code: loaded.code });
    return {
      ok: false, reason, skipped: 'repo-uninitialized', actions, runs: 1,
      discord: 'skipped', push: 'skipped', notify: null, waitingForPush: false,
    };
  }
  const state = loaded.state;
  state.bases = { ...(state.bases ?? {}) };
  state.starterCursor = Number.isInteger(state.starterCursor) ? state.starterCursor : 0;
  state.nameSeen = { ...(state.nameSeen ?? {}) };
  state.quarantine = [...(state.quarantine ?? [])];
  state.restoreContract = RESTORE_SCHEMA;
  const stateSnapshot = structuredClone(state);
  let baseline = stateSnapshot;
  const transactState = async () => {
    if (dryRun) return { ok: true, state: structuredClone(state) };
    const result = await store.transactSyncState(
      (latest) => mergeSyncState(baseline, state, latest),
      { waitMs: 1_000, message: 'memento: sync state\n' },
    );
    if (result.ok) {
      for (const key of Object.keys(result.state)) state[key] = result.state[key];
      baseline = structuredClone(state);
    }
    return result;
  };
  const listed = await store.list();
  actions.cardUnreadable = listed.unreadable.length;
  const cards = new Map(listed.cards.map((card) => [card.id, card]));
  for (const unreadable of listed.unreadable) {
    record(receipts, { event: 'card-unreadable', file: unreadable.file, reason: unreadable.reason });
  }

  let client = context.client;
  let budgetHit = false;
  const samples = [];
  const measure = (envelope) => {
    if (!envelope?.ok || !Number.isFinite(envelope.date)
      || !Number.isFinite(envelope.sentAt) || !Number.isFinite(envelope.receivedAt)) return;
    const rtt = Math.max(0, envelope.receivedAt - envelope.sentAt);
    samples.push({
      offsetMs: Math.round(envelope.date + 500 + rtt / 2 - envelope.receivedAt),
      rttMs: rtt,
    });
  };
  const discordOpen = () => !signal?.aborted && now() < deadlines.discord;
  const touchBudget = () => {
    if (!discordOpen()) budgetHit = true;
    return discordOpen();
  };

  const pushNow = async (label) => {
    if (dryRun) return config.remote ? 'dry-run' : 'no-remote';
    if (!config.remote) {
      record(receipts, { event: 'push-skipped', label, reason: 'no-remote' });
      return 'no-remote';
    }
    if (signal?.aborted) return 'aborted';
    const remaining = Math.min(budget.pushMs, deadlines.total - now());
    if (remaining <= 0) return 'skipped';
    const result = await store.push({ timeoutMs: Math.max(1, remaining), signal });
    if (!result.ok) {
      record(receipts, { event: 'push-failed', label, code: result.code ?? 'PUSH_FAILED' });
      return 'failed';
    }
    return result.skipped === 'no-remote' ? 'no-remote' : 'ok';
  };

  const finalize = async (result) => {
    await hooks.barrier?.('before-final-state-write');
    const write = await transactState();
    if (!write.ok) {
      result.stateWrite = write.code ?? 'failed';
      actions.failures += 1;
      record(receipts, { event: 'state-write-failed', code: write.code ?? 'failed' });
    }
    if (signal?.aborted) {
      record(receipts, { event: 'sync-aborted', reason, pending: state.pending.length });
      return { ...result, ok: false, aborted: true, push: 'aborted', actions };
    }
    await hooks.barrier?.('before-final-push');
    const push = await pushNow('final');
    const notify = result.notify ?? notifyLine(actions);
    record(receipts, {
      event: 'sync-complete',
      reason,
      discord: result.discord,
      push,
      actions,
      pending: state.pending.length,
      recentWrites: state.recentWrites.length,
    });
    if (notify) ctx?.ui?.notify?.(notify, result.notifyLevel ?? 'info');
    return { ...result, ok: result.ok !== false, push, notify, actions };
  };

  if (!state.guildId || !state.forumId || Object.keys(state.tagIds ?? {}).length === 0) {
    record(receipts, { event: 'sync-skipped', reason: 'discord-unconfigured' });
    return finalize({
      ok: true, reason, discord: 'unconfigured', notify: null, waitingForPush: false,
    });
  }
  if (!client) {
    client = createDiscordClient({
      tokenFile: config.tokenFile,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      clock: { now },
    });
  }
  client = gateClient(client, {
    now,
    deadline: deadlines.discord,
    signal,
    deadlineSignal: discordDeadline?.signal,
    onBudget: () => { budgetHit = true; },
  });
  if (dryRun) client = guardReadOnlyClient(client);

  const me = await client.getMe({ signal });
  measure(me);
  if (!me.ok) {
    if (me.error === 'timeout' || budgetHit) {
      record(receipts, { event: 'discord-budget', phase: 'getMe' });
      return finalize({
        ok: true, reason, discord: 'budget', notify: DEADLINE_NOTICE,
        notifyLevel: 'warning', waitingForPush: false,
      });
    }
    record(receipts, {
      event: 'discord-unreachable',
      code: me.error ?? me.status ?? 'unknown',
    });
    return finalize({
      ok: true, reason, discord: 'unreachable', notify: DISCONNECT_NOTICE,
      notifyLevel: 'warning', waitingForPush: false,
    });
  }
  if (!state.botUserId && typeof me.data?.id === 'string') state.botUserId = me.data.id;
  if (!state.ownerUserId) {
    const guild = await client.getGuild(state.guildId, { signal });
    measure(guild);
    if (guild.ok && typeof guild.data?.owner_id === 'string') state.ownerUserId = guild.data.owner_id;
  }
  if (!state.botUserId || !state.ownerUserId) {
    record(receipts, { event: 'discord-identity-missing' });
    return finalize({
      ok: false, reason, discord: 'error', notify: '메멘토: 디스코드 사용자 정보를 확인하지 못했어요',
      notifyLevel: 'warning', waitingForPush: false,
    });
  }
  if (samples.length > 0) {
    state.clock = {
      offsetMs: median(samples.map((sample) => sample.offsetMs)),
      rttMs: median(samples.map((sample) => sample.rttMs)),
      dateSkewMs: median(samples.map((sample) => sample.offsetMs)),
      measuredAt: iso(now()),
    };
  }

  const active = await client.listActiveForumThreads(
    { guildId: state.guildId, forumId: state.forumId },
    { signal },
  );
  measure(active);
  if (!active.ok) {
    record(receipts, { event: 'thread-list-failed', code: active.error ?? active.status ?? 'unknown' });
    if (budgetHit) {
      return finalize({
        ok: true, reason, discord: 'budget', notify: DEADLINE_NOTICE,
        notifyLevel: 'warning', waitingForPush: false,
      });
    }
    if (networkFailure(active)) {
      return finalize({
        ok: true, reason, discord: 'unreachable', notify: DISCONNECT_NOTICE,
        notifyLevel: 'warning', waitingForPush: false,
      });
    }
    return finalize({
      ok: false, reason, discord: 'error',
      notify: '메멘토: 포럼 목록을 읽지 못했어요', notifyLevel: 'warning', waitingForPush: false,
    });
  }
  const archived = touchBudget()
    ? await client.listArchivedForumThreads(state.forumId, { signal })
    : null;
  measure(archived);
  // Dry run only: a missing archived listing can hide an orphan, a link or an edit,
  // so an authoritative zero is impossible. Live sync keeps its nonfatal policy.
  if (dryRun && (!archived || !archived.ok)) {
    dryRunIncomplete.push(`archived-list:${archived ? (archived.status ?? archived.error ?? 'unknown') : 'budget'}`);
  }
  const threads = new Map();
  for (const thread of active.data ?? []) threads.set(thread.id, thread);
  if (archived?.ok) for (const thread of archived.data ?? []) threads.set(thread.id, thread);
  else if (archived && !archived.ok) {
    record(receipts, { event: 'archived-list-failed', code: archived.error ?? archived.status ?? 'unknown' });
  }

  const starters = new Map();
  const starterFor = async (thread) => {
    if (!thread?.id) return null;
    if (starters.has(thread.id)) return starters.get(thread.id);
    if (!touchBudget()) return null;
    const result = await client.getStarterMessage(thread.id, { signal });
    measure(result);
    starters.set(thread.id, result);
    return result;
  };

  const linkedThreadIds = new Set();
  for (const card of cards.values()) if (card.discordThread) linkedThreadIds.add(card.discordThread);

  const audit = await ingestAudit({ client, state, now, signal, receipts, discordOpen: touchBudget });
  // A successful read with an aged cursor is a truthful partial window; only a
  // failed or skipped audit read makes the dry-run plan incomplete.
  if (dryRun && !audit.ok) {
    dryRunIncomplete.push(`audit-read:${audit.code ?? 'unknown'}`);
  }
  if (audit.fatal) {
    if (budgetHit) {
      return finalize({
        ok: true, reason, discord: 'budget', notify: DEADLINE_NOTICE,
        notifyLevel: 'warning', waitingForPush: false,
      });
    }
    return finalize({
      ok: true, reason, discord: 'unreachable', notify: DISCONNECT_NOTICE,
      notifyLevel: 'warning', waitingForPush: false,
    });
  }

  const mapTagEntry = (entry) => mapAuditEntry(entry, state);
  const entries = (audit.raw ?? []).map(mapTagEntry).filter(Boolean);

  const persistCard = async (card, mutate, log) => {
    if (dryRun) {
      const at = iso(now());
      const entries = (Array.isArray(log) ? log : [log])
        .filter((entry) => entry && typeof entry === 'object');
      const next = structuredClone(card);
      const mutated = mutate(next) ?? next;
      mutated.rev = card.rev + 1;
      mutated.updated = at;
      mutated.log = [
        ...(card.log ?? []),
        ...entries.map((entry) => ({ at, eventId: randomUUID(), ...entry })),
      ];
      cards.set(mutated.id, mutated);
      return mutated;
    }
    const result = await store.update(card.id, { expectRev: card.rev, mutate, log });
    if (!result.ok) {
      actions.failures += 1;
      record(receipts, { event: 'card-write-failed', id: card.id, code: result.code ?? 'failed' });
      return null;
    }
    cards.set(result.id, result.card);
    return result.card;
  };

  const applyConflict = async (card, statuses, reasonText, judgedPick = null, restartSince = false) => {
    const discord = [...new Set(statuses.filter(isStatus))];
    if (discord.length === 0) discord.push(card.status);
    if (judgedPick === null
      && card.discordState === 'conflict'
      && Array.isArray(card.conflictDiscord)
      && card.conflictDiscord.length === discord.length
      && card.conflictDiscord.every((value, index) => value === discord[index])) {
      return card;
    }
    // A judgement that named a resolving pick restarts the boundary: an owner entry older than the
    // judgement was hidden when it was made, so it must not look fresh later (plan lines 68/70/71).
    const since = card.discordState === 'conflict' && card.conflictSince && !restartSince
      ? card.conflictSince
      : iso(now());
    const updated = await persistCard(card, (next) => {
      next.discordState = 'conflict';
      next.conflictCard = next.status;
      next.conflictDiscord = discord;
      next.conflictSince = since;
    }, {
      actor: 'memento', via: 'sync', change: 'conflict', reason: reasonText,
      ...(judgedPick === null ? {} : { evidence: judgedPick }),
    });
    if (updated) actions.conflicts += 1;
    return updated ?? card;
  };

  const applyInvalid = async (card, statuses, judgedPick = null) => {
    if (card.discordState === 'invalid' && judgedPick === null) return card;
    const updated = await persistCard(card, (next) => {
      next.discordState = 'invalid';
      delete next.conflictCard;
      delete next.conflictDiscord;
      delete next.conflictSince;
    }, {
      actor: 'memento', via: 'sync', change: 'invalid-remote',
      reason: statuses.length === 0 ? 'no-status-tag' : 'multiple-status-tags',
      ...(judgedPick === null ? {} : { evidence: judgedPick }),
    });
    if (updated) actions.invalid += 1;
    return updated ?? card;
  };

  const applyDeleted = async (card) => {
    if (card.discordState === 'deleted') return card;
    const updated = await persistCard(card, (next) => {
      next.discordState = 'deleted';
      delete next.conflictCard;
      delete next.conflictDiscord;
      delete next.conflictSince;
    }, { actor: 'memento', via: 'sync', change: 'remote-deleted', reason: 'thread-missing' });
    if (updated) actions.deleted += 1;
    return updated ?? card;
  };

  const applyTake = async (card, status, evidence) => {
    const updated = await persistCard(card, (next) => {
      next.status = status;
      next.discordBase = status;
      next.discordState = 'linked';
      delete next.conflictCard;
      delete next.conflictDiscord;
      delete next.conflictSince;
    }, {
      actor: 'owner', via: 'discord', change: 'status',
      from: card.status, to: status, reason: 'owner-remote',
      ...(typeof evidence === 'string' ? { evidence } : {}),
    });
    if (updated) {
      state.bases[card.id] = iso(now());
      actions.taken += 1;
    }
    return updated ?? card;
  };

  const applyBase = async (card, status) => {
    state.bases[card.id] = iso(now());
    if (card.discordBase === status) return card;
    const updated = await persistCard(card, (next) => { next.discordBase = status; }, {
      actor: 'memento', via: 'sync', change: 'status',
      from: card.discordBase || card.status, to: status, reason: 'base-agreed',
    });
    if (updated) actions.base += 1;
    return updated ?? card;
  };

  // A resolving pick that a sync already judged is named by a conflict entry's evidence. Once
  // named it no longer resolves, so the same sync must not decide that card again (decidedPending).
  // Only conflict entries count; sync-push and board-push entries carry the same eventId.
  const RACE_REASONS = new Set(['owner-race', 'recent-write-owner-race']);
  const boardEventsFor = (card) => {
    const events = boardEventsOf(card, state, uncertaintyFor(state.clock));
    const last = events.at(-1);
    if (last?.resolves) {
      const named = card.log.some((entry) => entry.change === 'conflict' && entry.evidence === last.eventId);
      const pick = card.log.findLastIndex((entry) => entry.actor === 'owner' && entry.via === 'board');
      const raced = card.log.findLastIndex((entry) => entry.change === 'conflict' && RACE_REASONS.has(entry.reason));
      if (named || raced > pick) delete last.resolves;
    }
    return events;
  };
  const decide = (card, remoteStatuses, cardEntries) => {
    const since = conflictBoundary(card);
    const boardEvents = boardEventsFor(card);
    const decision = reconcile({
      card: {
        status: card.status,
        discordBase: card.discordBase,
        discordState: card.discordState,
        boardEvents,
        ...(since === null ? {} : { conflictSince: since }),
        conflictDiscord: card.conflictDiscord,
      },
      remote: { exists: true, statusTags: remoteStatuses },
      audit: { coverage: audit.coverage, entries: cardEntries },
    });
    const last = boardEvents.at(-1);
    return last?.resolves ? { ...decision, pick: last.eventId } : decision;
  };
  const entriesForCard = (card, threadId) =>
    auditEntriesFor(entries, threadId, Date.parse(state.bases[card.id] ?? card.created));
  // An audit entry leaves the carry only when a judgment on its thread lands from a complete read. Entries
  // the cursor has moved past but no landed judgment consumed (budget cut, failed fetch or write, failed or
  // skipped audit read) wait for a later sync. A failed or skipped read judges its carried entries under
  // partial coverage with no pick named, so that judgment cannot consume them.
  const settleAudit = (threadId) => {
    if (!audit.ok) return;
    state.audit.carry = (state.audit.carry ?? []).filter((entry) => entry.target_id !== threadId);
  };
  const settleIfLanded = async (threadId, work) => {
    const failures = actions.failures;
    const result = await work();
    if (actions.failures === failures) settleAudit(threadId);
    return result;
  };

  // A card already in conflict keeps its candidates (e.g. a raced owner value); reconcile adds the
  // remote values to them instead of replacing them, so no owner value drops out silently.
  const conflictCandidates = (card, statuses) => card.discordState === 'conflict'
    && Array.isArray(card.conflictDiscord)
    ? [...card.conflictDiscord, ...statuses]
    : statuses;
  // The audit delta reaches reconcile once (ingestAudit moves the cursor). When a decision on a
  // successfully read delta neither pushes nor takes a resolving pick, the pick is judged now. A
  // failed or skipped read names no pick; its carried entries stay carried until a complete read.
  const judgedPickOf = (decision) => {
    if (!decision.pick || !audit.ok) return null;
    const { boardInterval, ownerInterval } = decision.evidence ?? {};
    // Two owner values in one millisecond, both provably before the pick: the pick wins (plan line 66).
    if (decision.reason === 'ambiguous-owner-order' && boardInterval && ownerInterval
      && boardInterval[0] > ownerInterval[1]) return null;
    return decision.pick;
  };
  const applyDecision = async (card, decision, remoteStatuses) => {
    if (decision.kind === 'setBase') return applyBase(card, decision.status);
    if (decision.kind === 'take') {
      // An owner entry later than the pick left 0 or 2+ status tags: nothing valid to take, and the
      // older pick must not win (plan line 60).
      if (!isStatus(decision.status)) {
        const judged = judgedPickOf(decision);
        return card.discordState === 'conflict'
          ? applyConflict(card, conflictCandidates(card, remoteStatuses), 'conflict-remote-invalid', judged)
          : applyInvalid(card, remoteStatuses, judged);
      }
      return applyTake(card, decision.status, decision.evidence?.ownerEntryId ?? null);
    }
    if (decision.kind === 'markDeleted') return applyDeleted(card);
    if (decision.kind === 'invalidRemote') {
      if (card.discordState === 'conflict') {
        return applyConflict(card, conflictCandidates(card, remoteStatuses), 'conflict-remote-invalid', judgedPickOf(decision));
      }
      return applyInvalid(card, remoteStatuses, judgedPickOf(decision));
    }
    if (decision.kind === 'conflict') {
      if (card.discordState === 'conflict' && decision.reason === 'unresolved-conflict') {
        return card;
      }
      const judged = judgedPickOf(decision);
      return applyConflict(card, conflictCandidates(card, remoteStatuses), decision.reason ?? 'conflict', judged, judged !== null && decision.reason === 'unexplained-remote');
    }
    return card;
  };

  const patchStatus = async ({
    card, thread, targetStatus, key, auditCursor, t0, fresh, knownEntryIds,
  }) => {
    const tagId = state.tagIds[targetStatus];
    if (!tagId) return { ok: false, reason: 'unknown-status-tag' };
    let current = fresh;
    if (!current) {
      if (!touchBudget()) return { ok: false, reason: 'budget' };
      current = await client.getThread(thread.id, { signal });
      measure(current);
    }
    if (!current.ok) {
      if (current.gone) {
        await applyDeleted(card);
        return { ok: false, reason: 'remote-deleted' };
      }
      return { ok: false, reason: current.error ?? 'thread-read-failed' };
    }
    const statusIds = statusTagIds(state);
    const tags = withStatusTag(current.data?.applied_tags ?? [], statusIds, tagId);
    const patch = await client.patchThreadTags({
      threadId: thread.id,
      appliedTags: tags,
      auditReason: `memento-sync ${key}`,
      archived: Boolean(current.data?.thread_metadata?.archived),
    }, { signal });
    measure(patch);
    if (!patch.ok) {
      if (patch.gone) {
        await applyDeleted(card);
        return { ok: false, reason: 'remote-deleted' };
      }
      return { ok: false, reason: patch.error ?? 'patch-failed' };
    }
    const patchAt = now();
    const after = await client.getAuditLog({
      guildId: state.guildId, actionType: 111, after: auditCursor ?? '0', limit: 100,
    }, { signal });
    measure(after);
    const races = after.ok
      ? after.data
        .filter((entry) => entry.target_id === thread.id && entry.user_id === state.ownerUserId)
        .filter((entry) => !knownEntryIds?.has(entry.id))
        .map((entry) => mapAuditEntry(entry, state))
        .filter(Boolean)
        .filter((entry) => entry.time + 1_000 >= t0)
      : [];
    const own = after.ok
      ? after.data.find((entry) => entry.target_id === thread.id
        && entry.user_id === state.botUserId
        && entry.reason === `memento-sync ${key}`)
      : null;
    const ownTime = own ? snowflakeTime(own.id) : patchAt + 1_000;
    const ownerEntry = races
      .filter((entry) => entry.time <= ownTime + 1_000)
      .at(-1) ?? null;
    if (ownerEntry) {
      const ownerStatus = singleStatus(statusesOf(ownerEntry.toTags ?? [], state.tagIds));
      let restoreOk = false;
      let restoreCode = ownerStatus ? null : 'ambiguous-owner-tags';
      if (ownerStatus) {
        const restoreTags = withStatusTag(
          patch.data?.applied_tags ?? tags, statusIds, state.tagIds[ownerStatus],
        );
        const restored = await client.patchThreadTags({
          threadId: thread.id,
          appliedTags: restoreTags,
          auditReason: `memento-sync ${key} restore`,
          archived: false,
        }, { signal });
        measure(restored);
        restoreOk = restored.ok;
        if (!restored.ok) restoreCode = restored.status ?? restored.error ?? 'failed';
      }
      return {
        ok: false, reason: 'owner-race', ownerEntry, patchAt,
        pushedStatus: targetStatus, restoreOk, restoreCode,
      };
    }
    return {
      ok: true,
      patchAt,
      appliedTags: tags,
      ownEntryId: own?.id ?? null,
    };
  };

  const guardedPush = async (card, thread, auditCursor) => {
    const key = `sync-${card.id}-${randomUUID()}`;
    const t0 = now();
    const board = boardEventsOf(card, state, uncertaintyFor(state.clock)).at(-1) ?? null;
    const op = {
      kind: 'status', key, thread: thread.id, cardId: card.id, t0: iso(t0),
      ...(board?.eventId ? { eventId: board.eventId } : {}),
    };
    state.pending.push(op);
    const persisted = await transactState();
    if (!persisted.ok) {
      state.pending = state.pending.filter((entry) => entry.key !== op.key);
      return { ok: false, reason: persisted.code ?? 'state-write-failed' };
    }
    if (!touchBudget()) {
      record(receipts, { event: 'status-write-deferred', id: card.id, reason: 'budget' });
      return { ok: false, reason: 'budget' };
    }
    const fresh = await client.getThread(thread.id, { signal });
    measure(fresh);
    if (!fresh.ok) {
      if (fresh.gone) {
        state.pending = state.pending.filter((entry) => entry.key !== op.key);
        await applyDeleted(card);
        return { ok: false, reason: 'remote-deleted' };
      }
      record(receipts, { event: 'status-write-deferred', id: card.id, reason: fresh.error ?? 'read' });
      actions.failures += 1;
      return { ok: false, reason: fresh.error ?? 'thread-read-failed' };
    }
    const freshStatuses = statusesOf(fresh.data?.applied_tags, state.tagIds);
    const redo = decide(card, freshStatuses, entriesForCard(card, thread.id));
    const failuresAtDecide = actions.failures;
    if (redo.kind !== 'push') {
      state.pending = state.pending.filter((entry) => entry.key !== op.key);
      await applyDecision(card, redo, freshStatuses);
      if (actions.failures === failuresAtDecide) settleAudit(thread.id);
      return { ok: false, reason: `recheck-${redo.kind}` };
    }
    const written = await patchStatus({
      card, thread, targetStatus: redo.status, key, auditCursor, t0, fresh,
      knownEntryIds: new Set(entries.map((entry) => entry.entryId)),
    });
    if (!written.ok && !['owner-race', 'remote-deleted'].includes(written.reason)) {
      record(receipts, { event: 'status-write-failed', id: card.id, reason: written.reason });
      if (written.reason !== 'aborted') actions.failures += 1;
      return written;
    }
    state.pending = state.pending.filter((entry) => entry.key !== op.key);
    if (!written.ok) {
      if (written.reason === 'owner-race') {
        const ownerStatus = singleStatus(statusesOf(written.ownerEntry?.toTags ?? [], state.tagIds));
        const statuses = [redo.status, ...(ownerStatus ? [ownerStatus] : [])];
        const conflicted = await applyConflict(card, statuses, 'owner-race');
        if (written.restoreOk) {
          record(receipts, { event: 'owner-race-restored', id: card.id, key });
        } else if (ownerStatus) {
          state.pending.push({
            kind: 'status',
            intent: 'restore',
            schema: RESTORE_SCHEMA,
            writer: 'sync',
            key: `${key}-restore`,
            thread: thread.id,
            cardId: card.id,
            t0: iso(t0),
            patchAt: iso(written.patchAt),
            eventId: board?.eventId ?? null,
            targetStatus: ownerStatus,
            reason: 'owner-race',
            ownerStatus,
            pushedStatus: redo.status,
            ownerEntryId: written.ownerEntry?.entryId ?? null,
            conflictSince: conflicted?.conflictSince ?? iso(now()),
            attempts: 0,
          });
          actions.failures += 1;
          record(receipts, {
            event: 'owner-restore-pending', id: card.id, key,
            code: written.restoreCode ?? 'failed',
          });
        } else {
          actions.failures += 1;
          record(receipts, { event: 'owner-restore-unavailable', id: card.id, key });
        }
      }
      if (actions.failures === failuresAtDecide) settleAudit(thread.id);
      return written;
    }
    const current = cards.get(card.id) ?? card;
    const updated = await persistCard(current, (next) => {
      next.status = redo.status;
      next.discordBase = redo.status;
      next.discordState = 'linked';
      delete next.conflictCard;
      delete next.conflictDiscord;
      delete next.conflictSince;
    }, {
      actor: 'memento', via: 'sync', change: 'status',
      from: current.status, to: redo.status, reason: 'sync-push',
      ...(board?.eventId ? { evidence: board.eventId } : {}),
    });
    state.recentWrites.push({
      thread: thread.id,
      t0: iso(t0),
      patchAt: iso(written.patchAt),
      auditCursor: auditCursor ?? null,
      key,
      cardId: card.id,
      ...(board?.eventId ? { eventId: board.eventId } : {}),
      ...(written.ownEntryId ? { botEntryId: written.ownEntryId } : {}),
    });
    if (updated) {
      state.bases[card.id] = iso(written.patchAt);
      actions.pushed += 1;
    }
    if (actions.failures === failuresAtDecide) settleAudit(thread.id);
    return written;
  };

  const linkPending = async (op, item) => {
    const card = cards.get(op.cardId);
    if (!card) return false;
    const statuses = statusesOf(item.thread.applied_tags, state.tagIds);
    const status = singleStatus(statuses);
    const updated = await persistCard(card, (next) => {
      next.discordChannel = state.forumId;
      next.discordThread = item.thread.id;
      next.discordBase = status ?? '';
      next.discordState = statuses.length === 1 ? 'linked' : 'invalid';
      if (status !== null) next.status = status;
      delete next.conflictCard;
      delete next.conflictDiscord;
      delete next.conflictSince;
    }, {
      actor: 'memento', via: 'sync', change: 'link', reason: 'create-recovered',
      evidence: item.thread.id,
    });
    if (!updated) return false;
    state.pending = state.pending.filter((entry) => entry.key !== op.key);
    state.bases[card.id] = iso(now());
    if (statuses.length === 1) actions.linked += 1;
    else actions.invalid += 1;
    record(receipts, { event: 'create-recovered', id: card.id, thread: item.thread.id });
    return true;
  };

  const adoptOrphan = async (item) => {
    const { marker, thread, content } = item;
    const title = titleFrom(thread.name);
    const original = extractPostOriginal(content, title, marker);
    if (!original) return;
    const normalized = normalizeIntake(original);
    if (findSecret([title, normalized].join('\n'))) {
      record(receipts, { event: 'adopted-secret-skip', id: marker.cardId, thread: thread.id });
      return;
    }
    const statuses = statusesOf(thread.applied_tags, state.tagIds);
    const status = singleStatus(statuses) ?? 'idea';
    const cut = normalized.endsWith('…(잘림)');
    if (dryRun) {
      actions.adopted += 1;
      actions.adoptedIds.push(marker.cardId);
      if (statuses.length !== 1) actions.conflicts += 1;
      return;
    }
    const created = await store.create({
      id: marker.cardId,
      title,
      description: descriptionFrom(normalized) || title,
      original: normalized,
      source: 'discord',
      sourceRef: `discord:${thread.id}`,
      via: 'discord',
      actor: 'owner',
    });
    if (!created.ok) {
      record(receipts, { event: 'adopt-failed', id: marker.cardId, code: created.code });
      actions.failures += 1;
      return;
    }
    const linked = await persistCard(created.card, (next) => {
      next.discordChannel = state.forumId;
      next.discordThread = thread.id;
      next.discordBase = status;
      next.status = status;
      next.discordState = statuses.length === 1 ? 'linked' : 'conflict';
      if (statuses.length !== 1) {
        next.conflictCard = status;
        next.conflictDiscord = statuses.length > 0 ? [...new Set(statuses)] : [status];
        next.conflictSince = iso(now());
      }
      if (cut) next.originalIncomplete = true;
    }, [
      {
        actor: 'memento', via: 'sync', change: 'adopted-orphan',
        reason: cut ? 'orphan-cut-original' : 'orphan-post', evidence: marker.createKey,
      },
      { actor: 'memento', via: 'sync', change: 'link', reason: 'orphan-adopted', evidence: thread.id },
      ...(statuses.length !== 1 ? [{
        actor: 'memento', via: 'sync', change: 'conflict', reason: 'orphan-status-ambiguous',
      }] : []),
    ]);
    if (!linked) return;
    state.bases[marker.cardId] = iso(now());
    actions.adopted += 1;
    actions.adoptedIds.push(marker.cardId);
    if (statuses.length !== 1) actions.conflicts += 1;
    record(receipts, { event: 'adopted-orphan', id: marker.cardId, thread: thread.id, cut });
  };

  const importThread = async ({ thread, content, editSeen }) => {
    const statuses = statusesOf(thread.applied_tags, state.tagIds);
    const normalized = normalizeIntake(content);
    const title = titleFrom(thread.name);
    const secret = findSecret([title, normalized].join('\n'));
    if (secret) {
      state.skipped.push({ thread: thread.id, reason: 'secret', editSeen, titleHash: titleHash(title) });
      actions.skippedSecrets += 1;
      record(receipts, { event: 'skipped-secret', thread: thread.id, pattern: secret });
      return null;
    }
    const id = idForThread(state.guildId, thread.id);
    if (cards.has(id)) return null;
    if (dryRun) {
      actions.imported += 1;
      if (statuses.length >= 2) actions.conflicts += 1;
      if (statuses.length === 0) actions.pushed += 1;
      return null;
    }
    const created = await store.create({
      id,
      title,
      description: descriptionFrom(normalized) || title,
      original: normalized,
      source: 'discord',
      sourceRef: `discord:${thread.id}`,
      via: 'discord',
      actor: 'owner',
    });
    if (!created.ok) {
      record(receipts, { event: 'import-failed', thread: thread.id, code: created.code });
      actions.failures += 1;
      return null;
    }
    const status = singleStatus(statuses) ?? 'idea';
    const updated = await persistCard(created.card, (next) => {
      next.discordChannel = state.forumId;
      next.discordThread = thread.id;
      next.discordBase = status;
      next.discordState = statuses.length >= 2 ? 'conflict' : 'linked';
      if (statuses.length < 2) next.status = status;
      if (editSeen) next.discordEditSeen = editSeen;
      if (statuses.length >= 2) {
        next.conflictCard = 'idea';
        next.conflictDiscord = [...new Set(statuses)];
        next.conflictSince = iso(now());
      }
    }, [
      { actor: 'memento', via: 'sync', change: 'link', reason: 'import', evidence: thread.id },
      ...(statuses.length >= 2 ? [{
        actor: 'memento', via: 'sync', change: 'conflict', reason: 'import-status-ambiguous',
      }] : []),
    ]);
    if (!updated) return null;
    state.bases[id] = iso(now());
    actions.imported += 1;
    if (statuses.length >= 2) actions.conflicts += 1;
    record(receipts, { event: 'imported', id, thread: thread.id, statuses });
    if (statuses.length === 0) {
      const key = `sync-${id}-${randomUUID()}`;
      const t0 = now();
      const op = { kind: 'status', key, thread: thread.id, cardId: id, t0: iso(t0) };
      state.pending.push(op);
      const persisted = await transactState();
      if (persisted.ok) {
        const written = await patchStatus({
          card: updated, thread, targetStatus: 'idea', key,
          auditCursor: audit.cursorAtStart, t0,
          knownEntryIds: new Set(entries.map((entry) => entry.entryId)),
        });
        if (!written.ok && !['owner-race', 'remote-deleted'].includes(written.reason)) {
          record(receipts, { event: 'idea-apply-failed', id, reason: written.reason });
          if (written.reason !== 'aborted') actions.failures += 1;
        } else {
          state.pending = state.pending.filter((entry) => entry.key !== op.key);
          if (written.ok) {
            state.recentWrites.push({
              thread: thread.id, t0: iso(t0), patchAt: iso(written.patchAt),
              auditCursor: audit.cursorAtStart ?? null, key, cardId: id,
              ...(written.ownEntryId ? { botEntryId: written.ownEntryId } : {}),
            });
            state.bases[id] = iso(written.patchAt);
            actions.pushed += 1;
          } else if (written.reason === 'owner-race') {
            const currentCard = cards.get(id) ?? updated;
            await applyConflict(currentCard, ['idea'], 'owner-race');
          }
        }
      }
    }
    linkedThreadIds.add(thread.id);
    return updated;
  };

  // Step 5: eligible bot markers only: unlinked orphans/pending posts plus the
  // pending posting window. Ordinary linked threads belong to the edit window.
  const pendingCreates = state.pending.filter((entry) => entry.kind === 'create');
  const pendingSince = pendingCreates
    .map((entry) => Date.parse(entry.at))
    .filter((value) => Number.isFinite(value))
    .reduce((min, value) => (min === null || value < min ? value : min), null);
  const marked = [];
  const consumed = new Set();
  for (const thread of threads.values()) {
    if (thread.owner_id !== state.botUserId) continue;
    const linkedToCard = linkedThreadIds.has(thread.id);
    const inPendingWindow = pendingSince !== null
      && snowflakeTime(thread.id) >= pendingSince - 5_000;
    if (linkedToCard && !inPendingWindow) continue;
    if (!touchBudget()) break;
    const starter = await starterFor(thread);
    if (!starter?.ok) continue;
    const marker = findMarker(starter.data?.content ?? '');
    if (!marker) continue;
    if (marker.repoId !== state.repoId) {
      actions.ignoredForeign += 1;
      record(receipts, { event: 'ignored-foreign', thread: thread.id });
      continue;
    }
    marked.push({ thread, marker, content: starter.data.content ?? '' });
  }
  const markerGroups = new Map();
  for (const item of marked) {
    if (!markerGroups.has(item.marker.cardId)) markerGroups.set(item.marker.cardId, []);
    markerGroups.get(item.marker.cardId).push(item);
  }
  const ambiguous = new Set(
    [...markerGroups].filter(([, items]) => items.length > 1).map(([cardId]) => cardId),
  );
  state.quarantine = [...(state.quarantine ?? [])];
  const quarantined = new Set();
  const quarantine = async (cardId, items, card) => {
    const threadsForCard = items.map((item) => item.thread.id).sort();
    const existing = state.quarantine.find((entry) => entry.cardId === cardId);
    const same = existing
      && existing.threads.length === threadsForCard.length
      && existing.threads.every((id, index) => id === threadsForCard[index]);
    if (!same) {
      state.quarantine = state.quarantine.filter((entry) => entry.cardId !== cardId);
      state.quarantine.push({ cardId, threads: threadsForCard, at: iso(now()) });
    }
    quarantined.add(cardId);
    for (const item of items) consumed.add(item.thread.id);
    if (!same) record(receipts, { event: 'create-ambiguous', id: cardId, matches: items.length });
    if (card && !card.discordThread) {
      const statuses = [...new Set(items.flatMap((item) => statusesOf(item.thread.applied_tags, state.tagIds)))];
      await applyConflict(card, statuses.length > 0 ? statuses : [card.status], 'create-ambiguous');
    } else if (!card && !same) {
      actions.conflicts += 1;
    }
  };
  for (const op of [...pendingCreates]) {
    const card = cards.get(op.cardId);
    if (!card) continue;
    const matches = markerGroups.get(op.cardId) ?? [];
    if (matches.length === 1) {
      if (await linkPending(op, matches[0])) consumed.add(matches[0].thread.id);
    } else if (matches.length > 1) {
      await quarantine(op.cardId, matches, card);
      state.pending = state.pending.filter((entry) => entry.key !== op.key);
    } else if (op.sent) {
      record(receipts, { event: 'create-possibly-sent', id: op.cardId, key: op.key });
    }
  }
  for (const [cardId, items] of markerGroups) {
    if (ambiguous.has(cardId)) {
      if (!quarantined.has(cardId)) await quarantine(cardId, items, cards.get(cardId) ?? null);
      continue;
    }
    const item = items[0];
    if (consumed.has(item.thread.id)) continue;
    if (cards.has(cardId)) {
      const existing = cards.get(cardId);
      if (!existing.discordThread) {
        await linkPending({ kind: 'create', key: item.marker.createKey, cardId }, item);
      }
      linkedThreadIds.add(item.thread.id);
      continue;
    }
    if (!CARD_ID.test(cardId)) continue;
    await adoptOrphan(item);
    consumed.add(item.thread.id);
  }

  // Step 6: import owner phone posts that no card owns yet.
  for (const thread of threads.values()) {
    if (linkedThreadIds.has(thread.id)) continue;
    if (marked.some((item) => item.thread.id === thread.id)) continue;
    if (!touchBudget()) break;
    const starter = await starterFor(thread);
    if (!starter?.ok) continue;
    const content = starter.data?.content ?? '';
    const marker = findMarker(content);
    if (marker) {
      if (marker.repoId !== state.repoId) {
        actions.ignoredForeign += 1;
        record(receipts, { event: 'ignored-foreign', thread: thread.id });
      }
      continue;
    }
    if (thread.owner_id !== state.ownerUserId) {
      actions.ignoredAuthors += 1;
      record(receipts, { event: 'ignored-author', thread: thread.id });
      continue;
    }
    const editSeen = starter.data?.edited_timestamp ?? null;
    const title = titleFrom(thread.name);
    const titleFingerprint = titleHash(title);
    const skipped = state.skipped.find((entry) => entry.thread === thread.id);
    if (skipped && skipped.editSeen === editSeen && skipped.titleHash === titleFingerprint) continue;
    if (skipped) state.skipped = state.skipped.filter((entry) => entry.thread !== skipped.thread);
    await importThread({ thread, content, editSeen });
  }

  // Step 8: re-check writes we cannot yet prove, then reconcile every linked card.
  const latestOwnerTargets = new Map();
  const restoreDelay = Number.isFinite(state.ownerAuditDelayMs)
    ? Math.max(VERIFY_MIN_MS, 3 * state.ownerAuditDelayMs)
    : null;
  const proveRestoreTarget = async (op, card, currentStatus) => {
    if (!card || !Array.isArray(card.log) || !op.eventId) return { uncertain: 'missing-event-order' };
    const index = card.log.findIndex((event) => event.eventId === op.eventId);
    if (index < 0) return { uncertain: 'missing-event-order' };
    let board = null;
    for (let i = index + 1; i < card.log.length; i += 1) {
      const event = card.log[i];
      if (event.change !== 'status') continue;
      if (!isStatus(event.to)) return { uncertain: 'ambiguous-card-status' };
      const at = Date.parse(event.at);
      if (!Number.isFinite(at)) return { uncertain: 'missing-event-time' };
      board = { target: event.to, at, proof: 'card-log-order' };
    }
    if (!touchBudget()) return { uncertain: 'budget' };
    if (op.reason === 'owner-race' && !op.ownerEntryId) return { uncertain: 'missing-owner-entry' };
    const t0 = Date.parse(op.t0);
    const read = await client.getAuditLog({
      guildId: state.guildId,
      actionType: 111,
      after: op.reason === 'owner-race' ? op.ownerEntryId : '0',
      limit: 100,
    }, { signal });
    measure(read);
    if (!read.ok) return { uncertain: read.status ?? read.error ?? 'audit-read-failed' };
    if (read.meta.pages > 1_000) return { uncertain: 'audit-incomplete' };
    const later = (read.data ?? [])
      .map((entry) => mapAuditEntry(entry, state))
      .filter(Boolean)
      .filter((entry) => entry.targetId === op.thread)
      .filter((entry) => {
        if (op.reason === 'owner-race') {
          if (!op.ownerEntryId) return false;
          try { return BigInt(entry.entryId) > BigInt(op.ownerEntryId); } catch { return false; }
        }
        return Number.isFinite(t0) && entry.time >= t0;
      });
    if (later.some((entry) => entry.actor === 'unknown')) return { uncertain: 'unknown-actor' };
    const ownerEntries = later
      .filter((entry) => entry.actor === 'owner')
      .sort((left, right) => right.time - left.time);
    const latest = ownerEntries[0];
    let owner = null;
    if (latest) {
      const statuses = statusesOf(latest.toTags ?? [], state.tagIds);
      if (statuses.length !== 1) return { uncertain: 'ambiguous-owner-status' };
      owner = { target: statuses[0], at: latest.time, proof: 'owner-audit-order' };
    }
    if (board && owner) {
      const uncertainty = uncertaintyFor(state.clock);
      const boardInterval = [board.at - uncertainty, board.at + uncertainty];
      const ownerInterval = [owner.at - 1_000, owner.at + 1_000];
      if (boardInterval[0] > ownerInterval[1]) return board;
      if (ownerInterval[0] > boardInterval[1]) return owner;
      return { uncertain: 'overlapping-intervals' };
    }
    if (board || owner) return board ?? owner;
    if (op.reason === 'superseded-reassert') {
      return card.status === op.targetStatus && currentStatus === op.targetStatus
        ? { target: op.targetStatus, proof: 'card-status-target' }
        : { uncertain: 'missing-newer-proof' };
    }
    if (!op.ownerEntryId) return { uncertain: 'missing-owner-entry' };
    if (currentStatus === op.targetStatus || currentStatus === op.pushedStatus) {
      return { target: op.targetStatus, proof: 'complete-audit-no-newer' };
    }
    return { uncertain: 'unproven-current-tag' };
  };

  const resumeRestore = async (op, card) => {
    const keep = (code, event) => {
      op.attempts = Number(op.attempts ?? 0) + 1;
      actions.failures += 1;
      record(receipts, {
        event, id: op.cardId, key: op.key, code, attempts: op.attempts,
      });
      return 'keep';
    };
    if (!state.tagIds[op.targetStatus]) return keep('missing-target-tag', 'owner-restore-missing-tag');
    if (!touchBudget()) return 'keep';
    const fresh = await client.getThread(op.thread, { signal });
    measure(fresh);
    if (fresh.gone) {
      if (card) await applyDeleted(card);
      record(receipts, { event: 'owner-restore-deleted', id: op.cardId, key: op.key });
      return 'clear';
    }
    if (!fresh.ok) return keep(fresh.status ?? fresh.error ?? 'thread-read-failed', 'owner-restore-retry');
    const currentStatuses = statusesOf(fresh.data?.applied_tags ?? [], state.tagIds);
    if (currentStatuses.length !== 1) return keep('ambiguous-remote-status', 'owner-restore-uncertain');
    const currentStatus = currentStatuses[0];
    const proof = await proveRestoreTarget(op, card, currentStatus);
    if (proof.uncertain) {
      return proof.uncertain === 'budget' ? 'keep' : keep(proof.uncertain, 'owner-restore-uncertain');
    }
    const target = proof.target;
    const targetTagId = state.tagIds[target];
    if (!targetTagId) return keep('missing-effective-tag', 'owner-restore-missing-tag');
    const restoreTags = withStatusTag(
      fresh.data?.applied_tags ?? [], statusTagIds(state), targetTagId,
    );
    const restored = await client.patchThreadTags({
      threadId: op.thread,
      appliedTags: restoreTags,
      auditReason: `memento-${op.writer ?? 'sync'} ${op.key} restore`,
      archived: false,
    }, { signal });
    measure(restored);
    if (restored.ok) {
      if (dryRun) actions.pushed += 1;
      const known = threads.get(op.thread);
      if (known) known.applied_tags = [...restoreTags];
      const after = await store.get(op.cardId);
      if (!after.ok) return keep('card-read-failed', 'owner-restore-uncertain');
      const afterProof = await proveRestoreTarget(op, after.card, target);
      if (afterProof.uncertain) return keep(afterProof.uncertain, 'owner-restore-uncertain');
      if (afterProof.target !== target) {
        if (card) {
          await applyConflict(
            after.card,
            [afterProof.target, target, op.pushedStatus ?? after.card.status].filter(isStatus),
            'owner-race',
          );
        }
        return keep('restore-window-newer-intent', 'owner-restore-raced');
      }
      const patchAt = Date.parse(op.patchAt);
      const t0 = Date.parse(op.t0);
      const since = Number.isFinite(t0) ? t0 : patchAt;
      const unmeasured = restoreDelay === null;
      if (unmeasured) {
        if (!Number.isFinite(patchAt) || !Number.isFinite(since)
          || now() - since <= AUDIT_RETENTION_MS) {
          record(receipts, {
            event: 'owner-restore-retained', id: op.cardId, key: op.key,
            target, proof: proof.proof, code: 'measurement-unavailable',
          });
          return 'keep';
        }
        if (op.reason === 'owner-race' && card) {
          await applyConflict(card, [target, op.pushedStatus].filter(isStatus), 'owner-race');
        }
        record(receipts, {
          event: 'owner-restore-expired', id: op.cardId, key: op.key,
          target, code: 'audit-retention',
        });
        return 'clear';
      }
      if (!Number.isFinite(patchAt) || now() - patchAt < restoreDelay) {
        record(receipts, {
          event: 'owner-restore-retained', id: op.cardId, key: op.key,
          target, proof: proof.proof, code: 'retention',
        });
        return 'keep';
      }
      if (op.reason === 'owner-race' && card && card.discordState !== 'conflict') {
        await applyConflict(card, [target, op.pushedStatus].filter(isStatus), 'owner-race');
      }
      latestOwnerTargets.set(op.cardId, target);
      record(receipts, {
        event: 'owner-restore-completed', id: op.cardId, key: op.key, target, proof: proof.proof,
      });
      return 'clear';
    }
    if (restored.gone) {
      if (card) await applyDeleted(card);
      record(receipts, { event: 'owner-restore-deleted', id: op.cardId, key: op.key });
      return 'clear';
    }
    return keep(restored.status ?? restored.error ?? 'failed', 'owner-restore-retry');
  };

  // Cards the pending loop decided in this sync. Their audit delta was judged here; the main loop
  // must not judge it again (a second judgment un-resolves a pick named just above).
  const decidedPending = new Set();
  for (const op of [...state.pending]) {
    if (op.kind !== 'status') continue;
    const card = cards.get(op.cardId);
    if (op.intent === 'restore') {
      const outcome = await resumeRestore(op, card);
      if (outcome === 'clear') state.pending = state.pending.filter((entry) => entry.key !== op.key);
      continue;
    }
    const thread = card ? threads.get(op.thread) : null;
    state.pending = state.pending.filter((entry) => entry.key !== op.key);
    if (!card || !thread) continue;
    // A card can have several unfinished board ops (each failed write-through appends one). The
    // first op judged the card's audit delta; later ops of that card are covered by it and only
    // leave the pending list, so no second judgment can un-name a pick the first one resolved.
    if (decidedPending.has(card.id)) {
      record(receipts, { event: 'pending-status-subsumed', id: card.id, key: op.key });
      continue;
    }
    if (!touchBudget()) {
      state.pending.push(op);
      break;
    }
    const remoteStatuses = statusesOf(thread.applied_tags, state.tagIds);
    const decision = decide(card, remoteStatuses, entriesForCard(card, thread.id));
    decidedPending.add(card.id);
    record(receipts, {
      event: 'pending-status-resumed', id: card.id, key: op.key, kind: decision.kind,
    });
    if (decision.kind === 'push') await guardedPush(card, thread, audit.cursorAtStart);
    else await settleIfLanded(thread.id, () => applyDecision(card, decision, remoteStatuses));
  }

  await verifyRecentWrites({
    state, cards, threads, client, now, receipts, actions, audit, store, latestOwnerTargets, signal,
    applyConflict, touchBudget, measure, dryRun,
  });

  for (const card of [...cards.values()]) {
    if (!card.discordThread || card.discordState === 'deleted') continue;
    if (decidedPending.has(card.id)) continue;
    if (!touchBudget()) break;
    let thread = threads.get(card.discordThread);
    if (!thread) {
      const fetched = await client.getThread(card.discordThread, { signal });
      measure(fetched);
      if (fetched.gone) {
        await applyDeleted(card);
        continue;
      }
      if (!fetched.ok) continue;
      thread = fetched.data;
    }
    const remoteStatuses = statusesOf(thread.applied_tags, state.tagIds);
    const decision = decide(card, remoteStatuses, entriesForCard(card, thread.id));
    if (decision.kind === 'none') {
      settleAudit(thread.id);
      continue;
    }
    if (decision.kind === 'push') {
      await guardedPush(card, thread, audit.cursorAtStart);
      continue;
    }
    await settleIfLanded(thread.id, () => applyDecision(card, decision, remoteStatuses));
  }

  // Step 9: mirror the owner's thread title first (listing data, no HTTP),
  // then notice starter-message edits in the rotating window plus renames.
  state.nameSeen = { ...(state.nameSeen ?? {}) };
  const renamedForFetch = new Set();
  for (const card of cards.values()) {
    if (!card.discordThread || card.discordState === 'deleted') continue;
    const thread = threads.get(card.discordThread);
    if (!thread) continue;
    const nextTitle = titleFrom(thread.name);
    if (!nextTitle || nextTitle === card.title) continue;
    const hash = titleHash(nextTitle);
    if (state.nameSeen[card.id] === hash) continue;
    if (findSecret(nextTitle)) {
      state.nameSeen[card.id] = hash;
      actions.skippedSecrets += 1;
      record(receipts, { event: 'skipped-secret-title', id: card.id });
      continue;
    }
    const updated = await persistCard(card, (next) => { next.title = nextTitle; }, {
      actor: 'owner', via: 'discord', change: 'original', reason: 'owner-title-rename',
    });
    if (updated) {
      state.nameSeen[card.id] = hash;
      actions.edits += 1;
    }
    renamedForFetch.add(card.id);
  }
  const editable = [...cards.values()]
    .filter((card) => card.discordThread && card.discordState !== 'deleted')
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (editable.length > 0) {
    const window = [];
    for (let index = 0; index < Math.min(STARTER_WINDOW, editable.length); index += 1) {
      window.push(editable[(state.starterCursor + index) % editable.length]);
    }
    for (const card of editable) {
      if (renamedForFetch.has(card.id) && !window.some((entry) => entry.id === card.id)) {
        window.push(card);
      }
    }
    for (const card of window) {
      if (!touchBudget()) break;
      const thread = threads.get(card.discordThread) ?? { id: card.discordThread, name: card.title };
      const starter = await starterFor(thread);
      if (!starter?.ok) continue;
      const edited = starter.data?.edited_timestamp;
      if (!edited) continue;
      if (card.discordEditSeen && Date.parse(edited) <= Date.parse(card.discordEditSeen)) continue;
      const marker = findMarker(starter.data.content ?? '');
      const original = normalizeIntake(
        extractPostOriginal(starter.data.content ?? '', card.title, marker),
      );
      const nextTitle = titleFrom(thread.name);
      if (!original || original === card.original) {
        await persistCard(card, (next) => { next.discordEditSeen = edited; }, {
          actor: 'owner', via: 'discord', change: 'original', reason: 'edit-unchanged',
        });
        continue;
      }
      const secret = findSecret([
        nextTitle !== card.title ? nextTitle : '',
        original,
      ].join('\n'));
      if (secret) {
        await persistCard(card, (next) => { next.discordEditSeen = edited; }, {
          actor: 'owner', via: 'discord', change: 'skipped-secret', reason: `secret ${secret}`,
        });
        actions.skippedSecrets += 1;
        record(receipts, { event: 'skipped-secret-edit', id: card.id, pattern: secret });
        continue;
      }
      const updated = await persistCard(card, (next) => {
        next.original = original;
        next.discordEditSeen = edited;
      }, { actor: 'owner', via: 'discord', change: 'original', reason: 'owner-edit' });
      if (updated) actions.edits += 1;
    }
    state.starterCursor = (state.starterCursor + window.length) % editable.length;
  }

  // Step 10: create forum posts only after the push that carries the card and its create op.
  const queue = [];
  for (const op of state.pending.filter((entry) => entry.kind === 'create' && !entry.sent)) {
    const card = cards.get(op.cardId);
    if (card && card.discordState === 'posting') queue.push({ op, card });
  }
  for (const card of [...cards.values()]) {
    if (card.status === 'dropped' || card.discordState !== 'none' || card.discordThread) continue;
    const key = `create-${card.id}-${randomUUID()}`;
    const postingSince = iso(now());
    const updated = await persistCard(card, (next) => {
      next.discordState = 'posting';
      next.discordPostingSince = postingSince;
    }, { actor: 'memento', via: 'sync', change: 'link', reason: 'posting' });
    if (!updated) continue;
    const op = { kind: 'create', key, cardId: card.id, at: postingSince, sent: false };
    state.pending.push(op);
    queue.push({ op, card: updated });
  }
  let waitingForPush = false;
  if (queue.length > 0) {
    const persisted = await transactState();
    if (!persisted.ok) {
      actions.failures += 1;
      record(receipts, { event: 'create-prep-failed', code: persisted.code ?? 'failed' });
    } else {
      const pushed = await pushNow('post');
      if (pushed !== 'ok' && pushed !== 'dry-run') {
        waitingForPush = true;
        record(receipts, { event: 'waiting-for-push', cards: queue.length });
      } else {
        for (const item of queue) {
          const current = state.pending.find((entry) => entry.key === item.op.key);
          if (current) current.sent = true;
          item.op.sent = true;
        }
        const sentWrite = await transactState();
        if (!sentWrite.ok) {
          actions.failures += 1;
          record(receipts, { event: 'create-intent-failed', code: sentWrite.code ?? 'failed' });
        } else {
          for (const item of queue) {
            if (signal?.aborted) break;
            if (!touchBudget()) break;
            const card = cards.get(item.card.id) ?? item.card;
            const marker = markerLine(card.id, item.op.key, state.repoId);
            const { content } = composePostContent({
              title: card.title, original: card.original, marker,
            });
            await hooks.barrier?.('before-create-request');
            const post = await client.createForumPost({
              forumId: state.forumId,
              name: card.title,
              content,
              appliedTags: state.tagIds[card.status] ? [state.tagIds[card.status]] : [],
              auditReason: `memento-sync ${item.op.key}`,
            }, { signal });
            measure(post);
            if (!post.ok) {
              actions.failures += 1;
              record(receipts, { event: 'create-failed', id: card.id, code: post.error ?? post.status });
              continue;
            }
            await hooks.barrier?.('after-create-response');
            const threadId = post.data?.id;
            if (!threadId) continue;
            const linked = await persistCard(card, (next) => {
              next.discordChannel = state.forumId;
              next.discordThread = threadId;
              next.discordBase = card.status;
              next.discordState = 'linked';
              delete next.conflictCard;
              delete next.conflictDiscord;
              delete next.conflictSince;
            }, {
              actor: 'memento', via: 'sync', change: 'link', reason: 'posted', evidence: threadId,
            });
            if (!linked) continue;
            state.pending = state.pending.filter((entry) => entry.key !== item.op.key);
            state.bases[card.id] = iso(now());
            actions.posted += 1;
            record(receipts, { event: 'post-created', id: card.id, thread: threadId });
          }
        }
      }
    }
  }

  return finalize({
    ok: true,
    reason,
    discord: budgetHit ? 'budget' : 'ok',
    waitingForPush,
    notify: null,
  });
}

function mapAuditEntry(entry, state) {
  const change = (entry.changes ?? []).find((item) => item.key === 'applied_tags');
  if (!change) return null;
  const toTags = Array.isArray(change.new_value) ? change.new_value : [];
  const fromTags = Array.isArray(change.old_value) ? change.old_value : [];
  const toStatuses = statusesOf(toTags, state.tagIds);
  const fromStatuses = statusesOf(fromTags, state.tagIds);
  const actor = entry.user_id === state.ownerUserId
    ? 'owner'
    : entry.user_id === state.botUserId
      ? 'bot'
      : 'unknown';
  const time = snowflakeTime(entry.id);
  return {
    entryId: entry.id,
    time,
    at: iso(time),
    actor,
    to: singleStatus(toStatuses),
    from: singleStatus(fromStatuses),
    toTags,
    fromTags,
    reason: typeof entry.reason === 'string' ? entry.reason : null,
    targetId: entry.target_id,
  };
}

async function ingestAudit({ client, state, now, signal, receipts, discordOpen }) {
  const at = typeof now === 'function' ? now() : Number(now);
  const cursor = state.audit.lastEntryId ?? null;
  const carried = state.audit.carry ?? [];
  if (!discordOpen()) {
    return {
      ok: false, fatal: false, code: 'budget', coverage: 'partial',
      raw: carried, entries: [], cursorAtStart: cursor,
    };
  }
  const read = async (actionType) => client.getAuditLog({
    guildId: state.guildId,
    actionType,
    after: cursor ?? '0',
    limit: 100,
  }, { signal });
  const tagLog = await read(111);
  const deleteLog = await read(112);
  if (!tagLog.ok || !deleteLog.ok) {
    const failed = !tagLog.ok ? tagLog : deleteLog;
    record(receipts, { event: 'audit-read-failed', code: failed.error ?? failed.status ?? 'unknown' });
    return {
      ok: false,
      fatal: networkFailure(failed),
      code: failed.status ?? failed.error ?? 'unknown',
      coverage: 'partial',
      raw: carried,
      entries: [],
      cursorAtStart: cursor,
    };
  }
  let max = cursor;
  for (const entry of [...tagLog.data, ...deleteLog.data]) {
    if (!max || BigInt(entry.id) > BigInt(max)) max = entry.id;
  }
  const coverage = cursor === null || at - snowflakeTime(cursor) < AUDIT_RETENTION_MS
    ? 'complete'
    : 'partial';
  const known = new Map((state.audit.ingested ?? []).map((item) => [item.id, item]));
  for (const entry of [...tagLog.data, ...deleteLog.data]) {
    known.set(entry.id, { id: entry.id, at: iso(snowflakeTime(entry.id)) });
  }
  state.audit.ingested = [...known.values()]
    .filter((item) => snowflakeTime(item.id) > at - AUDIT_RETENTION_MS)
    .sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1));
  if (max && max !== cursor) state.audit.lastEntryId = max;
  if (!state.audit.coveredSince) state.audit.coveredSince = iso(at - AUDIT_RETENTION_MS);
  // The cursor moves past these entries now, so they are carried until a judgment on their thread lands.
  const carry = new Map(carried.map((entry) => [entry.id, entry]));
  for (const entry of tagLog.data) carry.set(entry.id, entry);
  state.audit.carry = [...carry.values()]
    .filter((entry) => snowflakeTime(entry.id) > at - AUDIT_RETENTION_MS)
    .sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1));
  return {
    ok: true, fatal: false, coverage, raw: state.audit.carry, entries: [],
    cursorAtStart: cursor,
  };
}

async function verifyRecentWrites({
  state, cards, threads, client, now, receipts, actions, audit, store, latestOwnerTargets,
  signal, applyConflict, touchBudget, measure, dryRun,
}) {
  const delay = Number.isFinite(state.ownerAuditDelayMs)
    ? Math.max(VERIFY_MIN_MS, 3 * state.ownerAuditDelayMs)
    : null;
  const retentionDelay = delay;
  // The write's own cursor is preserved: a newer visible bot entry must not
  // advance us past a hidden owner entry inside the original write window.
  const windows = new Map();
  const readWindow = async (cursor) => {
    const key = cursor ?? '0';
    if (windows.has(key)) return windows.get(key);
    if (!touchBudget()) return null;
    const result = await client.getAuditLog({
      guildId: state.guildId, actionType: 111, after: key, limit: 100,
    }, { signal });
    measure(result);
    const mapped = result.ok && result.meta.pages <= 1_000
      ? result.data.map((entry) => mapAuditEntry(entry, state)).filter(Boolean)
      : null;
    windows.set(key, mapped);
    return mapped;
  };
  const keep = [];
  for (const write of state.recentWrites ?? []) {
    const card = cards.get(write.cardId);
    const t0 = Date.parse(write.t0);
    const patchAt = Date.parse(write.patchAt);
    if (!card || !Number.isFinite(t0) || !Number.isFinite(patchAt)) continue;
    const window = await readWindow(null);
    if (window === null) {
      keep.push(write);
      continue;
    }
    if ((state.pending ?? []).some((op) => op.intent === 'restore' && op.cardId === write.cardId)) {
      keep.push(write);
      continue;
    }
    const owners = window.filter((entry) => entry.actor === 'owner'
      && entry.targetId === write.thread
      && entry.time >= t0
      && entry.time <= patchAt + 1_000);
    const unknown = window.filter((entry) => entry.actor === 'unknown'
      && entry.targetId === write.thread
      && entry.time >= t0
      && entry.time <= patchAt + 1_000);
    const anchor = write.eventId
      ? (card.log ?? []).findIndex((event) => event.eventId === write.eventId)
      : -1;
    const logSuperseded = (card.log ?? []).some((event, index) => event.actor === 'owner'
      && event.change === 'status'
      && (anchor < 0 || index > anchor)
      && Date.parse(event.at) > patchAt + 2_000 + uncertaintyFor(state.clock));
    const laterOwnerVisible = window.some((entry) => entry.actor === 'owner'
      && entry.targetId === write.thread && entry.time > patchAt + 1_000);
    if (unknown.length > 0 && owners.length === 0) {
      record(receipts, {
        event: 'recent-write-uncertain', id: write.cardId, key: write.key,
        code: 'unknown-actor',
      });
      keep.push(write);
      continue;
    }
    if (unknown.length > 0 && !logSuperseded && !laterOwnerVisible) {
      // An owner entry and an unknown actor's entry both sit in the window, and no later owner
      // change exists. Neither value may vanish silently (plan line 70: unknown -> conflict;
      // line 73: owner entry in the window -> conflict). Show both as conflict candidates and
      // never PATCH over the unknown actor's value. Zero or 2+ status tags are left to reconcile.
      if (!touchBudget()) {
        keep.push(write);
        continue;
      }
      const fresh = await client.getThread(write.thread, { signal });
      measure(fresh);
      if (!fresh.ok) {
        keep.push(write);
        continue;
      }
      const shown = singleStatus(statusesOf(fresh.data?.applied_tags ?? [], state.tagIds));
      if (shown === null) {
        keep.push(write);
        continue;
      }
      const freshCard = await store.get(write.cardId);
      if (!freshCard.ok) {
        keep.push(write);
        continue;
      }
      const ownerValues = owners
        .map((entry) => singleStatus(statusesOf(entry.toTags ?? [], state.tagIds)))
        .filter(Boolean);
      const earlier = freshCard.card.discordState === 'conflict' && Array.isArray(freshCard.card.conflictDiscord)
        ? freshCard.card.conflictDiscord
        : [];
      const conflicted = await applyConflict(
        freshCard.card, [...earlier, ...ownerValues, shown, freshCard.card.status], 'recent-write-owner-race',
      );
      if (!ownerValues.every((value) => conflicted?.conflictDiscord?.includes(value))) {
        keep.push(write);
        continue;
      }
      if (now() - t0 > AUDIT_RETENTION_MS) {
        record(receipts, { event: 'audit-expired', id: card.id, key: write.key });
        actions.expired += 1;
        continue;
      }
      keep.push(write);
      continue;
    }
    const intended = latestOwnerTargets?.get(write.cardId) ?? null;
    if (intended) {
      const thread = threads.get(write.thread);
      if (!state.tagIds[intended] || !thread || !touchBudget()) {
        keep.push(write);
        continue;
      }
      const fresh = await client.getThread(write.thread, { signal });
      measure(fresh);
      if (!fresh.ok) {
        keep.push(write);
        continue;
      }
      const intendedTags = withStatusTag(
        fresh.data?.applied_tags ?? [], statusTagIds(state), state.tagIds[intended],
      );
      const restored = await client.patchThreadTags({
        threadId: write.thread,
        appliedTags: intendedTags,
        auditReason: `memento-sync ${write.key} restore`,
        archived: false,
      }, { signal });
      measure(restored);
      if (!restored.ok) {
        keep.push(write);
        continue;
      }
      if (dryRun) actions.pushed += 1;
      if (thread) thread.applied_tags = [...intendedTags];
      const freshCard = await store.get(write.cardId);
      if (!freshCard.ok) {
        keep.push(write);
        continue;
      }
      const conflicted = await applyConflict(
        freshCard.card, [intended, freshCard.card.status], 'recent-write-owner-race',
      );
      if (!Array.isArray(conflicted?.conflictDiscord) || !conflicted.conflictDiscord.includes(intended)) {
        keep.push(write);
        continue;
      }
      const unmeasuredRetention = retentionDelay === null
        ? now() - t0 <= AUDIT_RETENTION_MS
        : now() - patchAt < retentionDelay;
      if (unmeasuredRetention) {
        record(receipts, {
          event: 'recent-write-retained', id: write.cardId, key: write.key,
          target: intended, source: 'explicit-restore',
          code: retentionDelay === null ? 'measurement-unavailable' : 'retention',
        });
        keep.push(write);
        continue;
      }
      record(receipts, {
        event: 'recent-write-owner-race', id: write.cardId, key: write.key,
        target: intended, source: 'explicit-restore',
      });
      continue;
    }
    // A later owner status event in the card log supersedes this write (plan IS-2: the
    // later owner change wins). Retire it without any restore.
    if (logSuperseded) {
      record(receipts, {
        event: 'recent-write-superseded', id: write.cardId, key: write.key, source: 'card-log',
      });
      continue;
    }
    // Past 45 days an unverified write expires. A write without owner evidence, or one whose
    // audit window is partial, cannot wait for verification any longer.
    if (now() - t0 > AUDIT_RETENTION_MS && (owners.length === 0 || audit.coverage !== 'complete')) {
      if (card.discordState === 'linked') {
        await applyConflict(card, [card.discordBase || card.status], 'audit expired before verification');
      }
      record(receipts, { event: 'audit-expired', id: card.id, key: write.key });
      actions.expired += 1;
      continue;
    }
    if (owners.length > 0) {
      if (audit.coverage !== 'complete') {
        keep.push(write);
        continue;
      }
      const owner = owners.at(-1);
      const ownerStatus = singleStatus(statusesOf(owner.toTags ?? [], state.tagIds));
      // A newer owner tag than this write's race is the one to honour: reconcile
      // takes it from the audit, and restoring the older owner tag would overwrite it.
      if (window.some((entry) => entry.actor === 'owner'
        && entry.targetId === write.thread && entry.time > patchAt + 1_000)) {
        record(receipts, {
          event: 'recent-write-superseded', id: write.cardId, key: write.key, source: 'audit',
        });
        continue;
      }
      const thread = threads.get(write.thread);
      if (!ownerStatus || !state.tagIds[ownerStatus] || !thread || !touchBudget()) {
        keep.push(write);
        continue;
      }
      const fresh = await client.getThread(write.thread, { signal });
      measure(fresh);
      if (!fresh.ok) {
        keep.push(write);
        continue;
      }
      // Restore only over what this write pushed or the raced owner entries set. Any other
      // status is a newer change that reconcile must judge: make no write, keep silently.
      const pushed = anchor >= 0
        ? (card.log[anchor].to ?? null)
        : (window.find((entry) => entry.entryId === write.botEntryId)?.to ?? null);
      const shown = singleStatus(statusesOf(fresh.data?.applied_tags ?? [], state.tagIds));
      const domain = [pushed, ...owners.map((entry) => singleStatus(statusesOf(entry.toTags ?? [], state.tagIds)))];
      if (shown === null || !domain.includes(shown)) {
        if (now() - t0 > AUDIT_RETENTION_MS) {
          record(receipts, { event: 'audit-expired', id: card.id, key: write.key });
          actions.expired += 1;
          continue;
        }
        // A single status this write did not set and the owner did not choose in the window:
        // never PATCH it. Keep the raced owner value and the shown value visible as conflict
        // candidates (idempotent). Zero or 2+ status tags are left to reconcile (invalid).
        if (shown !== null) {
          const latest = await store.get(write.cardId);
          if (latest.ok) {
            await applyConflict(latest.card, [ownerStatus, shown, latest.card.status], 'recent-write-owner-race');
          }
        }
        keep.push(write);
        continue;
      }
      let restoredNow = false;
      if (shown !== ownerStatus) {
        const ownerTags = withStatusTag(
          fresh.data?.applied_tags ?? [], statusTagIds(state), state.tagIds[ownerStatus],
        );
        const restored = await client.patchThreadTags({
          threadId: write.thread,
          appliedTags: ownerTags,
          auditReason: `memento-sync ${write.key} restore`,
          archived: false,
        }, { signal });
        measure(restored);
        if (!restored.ok) {
          keep.push(write);
          continue;
        }
        if (dryRun) actions.pushed += 1;
        thread.applied_tags = [...ownerTags];
        restoredNow = true;
      }
      const freshCard = await store.get(write.cardId);
      if (!freshCard.ok) {
        keep.push(write);
        continue;
      }
      const conflicted = await applyConflict(
        freshCard.card, [ownerStatus, freshCard.card.status], 'recent-write-owner-race',
      );
      if (!Array.isArray(conflicted?.conflictDiscord) || !conflicted.conflictDiscord.includes(ownerStatus)) {
        keep.push(write);
        continue;
      }
      const unmeasuredRetention = retentionDelay === null
        ? now() - t0 <= AUDIT_RETENTION_MS
        : now() - patchAt < retentionDelay;
      if (unmeasuredRetention) {
        if (restoredNow) {
          record(receipts, {
            event: 'recent-write-retained', id: write.cardId, key: write.key,
            target: ownerStatus, source: 'original-window',
            code: retentionDelay === null ? 'measurement-unavailable' : 'retention',
          });
        }
        keep.push(write);
        continue;
      }
      record(receipts, {
        event: 'recent-write-owner-race', id: write.cardId, key: write.key,
        target: ownerStatus, source: 'original-window',
      });
      continue;
    }
    const ownVisible = !write.botEntryId || window.some((entry) => entry.entryId === write.botEntryId);
    if (delay !== null && now() - patchAt >= delay && audit.coverage === 'complete' && ownVisible) {
      continue; // measured delay + complete original window: verified and retired
    }
    // Unmeasured delay, incomplete coverage or an invisible own write: reread later.
    keep.push(write);
  }
  state.recentWrites = keep;
}
