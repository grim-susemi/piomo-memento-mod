// Board API v1: the board's only surface into memento cards.
//
// The board reads with state() and writes one status with handle(). Card files
// are touched only through the store, so every board write is a rev-checked,
// committed card update. When the card is linked to a forum thread the write is
// guarded: record a durable pending op, re-read the thread at t0, decide with
// the pure reconcile function, PATCH only a proven push, then read the audit
// window back and restore an owner change that raced the PATCH.
//
// This module is deliberately independent of src/sync/run.mjs. The adapter
// helpers below (board events, audit entries, coverage) mirror the mapping that
// TASK8's clarification requires each caller to supply from existing card logs
// and sync/state.json pending/recentWrites.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './card/codec.mjs';
import { STATUS_KEYS, STATUS_LABELS, isStatus } from './card/status.mjs';
import {
  API_KEY,
  BOARD_STATE_SCHEMA,
  LOG_LIMIT,
  TEXT_CAP_BYTES,
  checkSetStatusBody,
} from './contract.mjs';
import { createDiscordClient, snowflakeTime, withStatusTag } from './discord/client.mjs';
import { reconcile } from './sync/reconcile.mjs';
import { openStore } from './store/store.mjs';

export const API_VERSION = 1;
export const API_FEATURES = Object.freeze(['cards.read', 'cards.setStatus']);
export const WRITE_LOCK_WAIT_MS = 500;
export const REPLY_BUDGET_MS = 2_000;
const REPLY_RETURN_MARGIN_MS = 50;
export const DISCORD_BUDGET_MS = 10_000;
export const AUDIT_RETENTION_MS = 45 * 24 * 60 * 60 * 1_000;
export const RESTORE_SCHEMA = 'memento.restore.v1';

const CARD_FILE = /^(\d{8}-[a-z2-7]{4})\.md$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const reply = (status, body) => ({ status, body });
const cloneReply = (value) => ({ status: value.status, body: structuredClone(value.body) });

function iso(ms) {
  return new Date(ms).toISOString();
}

function latestMs(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value.getTime() : Number(value);
}

/** Cuts text to at most maxBytes of UTF-8 on a code-point boundary. */
export function capUtf8(text, maxBytes = TEXT_CAP_BYTES) {
  const value = typeof text === 'string' ? text : '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
  let size = 0;
  let out = '';
  for (const char of value) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (size + bytes > maxBytes) break;
    out += char;
    size += bytes;
  }
  return { text: out, truncated: true };
}

export function statusesOf(appliedTags, tagIds) {
  if (!Array.isArray(appliedTags)) return [];
  const byId = new Map(Object.entries(tagIds ?? {}).map(([key, id]) => [id, key]));
  return appliedTags.map((id) => byId.get(id)).filter(isStatus);
}

export function singleStatus(values) {
  return values.length === 1 && isStatus(values[0]) ? values[0] : null;
}

export function statusTagIds(state) {
  return Object.values(state.tagIds ?? {}).filter((id) => typeof id === 'string' && id.length > 0);
}

/** The unresolved-state boundary of a conflict or invalid card. */
export function conflictBoundary(card) {
  if (card.discordState === 'conflict' && typeof card.conflictSince === 'string') {
    const parsed = Date.parse(card.conflictSince);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (card.discordState === 'invalid') {
    const event = [...(card.log ?? [])].reverse().find((entry) => entry.change === 'invalid-remote');
    const parsed = event ? Date.parse(event.at) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Owner board status events since the last agreed base, with their uncertainty. */
export function boardEventsOf(card, state, uncertaintyMs) {
  const baseAt = Date.parse(state.bases?.[card.id] ?? card.created);
  const boundary = Number.isFinite(baseAt) ? baseAt : -Infinity;
  const correlated = new Map();
  for (const entry of [...(state.pending ?? []), ...(state.recentWrites ?? [])]) {
    if (entry?.eventId && entry?.key) correlated.set(entry.eventId, entry.key);
  }
  const events = (card.log ?? [])
    .filter((event) => event.actor === 'owner' && event.via === 'board')
    .map((event) => ({ ...event, time: Date.parse(event.at) }))
    .filter((event) => Number.isFinite(event.time) && event.time >= boundary)
    .map((event) => ({
      eventId: event.eventId,
      at: event.at,
      ...(event.from === undefined ? {} : { from: event.from }),
      ...(event.to === undefined ? {} : { to: event.to }),
      uncertaintyMs,
      ...(correlated.has(event.eventId) ? { operationKey: correlated.get(event.eventId) } : {}),
    }));
  if (events.length > 0 && (card.discordState === 'conflict' || card.discordState === 'invalid')) {
    const since = conflictBoundary(card);
    if (since !== null && Date.parse(events.at(-1).at) > since) events.at(-1).resolves = true;
  }
  return events;
}

export function auditEntriesFor(entries, threadId, baseAt) {
  const boundary = Number.isFinite(baseAt) ? baseAt : -Infinity;
  return entries
    .filter((entry) => entry.targetId === threadId)
    .filter((entry) => entry.time >= boundary)
    .map((entry) => ({
      entryId: entry.entryId,
      at: entry.at,
      actor: entry.actor,
      to: entry.to,
      from: entry.from,
      reason: entry.reason,
    }));
}

export function uncertaintyFor(clock) {
  const offset = Math.abs(Number(clock?.offsetMs) || 0);
  const rtt = Number(clock?.rttMs) || 0;
  return Math.round(2_000 + offset + rtt / 2);
}

function mapAuditEntry(entry, state) {
  const change = (entry.changes ?? []).find((item) => item.key === 'applied_tags');
  if (!change) return null;
  const toTags = Array.isArray(change.new_value) ? change.new_value : [];
  const fromTags = Array.isArray(change.old_value) ? change.old_value : [];
  const time = snowflakeTime(entry.id);
  const actor = entry.user_id === state.ownerUserId
    ? 'owner'
    : entry.user_id === state.botUserId
      ? 'bot'
      : 'unknown';
  return {
    entryId: entry.id,
    time,
    at: iso(time),
    actor,
    to: singleStatus(statusesOf(toTags, state.tagIds)),
    from: singleStatus(statusesOf(fromTags, state.tagIds)),
    toTags,
    fromTags,
    reason: typeof entry.reason === 'string' ? entry.reason : null,
    targetId: entry.target_id,
  };
}

function coverageFor(state, t0, baseAt) {
  const coveredSince = Date.parse(state.audit?.coveredSince ?? '');
  if (!Number.isFinite(coveredSince)) return 'partial';
  if (!Number.isFinite(baseAt)) return 'partial';
  if (coveredSince > baseAt) return 'partial';
  if (coveredSince > t0) return 'partial';
  if (baseAt < t0 - AUDIT_RETENTION_MS) return 'partial';
  return 'complete';
}

function projectLog(log) {
  return (Array.isArray(log) ? log.slice(-LOG_LIMIT).reverse() : []).map((entry) => ({
    at: entry.at,
    actor: entry.actor,
    via: entry.via,
    change: entry.change,
    ...(entry.from === undefined ? {} : { from: entry.from }),
    ...(entry.to === undefined ? {} : { to: entry.to }),
    reason: typeof entry.reason === 'string' ? entry.reason : '',
  }));
}

export function projectCard(card, guildId) {
  const original = capUtf8(card.original ?? '');
  const notes = capUtf8(card.notes ?? '');
  const discord = { state: card.discordState ?? 'none' };
  if (typeof card.discordThread === 'string' && card.discordThread.length > 0 && guildId) {
    discord.url = `https://discord.com/channels/${guildId}/${card.discordThread}`;
  }
  const out = {
    id: card.id,
    rev: card.rev,
    title: card.title,
    description: card.description,
    status: card.status,
    created: card.created,
    updated: card.updated,
    source: card.source,
    sourceRef: card.sourceRef,
    ...(typeof card.project === 'string' && card.project.length > 0 ? { project: card.project } : {}),
    original: original.text,
    notes: notes.text,
    originalTruncated: original.truncated,
    notesTruncated: notes.truncated,
    discord,
    log: projectLog(card.log),
  };
  if (card.discordState === 'conflict') {
    const candidates = Array.isArray(card.conflictDiscord) ? card.conflictDiscord.filter(isStatus) : [];
    out.conflict = {
      card: isStatus(card.conflictCard) ? card.conflictCard : card.status,
      discord: candidates.length > 0 ? candidates : [card.status],
      since: typeof card.conflictSince === 'string' ? card.conflictSince : card.updated,
    };
  }
  return out;
}

function readJsonSync(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function lastSyncAt(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]);
      if (entry?.event === 'sync-complete' && typeof entry.at === 'string') return entry.at;
    } catch {
      // a torn receipt line is not a sync time
    }
  }
  return null;
}

function gitSync(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
}

export function unpushedCommitsSync(repoPath) {
  try {
    gitSync(repoPath, ['remote', 'get-url', 'origin']);
  } catch {
    return 0;
  }
  let out;
  try {
    out = gitSync(repoPath, ['rev-list', '--count', 'origin/main..HEAD']);
  } catch {
    try {
      out = gitSync(repoPath, ['rev-list', '--count', 'HEAD']);
    } catch {
      return 0;
    }
  }
  const count = Number(String(out).trim());
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

/**
 * One API instance. `config.repoPath` is required; the store, Discord client
 * and clock are injectable so tests never touch a live repo or Discord.
 */
export function createBoardApi(options = {}) {
  const config = options.config ?? {};
  const repoPath = config.repoPath;
  if (typeof repoPath !== 'string' || repoPath.length === 0) {
    throw new TypeError('memento board api needs config.repoPath');
  }
  const now = options.now ?? Date.now;
  const clockNow = () => latestMs(now);
  const replyBudgetMs = Number.isFinite(options.replyBudgetMs) ? options.replyBudgetMs : REPLY_BUDGET_MS;
  const discordBudgetMs = Number.isFinite(options.discordBudgetMs)
    ? options.discordBudgetMs
    : DISCORD_BUDGET_MS;
  const writeLockWaitMs = Number.isFinite(options.writeLockWaitMs)
    ? options.writeLockWaitMs
    : WRITE_LOCK_WAIT_MS;
  const store = options.store ?? openStore(repoPath, {
    lockWaitMs: writeLockWaitMs,
    now,
  });
  const client = options.client ?? createDiscordClient({
    tokenFile: config.tokenFile,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    clock: { now },
  });
  const receipts = options.receipts ?? null;
  const cardsDir = join(repoPath, 'cards');
  const syncFile = join(repoPath, 'sync', 'state.json');
  const lifetime = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) lifetime.abort();
    else options.signal.addEventListener('abort', () => lifetime.abort(), { once: true });
  }
  const requests = new Map();
  const continuations = new Set();

  function record(entry) {
    try {
      receipts?.append?.(entry);
    } catch {
      // receipts never break a write
    }
  }

  function discordSignal() {
    const timeout = AbortSignal.timeout(Math.max(1, discordBudgetMs));
    return AbortSignal.any([lifetime.signal, timeout]);
  }

  function discordReady(state) {
    return Boolean(state && state.guildId && state.forumId
      && state.tagIds && Object.keys(state.tagIds).length > 0
      && typeof config.tokenFile === 'string' && config.tokenFile.length > 0);
  }

  async function mutateState(mutate) {
    if (typeof store.transactSyncState !== 'function') {
      record({ event: 'sync-state-transaction-missing' });
      return { ok: false, code: 'UNSUPPORTED' };
    }
    const result = await store.transactSyncState(mutate, {
      waitMs: writeLockWaitMs,
      message: 'memento: sync state\n',
    });
    if (!result.ok) record({ event: 'sync-state-transaction-failed', code: result.code });
    return result;
  }

  async function clearPending(key) {
    const cleared = await mutateState((state) => {
      state.pending = (state.pending ?? []).filter((entry) => entry?.key !== key);
    });
    if (!cleared.ok) record({ event: 'board-pending-clear-failed', key, code: cleared.code });
    return cleared.ok;
  }

  async function applyCard(id, mutate, log) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await store.get(id);
      if (!current.ok) return null;
      const result = await store.update(id, { expectRev: current.card.rev, mutate, log });
      if (result.ok) return result.card;
      if (result.code === 'BAD_CARD' && result.reason === 'superseded-board-event') {
        // The guard ran against the current card inside the locked mutation; the
        // event that authorized this write is no longer the latest board pick.
        record({ event: 'board-card-write-superseded', id });
        return null;
      }
      if (result.code !== 'STALE') return null;
    }
    return null;
  }

  /** Inside a rev-checked locked mutation: our board event must still be latest. */
  function assertLatestBoardEvent(card, eventId) {
    const latest = [...(card.log ?? [])].reverse()
      .find((entry) => entry.actor === 'owner' && entry.via === 'board');
    if (latest?.eventId !== eventId) {
      const error = new Error('superseded-board-event');
      error.code = 'SUPERSEDED';
      throw error;
    }
  }

  async function latestRev(id, fallback) {
    const current = await store.get(id);
    return current.ok ? current.card.rev : fallback;
  }

  /** The current card plus whether another board pick followed this event. */
  async function refreshBoardCard(cardId, eventId) {
    const current = await store.get(cardId);
    if (!current.ok) return { ok: false, code: current.code };
    const latest = [...(current.card.log ?? [])].reverse()
      .find((entry) => entry.actor === 'owner' && entry.via === 'board');
    return { ok: true, card: current.card, superseded: latest?.eventId !== eventId };
  }

  async function applyConflict(card, statuses, reason, sinceOverride = null) {
    const discord = [...new Set(statuses.filter(isStatus))];
    if (discord.length === 0) discord.push(card.status);
    const current = await store.get(card.id);
    if (!current.ok) return null;
    const already = current.card.discordState === 'conflict'
      && Array.isArray(current.card.conflictDiscord)
      && current.card.conflictDiscord.length === discord.length
      && current.card.conflictDiscord.every((value, index) => value === discord[index]);
    if (already) return current.card;
    const since = current.card.discordState === 'conflict' && current.card.conflictSince
      ? current.card.conflictSince
      : (sinceOverride ?? iso(clockNow()));
    return applyCard(card.id, (next) => {
      next.discordState = 'conflict';
      next.conflictCard = next.status;
      next.conflictDiscord = discord;
      next.conflictSince = since;
    }, { actor: 'memento', via: 'sync', change: 'conflict', reason });
  }

  async function applyInvalid(card, statuses) {
    if (card.discordState === 'invalid') return card;
    return applyCard(card.id, (next) => {
      next.discordState = 'invalid';
      delete next.conflictCard;
      delete next.conflictDiscord;
      delete next.conflictSince;
    }, {
      actor: 'memento',
      via: 'sync',
      change: 'invalid-remote',
      reason: statuses.length === 0 ? 'no-status-tag' : 'multiple-status-tags',
    });
  }

  async function applyDeleted(card) {
    if (card.discordState === 'deleted') return card;
    return applyCard(card.id, (next) => {
      next.discordState = 'deleted';
      delete next.conflictCard;
      delete next.conflictDiscord;
      delete next.conflictSince;
    }, { actor: 'memento', via: 'sync', change: 'remote-deleted', reason: 'thread-missing' });
  }

  async function applyTake(card, status, evidence, eventId) {
    const updated = await applyCard(card.id, (next) => {
      assertLatestBoardEvent(next, eventId);
      next.status = status;
      next.discordBase = status;
      next.discordState = 'linked';
      delete next.conflictCard;
      delete next.conflictDiscord;
      delete next.conflictSince;
    }, {
      actor: 'owner',
      via: 'discord',
      change: 'status',
      from: card.status,
      to: status,
      reason: 'owner-remote',
      ...(typeof evidence === 'string' ? { evidence } : {}),
    });
    if (updated) {
      await mutateState((state) => {
        state.bases = { ...(state.bases ?? {}), [card.id]: iso(clockNow()) };
      });
    }
    return updated;
  }

  async function applyBase(card, status, eventId) {
    if (card.discordBase === status) return card;
    return applyCard(card.id, (next) => {
      assertLatestBoardEvent(next, eventId);
      next.discordBase = status;
    }, {
      actor: 'memento',
      via: 'sync',
      change: 'status',
      from: card.discordBase || card.status,
      to: status,
      reason: 'base-agreed',
    });
  }

  async function applyDecision(card, decision, remoteStatuses, eventId) {
    if (decision.kind === 'none') return card;
    if (decision.kind === 'setBase') {
      const updated = await applyBase(card, decision.status, eventId);
      if (updated) {
        await mutateState((state) => {
          state.bases = { ...(state.bases ?? {}), [card.id]: iso(clockNow()) };
        });
      }
      return updated;
    }
    if (decision.kind === 'take') {
      return applyTake(card, decision.status, decision.evidence?.ownerEntryId ?? null, eventId);
    }
    if (decision.kind === 'markDeleted') return applyDeleted(card);
    if (decision.kind === 'invalidRemote') {
      if (card.discordState === 'conflict') {
        return applyConflict(card, remoteStatuses, 'conflict-remote-invalid');
      }
      return applyInvalid(card, remoteStatuses);
    }
    if (decision.kind === 'conflict') {
      return applyConflict(card, remoteStatuses, decision.reason ?? 'conflict');
    }
    return card;
  }

  async function applyPushSuccess(card, status, window) {
    const updated = await applyCard(card.id, (next) => {
      assertLatestBoardEvent(next, window.eventId);
      next.status = status;
      next.discordBase = status;
      next.discordState = 'linked';
      delete next.conflictCard;
      delete next.conflictDiscord;
      delete next.conflictSince;
    }, {
      actor: 'memento',
      via: 'sync',
      change: 'status',
      from: card.status,
      to: status,
      reason: 'board-push',
      evidence: window.eventId,
    });
    if (!updated) return null;
    const written = await mutateState((state) => {
      state.bases = { ...(state.bases ?? {}), [card.id]: iso(window.patchAt) };
      state.recentWrites = [...(state.recentWrites ?? []), {
        thread: card.discordThread,
        t0: iso(window.t0),
        patchAt: iso(window.patchAt),
        key: window.key,
        cardId: card.id,
        eventId: window.eventId,
        ...(window.botEntryId ? { botEntryId: window.botEntryId } : {}),
      }];
    });
    if (!written.ok) record({ event: 'board-recent-write-failed', id: card.id, code: written.code });
    return updated;
  }

  /** The guarded write-through for one linked card. Never throws. */
  async function guardedWrite(card, eventId) {
    const threadId = card.discordThread;
    const t0 = clockNow();
    const key = `board-${randomUUID()}`;
    const op = { kind: 'status', key, thread: threadId, cardId: card.id, t0: iso(t0), eventId };
    try {
      const registered = await mutateState((state) => {
        state.pending = [...(state.pending ?? []), op];
      });
      if (!registered.ok) {
        record({ event: 'board-pending-failed', id: card.id, code: registered.code });
        return { discord: 'pending', rev: card.rev };
      }
      if (lifetime.signal.aborted) return { discord: 'pending', rev: card.rev };
      const stateRead = await store.readSyncState();
      if (!stateRead.ok) return { discord: 'pending', rev: card.rev };
      const state = stateRead.state;
      const restoreSupported = state.restoreContract === RESTORE_SCHEMA;
      const signal = discordSignal();

      const fresh = await client.getThread(threadId, { signal });
      if (!fresh.ok) {
        if (fresh.gone) {
          await clearPending(key);
          await applyDeleted(card);
          return { discord: 'off', rev: await latestRev(card.id, card.rev) };
        }
        record({ event: 'board-thread-read-failed', id: card.id, code: fresh.error ?? fresh.status });
        return { discord: 'pending', rev: card.rev };
      }
      const remoteStatuses = statusesOf(fresh.data?.applied_tags, state.tagIds);
      const auditRead = await client.getAuditLog({
        guildId: state.guildId, actionType: 111, limit: 100,
      }, { signal });
      if (!auditRead.ok) {
        record({ event: 'board-audit-read-failed', id: card.id, code: auditRead.error ?? auditRead.status });
        return { discord: 'pending', rev: card.rev };
      }
      const raw = auditRead.data ?? [];
      const knownIds = new Set(raw.map((entry) => entry.id));
      const maxId = raw.reduce((best, entry) => (best === null || BigInt(entry.id) > BigInt(best) ? entry.id : best), null);
      const mapped = raw.map((entry) => mapAuditEntry(entry, state)).filter(Boolean);
      const refreshed = await refreshBoardCard(card.id, eventId);
      if (!refreshed.ok) {
        record({ event: 'board-refresh-failed', id: card.id, key, code: refreshed.code });
        return { discord: 'pending', rev: card.rev };
      }
      if (refreshed.superseded) {
        await clearPending(key);
        record({ event: 'board-superseded', id: card.id, key });
        return { discord: 'pending', rev: refreshed.card.rev };
      }
      const current = refreshed.card;
      const baseAt = Date.parse(state.bases?.[current.id] ?? current.created);
      const entries = auditEntriesFor(mapped, threadId, baseAt);
      const since = conflictBoundary(current);
      const decision = reconcile({
        card: {
          status: current.status,
          discordBase: current.discordBase,
          discordState: current.discordState,
          boardEvents: boardEventsOf(current, state, uncertaintyFor(state.clock)),
          ...(since === null ? {} : { conflictSince: since }),
        },
        remote: { exists: true, statusTags: remoteStatuses },
        audit: { coverage: coverageFor(state, t0, baseAt), entries },
      });
      if (decision.kind !== 'push') {
        await clearPending(key);
        const applied = await applyDecision(current, decision, remoteStatuses, eventId);
        const discord = decision.kind === 'conflict' || decision.kind === 'invalidRemote'
          ? 'conflict'
          : 'off';
        record({
          event: 'board-no-push', id: card.id, key, decision: decision.kind, reason: decision.reason,
        });
        return {
          discord,
          rev: applied ? applied.rev : await latestRev(card.id, card.rev),
        };
      }
      if (lifetime.signal.aborted) return { discord: 'pending', rev: card.rev };
      const tagId = state.tagIds[decision.status];
      if (typeof tagId !== 'string' || tagId.length === 0) {
        record({ event: 'board-status-tag-missing', id: card.id, key, status: decision.status });
        return { discord: 'pending', rev: card.rev };
      }
      const archived = Boolean(fresh.data?.thread_metadata?.archived);
      const tags = withStatusTag(
        fresh.data?.applied_tags ?? [], statusTagIds(state), state.tagIds[decision.status],
      );
      const patch = await client.patchThreadTags({
        threadId,
        appliedTags: tags,
        auditReason: `memento-board ${key}`,
        archived,
      }, { signal });
      if (!patch.ok) {
        if (patch.gone) {
          await clearPending(key);
          await applyDeleted(card);
          return { discord: 'off', rev: await latestRev(card.id, card.rev) };
        }
        record({ event: 'board-patch-failed', id: card.id, key, code: patch.error ?? patch.status });
        return { discord: 'pending', rev: card.rev };
      }
      const patchAt = clockNow();
      const after = await client.getAuditLog({
        guildId: state.guildId, actionType: 111, after: maxId ?? '0', limit: 100,
      }, { signal }).catch(() => ({ ok: false, error: 'aborted' }));
      const races = after.ok
        ? (after.data ?? [])
          .filter((entry) => entry.target_id === threadId && entry.user_id === state.ownerUserId)
          .filter((entry) => !knownIds.has(entry.id))
          .map((entry) => mapAuditEntry(entry, state))
          .filter(Boolean)
          .filter((entry) => entry.time + 1_000 >= t0)
        : [];
      const owner = races.at(-1) ?? null;
      const own = after.ok
        ? (after.data ?? []).find((entry) => entry.target_id === threadId
          && entry.user_id === state.botUserId
          && entry.reason === `memento-board ${key}`)
        : null;
      if (owner) {
        const conflictSince = current.discordState === 'conflict' && current.conflictSince
          ? current.conflictSince
          : iso(clockNow());
        const restoreStart = clockNow();
        let restored = { ok: false, reason: 'no-owner-status' };
        if (owner.to) {
          restored = await client.patchThreadTags({
            threadId,
            appliedTags: withStatusTag(
              patch.data?.applied_tags ?? tags, statusTagIds(state), state.tagIds[owner.to],
            ),
            auditReason: `memento-board ${key} restore`,
            archived: Boolean(patch.data?.thread_metadata?.archived ?? archived),
          }, { signal }).catch(() => ({ ok: false, reason: 'aborted' }));
        }
        const restorePatchAt = clockNow();
        // Full-window read with no after-cursor: visibility can lag id order, so a
        // late-visible owner entry may sit below the bot entries already seen.
        // An empty after-cursor result or an HTTP 200 is not completeness proof.
        const restoreAudit = await client.getAuditLog({
          guildId: state.guildId, actionType: 111, limit: 100,
        }, { signal }).catch(() => ({ ok: false, error: 'aborted' }));
        const windowOwners = restoreAudit.ok
          ? (restoreAudit.data ?? [])
            .filter((entry) => entry.target_id === threadId && entry.user_id === state.ownerUserId)
            .map((entry) => mapAuditEntry(entry, state))
            .filter(Boolean)
            .filter((entry) => entry.time + 1_000 >= t0)
            .sort((left, right) => (left.time - right.time)
              || (BigInt(left.entryId) < BigInt(right.entryId) ? -1 : 1))
          : null;
        const latestOwner = windowOwners && windowOwners.length > 0 ? windowOwners.at(-1) : owner;
        const newerEntry = latestOwner && latestOwner.entryId !== owner.entryId ? latestOwner : null;
        const newerStatuses = newerEntry ? statusesOf(newerEntry.toTags ?? [], state.tagIds) : [];
        const newerSingle = newerEntry ? singleStatus(newerStatuses) : null;
        // Retention is unconditional here: the restoration write itself is not
        // verified until the existing delay + complete-coverage rule retires it.
        const candidates = [...new Set([decision.status, owner.to, ...newerStatuses].filter(isStatus))];
        const targetStatus = newerSingle ?? owner.to ?? current.status;
        const ownerEvidence = newerEntry?.entryId ?? owner.entryId;
        const pushedStatus = restored.ok ? owner.to : decision.status;
        const kept = await mutateState((stateDoc) => {
          stateDoc.pending = (stateDoc.pending ?? []).filter((entry) => entry?.key !== key);
          if (restoreSupported && owner.to) {
            stateDoc.pending.push({
              kind: 'status',
              intent: 'restore',
              schema: RESTORE_SCHEMA,
              writer: 'board',
              key: `${key}-restore`,
              thread: threadId,
              cardId: card.id,
              t0: iso(t0),
              patchAt: iso(restorePatchAt),
              eventId,
              targetStatus,
              reason: 'owner-race',
              ownerStatus: targetStatus,
              pushedStatus,
              ownerEntryId: ownerEvidence,
              conflictSince,
              attempts: 0,
            });
          }
          stateDoc.recentWrites = [...(stateDoc.recentWrites ?? []), {
            thread: threadId,
            t0: iso(t0),
            patchAt: iso(patchAt),
            key,
            cardId: card.id,
            eventId,
            ...(own?.id ? { botEntryId: own.id } : {}),
          }];
        });
        const conflicted = await applyConflict(
          current,
          candidates,
          newerEntry
            ? (newerSingle ? 'owner-race-newer' : 'owner-race-ambiguous')
            : 'owner-race',
          conflictSince,
        );
        record({
          event: restoreSupported ? 'board-restore-deferred' : 'board-restore-unadopted',
          id: card.id,
          key,
          target: targetStatus,
          code: kept.ok ? (restored.ok ? 'retained-unverified' : (restored.reason ?? 'restore-failed')) : kept.code,
          ownerEntryId: ownerEvidence,
          newerOwnerEntryId: newerEntry?.entryId ?? null,
          ambiguous: Boolean(newerEntry && !newerSingle),
          restorationApplied: Boolean(restored.ok),
          auditVerified: Boolean(restoreAudit.ok),
          restoreStart: iso(restoreStart),
        });
        return { discord: 'conflict', rev: conflicted?.rev ?? current.rev };
      }
      const latest = await refreshBoardCard(card.id, eventId);
      if (!latest.ok) {
        record({ event: 'board-post-patch-refresh-failed', id: card.id, key, code: latest.code });
        return { discord: 'pending', rev: current.rev };
      }
      if (latest.superseded) {
        await clearPending(key);
        const target = latest.card.status;
        let repaired = { ok: true };
        if (target !== decision.status) {
          if (isStatus(target) && state.tagIds[target]) {
            repaired = await client.patchThreadTags({
              threadId,
              appliedTags: withStatusTag(
                patch.data?.applied_tags ?? tags, statusTagIds(state), state.tagIds[target],
              ),
              auditReason: `memento-board ${key} reassert`,
              archived: Boolean(patch.data?.thread_metadata?.archived ?? archived),
            }, { signal }).catch(() => ({ ok: false, reason: 'aborted' }));
          } else {
            repaired = { ok: false, reason: 'no-target-tag' };
          }
        }
        const noted = await mutateState((stateDoc) => {
          stateDoc.recentWrites = [...(stateDoc.recentWrites ?? []), {
            thread: threadId,
            t0: iso(t0),
            patchAt: iso(patchAt),
            key,
            cardId: card.id,
            eventId,
            ...(own?.id ? { botEntryId: own.id } : {}),
          }];
          if (!repaired.ok && restoreSupported) {
            stateDoc.pending.push({
              kind: 'status',
              intent: 'restore',
              schema: RESTORE_SCHEMA,
              writer: 'board',
              key: `${key}-reassert`,
              thread: threadId,
              cardId: card.id,
              t0: iso(t0),
              patchAt: iso(patchAt),
              eventId,
              targetStatus: target,
              reason: 'superseded-reassert',
              attempts: 0,
            });
          }
        });
        record({
          event: repaired.ok ? 'board-reasserted'
            : (restoreSupported ? 'board-reassert-deferred' : 'board-reassert-unadopted'),
          id: card.id,
          key,
          target,
          code: noted.ok ? undefined : noted.code,
        });
        return { discord: 'pending', rev: latest.card.rev };
      }
      await clearPending(key);
      const updated = await applyPushSuccess(current, decision.status, {
        t0, patchAt, key, eventId,
        botEntryId: own?.id ?? null,
      });
      record({
        event: 'board-pushed',
        id: card.id,
        key,
        rev: updated?.rev ?? null,
        auditVerified: Boolean(after.ok),
      });
      return {
        discord: updated ? 'pushed' : 'pending',
        rev: updated ? updated.rev : await latestRev(card.id, current.rev),
      };
    } catch (error) {
      record({
        event: 'board-write-failed',
        id: card.id,
        key,
        error: String(error?.name ?? 'error'),
      });
      return { discord: 'pending', rev: card.rev };
    }
  }

  function track(work) {
    const settled = work.finally(() => continuations.delete(settled));
    continuations.add(settled);
    return settled;
  }

  async function runSetStatus(body, startedAt = clockNow()) {
    const bad = checkSetStatusBody(body);
    if (bad) return reply(400, { ok: false, code: bad });
    const found = await store.get(body.id);
    if (!found.ok) return reply(400, { ok: false, code: 'UNKNOWN_CARD' });
    if (found.card.rev !== body.rev) {
      return reply(409, { ok: false, code: 'STALE', rev: found.card.rev });
    }
    const stateRead = await store.readSyncState();
    const at = iso(clockNow());
    const eventId = randomUUID();
    const from = found.card.status;
    const updated = await store.update(body.id, {
      expectRev: body.rev,
      mutate: (card) => {
        card.status = body.status;
      },
      log: {
        at,
        eventId,
        actor: 'owner',
        via: 'board',
        change: 'status',
        from,
        to: body.status,
        reason: 'board-set-status',
      },
    });
    if (!updated.ok) {
      if (updated.code === 'STALE') {
        return reply(409, { ok: false, code: 'STALE', rev: updated.rev });
      }
      if (updated.code === 'BUSY') {
        return reply(409, { ok: false, code: 'BUSY' });
      }
      // INDEX_LOCK and every other genuine write/commit failure are not lock
      // contention: report the stable public WRITE_FAILED reply without detail.
      record({ event: 'board-card-write-failed', id: body.id, code: updated.code ?? 'failed' });
      return reply(500, { ok: false, code: 'WRITE_FAILED' });
    }
    const card = updated.card;
    const linked = card.discordThread
      && !['none', 'posting', 'deleted'].includes(card.discordState);
    if (!stateRead.ok || !discordReady(stateRead.state) || !linked) {
      return reply(200, { ok: true, rev: updated.rev, discord: 'off' });
    }
    const work = track(guardedWrite(card, eventId));
    // The budget is anchored at the public handle entry and uses the same clock;
    // all preparation time is subtracted. The reserve is an implementation margin,
    // not a change to the contract, and an exhausted budget never starts a new wait.
    const elapsed = Math.max(0, clockNow() - startedAt);
    const remaining = replyBudgetMs - elapsed - REPLY_RETURN_MARGIN_MS;
    if (remaining <= 0) {
      record({
        event: 'board-write-continues', id: card.id, requestId: body.requestId, exhausted: true,
      });
      return reply(200, { ok: true, rev: updated.rev, discord: 'pending' });
    }
    const outcome = await raceDeadline(work, remaining);
    if (outcome === TIMED_OUT) {
      record({ event: 'board-write-continues', id: card.id, requestId: body.requestId });
      return reply(200, { ok: true, rev: updated.rev, discord: 'pending' });
    }
    return reply(200, {
      ok: true,
      rev: outcome?.rev ?? updated.rev,
      discord: outcome?.discord ?? 'pending',
    });
  }

  async function handle(body) {
    const enteredAt = clockNow();
    const requestId = isObject(body) && typeof body.requestId === 'string' && body.requestId.length > 0
      ? body.requestId
      : null;
    if (requestId && requests.has(requestId)) return cloneReply(await requests.get(requestId));
    const work = runSetStatus(body, enteredAt);
    if (requestId) requests.set(requestId, work);
    return cloneReply(await work);
  }

  function state() {
    const stateDoc = readJsonSync(syncFile);
    const guildId = stateDoc?.guildId ?? null;
    const cards = [];
    const unreadable = [];
    let ok = true;
    let entries = [];
    try {
      entries = readdirSync(cardsDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') ok = false;
    }
    for (const entry of entries
      .filter((item) => item.isFile() && CARD_FILE.test(item.name))
      .sort((left, right) => (left.name < right.name ? -1 : 1))) {
      let parsed;
      try {
        parsed = parse(readFileSync(join(cardsDir, entry.name)));
      } catch {
        unreadable.push({ id: CARD_FILE.exec(entry.name)[1], unreadable: 'invalid', log: [] });
        continue;
      }
      if (parsed.unreadable) {
        unreadable.push({ id: CARD_FILE.exec(entry.name)[1], unreadable: parsed.reason, log: [] });
        continue;
      }
      cards.push(projectCard(parsed.card, guildId));
    }
    cards.sort((left, right) => (Date.parse(right.updated) - Date.parse(left.updated))
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    unreadable.sort((left, right) => (left.id < right.id ? -1 : 1));
    return {
      schema: BOARD_STATE_SCHEMA,
      ok,
      lastSync: lastSyncAt(receipts?.path),
      unpushedCommits: unpushedCommitsSync(repoPath),
      statuses: STATUS_KEYS.map((key) => ({ key, label: STATUS_LABELS[key] })),
      cards: [...cards, ...unreadable],
    };
  }

  const facade = Object.freeze({
    version: API_VERSION,
    features: API_FEATURES,
    state,
    handle,
  });

  return {
    version: API_VERSION,
    features: API_FEATURES,
    state,
    handle,
    publishedObject: () => facade,
    publish(host = globalThis) {
      if (!host || host[API_KEY]) return { published: false, reason: 'occupied' };
      host[API_KEY] = facade;
      return { published: true };
    },
    unpublish(host = globalThis) {
      if (!host || host[API_KEY] !== facade) return false;
      delete host[API_KEY];
      return true;
    },
    abort() {
      lifetime.abort();
    },
    async whenIdle() {
      await Promise.allSettled([...continuations]);
    },
    store,
    client,
  };
}

const TIMED_OUT = Symbol('memento api reply deadline');

function raceDeadline(promise, ms) {
  let timer = null;
  const gate = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(1, ms));
  });
  return Promise.race([promise, gate]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
