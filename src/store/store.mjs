import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CardFormatError,
  SOURCES,
  EVENT_ACTORS,
  EVENT_VIA,
  normalizeIntake,
  parse,
  serialize,
} from '../card/codec.mjs';
import { newId } from '../card/id.mjs';
import { acquire, release } from './lock.mjs';
import {
  commitPaths,
  git as runGit,
  isIndexLocked,
  pathDirty,
  push as gitPush,
  unpushedCount as gitUnpushedCount,
} from './git.mjs';

const ID_RE = /^\d{8}-[a-z2-7]{4}$/;
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_DELAYS_MS = [10, 20, 40, 80, 160, 320, 500];
const READ_DELAYS_MS = [2, 4, 8, 16, 32, 64, 100];
const ID_ATTEMPTS = 8;
export const SYNC_SCHEMA = 'memento.sync.v1';

function nowMs(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value.getTime() : Number(value);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function emptySyncState(repoId) {
  return {
    schema: SYNC_SCHEMA,
    repoId,
    guildId: null,
    forumId: null,
    tagIds: {},
    ownerUserId: null,
    botUserId: null,
    audit: { lastEntryId: null, coveredSince: null, ingested: [] },
    pending: [],
    recentWrites: [],
    skipped: [],
    clock: null,
  };
}

function syncStateReason(state) {
  if (!isObject(state)) return 'state';
  if (state.schema !== SYNC_SCHEMA) return 'schema';
  if (typeof state.repoId !== 'string' || state.repoId.length === 0) return 'repo_id';
  if (!isObject(state.tagIds)) return 'tag_ids';
  if (!isObject(state.audit) || !Array.isArray(state.audit.ingested)) return 'audit';
  for (const key of ['pending', 'recentWrites', 'skipped']) {
    if (!Array.isArray(state[key])) return key;
  }
  return null;
}

function badCard(error) {
  const reason = error instanceof CardFormatError ? error.code : 'invalid';
  return { ok: false, code: 'BAD_CARD', reason };
}

function eventList(log, at, nextEventId) {
  const source = Array.isArray(log) ? log : [log];
  if (source.length === 0 || source.some((event) => !isObject(event))) return null;
  return source.map((event) => ({
    ...event,
    at: event.at ?? at,
    eventId: event.eventId ?? nextEventId(),
  }));
}

export function openStore(repoPath, options = {}) {
  const root = repoPath;
  const cardsDir = join(root, 'cards');
  const syncDir = join(root, 'sync');
  const syncFile = join(syncDir, 'state.json');
  const sleep = options.sleep ?? ((ms) => delay(ms));
  const now = options.now ?? Date.now;
  const rand = options.rand ?? randomBytes;
  const nextEventId = options.eventId ?? randomUUID;
  const hooks = options.hooks ?? {};
  const lockWaitMs = options.lockWaitMs ?? 1000;
  const staleMs = options.staleMs;
  const sessionId = options.sessionId;

  async function readMaybe(path) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await readFile(path);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          if (attempt < READ_DELAYS_MS.length && await tmpSiblingExists(path)) {
            await sleep(READ_DELAYS_MS[attempt]);
            continue;
          }
          return null;
        }
        if (!RETRY_CODES.has(error?.code) || attempt >= READ_DELAYS_MS.length) throw error;
        await sleep(READ_DELAYS_MS[attempt]);
      }
    }
  }

  async function tmpSiblingExists(path) {
    try {
      const prefix = `.${basename(path)}.`;
      const entries = await readdir(dirname(path));
      return entries.some((name) => name.startsWith(prefix) && name.endsWith('.tmp'));
    } catch {
      return false;
    }
  }

  async function writeAtomic(kind, target, bytes, writeOptions = {}) {
    await mkdir(dirname(target), { recursive: true });
    const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, bytes, { flag: 'wx' });
    try {
      const beforeRename = Object.hasOwn(writeOptions, 'beforeRename') ? writeOptions.beforeRename : hooks.beforeRename;
      if (beforeRename) await beforeRename({ kind, tmp, target });
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tmp, target);
        return;
      } catch (error) {
        if (!RETRY_CODES.has(error?.code) || attempt >= RENAME_DELAYS_MS.length) {
          await unlink(tmp).catch(() => {});
          throw error;
        }
        await sleep(RENAME_DELAYS_MS[attempt]);
      }
    }
  }

  async function withWrite(run) {
    const lock = await acquire(root, 'write', {
      waitMs: lockWaitMs,
      scheduler: { sleep },
      now,
      ...(staleMs === undefined ? {} : { staleMs }),
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    if (!lock.ok) return { ok: false, code: 'BUSY', busy: true };
    try {
      return await run();
    } finally {
      await release(lock);
    }
  }

  function indexLocked(extra = {}) {
    return { ok: false, code: 'INDEX_LOCK', skipped: 'index-lock', commit: { skipped: 'index-lock' }, ...extra };
  }

  async function rollbackWrite(file, previousBytes) {
    try {
      if (previousBytes === null) {
        try {
          await unlink(join(root, file));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      } else {
        await writeAtomic('rollback', join(root, file), previousBytes, { beforeRename: null });
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
    try {
      const status = await runGit(root, ['status', '--porcelain', '--', file]);
      if (!status.ok) {
        return { ok: false, error: status.stderr || String(status.code), indexRestored: false, indexDirty: true };
      }
      const staged = status.stdout.split(/\r?\n/).some((line) => line.length > 2 && line[0] !== '?' && line[0] !== ' ');
      if (!staged) return { ok: true, indexRestored: true };
      if (isIndexLocked(root)) {
        return { ok: false, error: 'index-lock', indexRestored: false, indexDirty: true };
      }
      const reset = await runGit(root, ['reset', '--', file]);
      if (!reset.ok) {
        return { ok: false, error: reset.stderr || String(reset.code), indexRestored: false, indexDirty: true };
      }
      return { ok: true, indexRestored: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), indexRestored: false, indexDirty: true };
    }
  }

  function commitFailure(commit, rollback, details) {
    return {
      ok: false,
      code: commit.code ?? 'COMMIT_FAILED',
      ...(commit.skipped ? { skipped: commit.skipped } : {}),
      written: !rollback.ok,
      rolledBack: rollback.ok,
      ...(rollback.ok ? {} : { rollbackError: rollback.error }),
      ...(rollback.indexRestored === undefined ? {} : { indexRestored: rollback.indexRestored }),
      ...(rollback.indexDirty ? { indexDirty: true } : {}),
      committed: false,
      commit,
      ...details,
    };
  }

  function dirtyCommitFailure(commit, state) {
    return {
      ok: false,
      code: commit.code ?? 'COMMIT_FAILED',
      ...(commit.skipped ? { skipped: commit.skipped } : {}),
      changed: false,
      committed: false,
      dirty: true,
      written: false,
      rolledBack: false,
      commit,
      state,
    };
  }

  async function readCard(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, code: 'BAD_ID' };
    const file = `cards/${id}.md`;
    const bytes = await readMaybe(join(cardsDir, `${id}.md`));
    if (bytes === null) return { ok: false, code: 'NOT_FOUND' };
    const parsed = parse(bytes);
    if (parsed.unreadable) return { ok: false, code: 'UNREADABLE', reason: parsed.reason, file };
    return { ok: true, card: parsed.card, file, bytes };
  }

  async function list() {
    let entries;
    try {
      entries = await readdir(cardsDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return { cards: [], unreadable: [] };
      throw error;
    }
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort();
    const cards = [];
    const unreadable = [];
    for (const name of names) {
      const bytes = await readMaybe(join(cardsDir, name));
      if (bytes === null) continue;
      const parsed = parse(bytes);
      if (parsed.unreadable) unreadable.push({ file: `cards/${name}`, reason: parsed.reason });
      else cards.push(parsed.card);
    }
    return { cards, unreadable };
  }

  async function get(id) {
    const found = await readCard(id);
    if (!found.ok) return found;
    return { ok: true, card: found.card, file: found.file };
  }

  function baseCard(input, id, at) {
    const card = {
      description: normalizeIntake(input.description),
      id,
      status: 'idea',
      created: at,
      updated: at,
      source: input.source,
      sourceRef: normalizeIntake(input.sourceRef),
      rev: 1,
      discordChannel: '',
      discordThread: '',
      discordBase: '',
      discordState: 'none',
      title: normalizeIntake(input.title),
      original: normalizeIntake(input.original),
      notes: normalizeIntake(input.notes ?? ''),
      log: [{
        at,
        eventId: nextEventId(),
        actor: input.actor,
        via: input.via,
        change: 'create',
        reason: input.reason ?? 'created',
      }],
      schema: 'memento.card.v1',
    };
    if (input.project !== undefined && input.project !== '') card.project = normalizeIntake(input.project);
    return card;
  }

  async function create(input = {}) {
    if (!isObject(input)) return { ok: false, code: 'BAD_CARD', reason: 'input' };
    if (!SOURCES.includes(input.source) || !EVENT_VIA.includes(input.via) || !EVENT_ACTORS.includes(input.actor)) {
      return { ok: false, code: 'BAD_CARD', reason: 'input' };
    }
    return withWrite(async () => {
      if (isIndexLocked(root)) return indexLocked();
      for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
        const id = input.id ?? newId(nowMs(now), rand);
        if (!ID_RE.test(id)) return { ok: false, code: 'BAD_CARD', reason: 'id' };
        const file = `cards/${id}.md`;
        if (existsSync(join(root, file))) {
          if (input.id !== undefined) return { ok: false, code: 'EXISTS', id };
          continue;
        }
        let card;
        let bytes;
        try {
          card = baseCard(input, id, iso(nowMs(now)));
          bytes = serialize(card);
        } catch (error) {
          return badCard(error);
        }
        await writeAtomic('card', join(root, file), bytes);
        const commit = await commitPaths(root, [file], `memento: create ${id}\n\n${card.description}\n`);
        if (!commit.ok) {
          const rollback = await rollbackWrite(file, null);
          return commitFailure(commit, rollback, { id, rev: 1, file, card });
        }
        return { ok: true, written: true, committed: commit.changed !== false, id, rev: 1, file, card, commit };
      }
      return { ok: false, code: 'ID_COLLISION' };
    });
  }

  async function update(id, change = {}) {
    if (!Number.isInteger(change.expectRev) || change.expectRev < 0) {
      return { ok: false, code: 'BAD_REQUEST', reason: 'expectRev' };
    }
    return withWrite(async () => {
      if (isIndexLocked(root)) return indexLocked();
      const found = await readCard(id);
      if (!found.ok) return found;
      if (found.card.rev !== change.expectRev) {
        return { ok: false, code: 'STALE', rev: found.card.rev, expectedRev: change.expectRev };
      }
      const next = structuredClone(found.card);
      let mutated;
      try {
        mutated = typeof change.mutate === 'function' ? (change.mutate(next) ?? next) : next;
      } catch (error) {
        return { ok: false, code: 'BAD_CARD', reason: String(error?.message ?? error) };
      }
      if (!isObject(mutated) || mutated.id !== id) return { ok: false, code: 'BAD_CARD', reason: 'id' };
      const at = iso(nowMs(now));
      const events = eventList(change.log, at, nextEventId);
      if (events === null) return { ok: false, code: 'BAD_CARD', reason: 'log' };
      mutated.rev = change.expectRev + 1;
      mutated.updated = at;
      mutated.log = [...found.card.log, ...events];
      let bytes;
      try {
        bytes = serialize(mutated);
      } catch (error) {
        return badCard(error);
      }
      await writeAtomic('card', join(root, found.file), bytes);
      const reason = events[events.length - 1].reason;
      const commit = await commitPaths(root, [found.file], `memento: update ${id} rev ${mutated.rev}\n\n${reason}\n`);
      if (!commit.ok) {
        const rollback = await rollbackWrite(found.file, found.bytes);
        return commitFailure(commit, rollback, { id, rev: found.card.rev, file: found.file, card: found.card });
      }
      return { ok: true, written: true, committed: commit.changed !== false, id, rev: mutated.rev, file: found.file, card: mutated, commit };
    });
  }

  async function readSyncState() {
    const bytes = await readMaybe(syncFile);
    if (bytes === null) return { ok: false, code: 'MISSING' };
    let state;
    try {
      state = JSON.parse(bytes.toString('utf8'));
    } catch {
      return { ok: false, code: 'UNREADABLE', reason: 'json' };
    }
    const reason = syncStateReason(state);
    if (reason) return { ok: false, code: 'UNREADABLE', reason };
    return { ok: true, state };
  }

  async function writeSyncState(state) {
    const reason = syncStateReason(state);
    if (reason) return { ok: false, code: 'BAD_REQUEST', reason };
    return withWrite(async () => {
      const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      const existing = await readMaybe(syncFile);
      if (existing && existing.equals(bytes)) {
        const dirty = await pathDirty(root, 'sync/state.json');
        if (!dirty) return { ok: true, changed: false, committed: false, state };
        if (isIndexLocked(root)) {
          return indexLocked({ changed: false, committed: false, dirty: true, state });
        }
        const commit = await commitPaths(root, ['sync/state.json'], 'memento: sync state\n');
        if (!commit.ok) return dirtyCommitFailure(commit, state);
        if (commit.changed === false) {
          return dirtyCommitFailure({ ...commit, ok: false, code: 'COMMIT_FAILED' }, state);
        }
        return { ok: true, changed: false, committed: true, state, commit };
      }
      if (isIndexLocked(root)) return indexLocked();
      await writeAtomic('sync', syncFile, bytes);
      const commit = await commitPaths(root, ['sync/state.json'], 'memento: sync state\n');
      if (!commit.ok) {
        const rollback = await rollbackWrite('sync/state.json', existing);
        return commitFailure(commit, rollback, { state, changed: false });
      }
      return { ok: true, changed: true, committed: commit.changed !== false, state, commit };
    });
  }

  return {
    root,
    cardsDir,
    syncFile,
    list,
    get,
    create,
    update,
    readSyncState,
    writeSyncState,
    push: (pushOptions) => gitPush(root, pushOptions),
    unpushedCount: (countOptions) => gitUnpushedCount(root, countOptions),
  };
}
