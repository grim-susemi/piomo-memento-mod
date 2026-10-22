/**
 * In-process fake Discord HTTP server for deterministic tests and manual QA.
 *
 *   const fake = await startFakeDiscord({ token, ownerUserId, archivedPageSize, auditPageSize });
 *   fake.baseUrl                      // http://127.0.0.1:<port>/api/v10
 *   fake.clock                        // { now, sleep, advance, set } virtual clock
 *   fake.ids                          // { guildId, forumId?, ownerUserId, botUserId, applicationId }
 *   fake.state                        // { guilds, channels, messages, audit, ... }
 *   fake.requests                     // [{ method, path, query, authorized, auditReasonHeader, body }]
 *   fake.openSockets                  // Set<net.Socket> for cleanup proof
 *   await fake.waitForNoOpenSockets() // event-based, bounded wait
 *   await fake.close()                // releases holds and closes every socket
 *
 * Test hooks:
 *   fake.hooks.forceStatus({ method, path, status, body?, rawBody?, headers?, times? })
 *   fake.hooks.rateLimitNext({ method, path }, { retryAfter })
 *   fake.hooks.holdNext({ method, path }) -> { arrived, release }
 *   fake.hooks.ownerSetTags({ threadId, appliedTags, userId?, reason? })
 *   fake.hooks.ownerRoundTrip({ threadId, middleTags, userId? })
 *   fake.hooks.dropAuditEntries(count | predicate)
 *   fake.hooks.delayAuditVisibility() / releaseAuditVisibility()
 *   fake.hooks.delayCreatedThreadVisibility(value = true) / revealThread(threadId)
 *   fake.hooks.setDateSkew(ms)
 *   fake.hooks.setNextThreadOwner(userId)
 *   fake.hooks.seedThread({ forumId, name, ownerId, appliedTags, content, archived, archiveTimestamp })
 *   fake.hooks.archiveThread(threadId) / deleteThread(threadId)
 *
 * Paths are matched without the /api/v10 prefix. The fake never logs the token.
 */
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const API_PREFIX = '/api/v10';
const DISCORD_EPOCH = 1420070400000n;

export function createVirtualClock({ start = 1_700_000_000_000 } = {}) {
  let current = Number(start);
  return {
    now: () => current,
    sleep(ms, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
      current += Math.max(0, Number(ms) || 0);
      return Promise.resolve();
    },
    advance(ms) {
      current += Math.max(0, Number(ms) || 0);
      return current;
    },
    set(ms) {
      current = Number(ms);
      return current;
    },
  };
}

function readBody(request) {
  return new Promise(resolve => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve({ ok: true, value: {} });
      try {
        return resolve({ ok: true, value: JSON.parse(text) });
      } catch {
        return resolve({ ok: false, value: null });
      }
    });
    request.on('error', () => resolve({ ok: false, value: null }));
  });
}

function decodeReason(value) {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function startFakeDiscord(options = {}) {
  const clock = options.clock ?? createVirtualClock();
  const token = options.token ?? 'synthetic-discord-token';
  const archivedPageSize = options.archivedPageSize ?? 100;
  const auditPageSize = options.auditPageSize ?? 100;

  let lastSnowflakeMs = 0n;
  let lastIncrement = 0n;
  function nextSnowflake(atMs = clock.now()) {
    let ms = BigInt(Math.trunc(atMs));
    if (ms < DISCORD_EPOCH) ms = DISCORD_EPOCH;
    if (ms < lastSnowflakeMs) ms = lastSnowflakeMs;
    if (ms === lastSnowflakeMs) {
      lastIncrement = (lastIncrement + 1n) & 0xfffn;
      if (lastIncrement === 0n) ms += 1n;
    } else {
      lastIncrement = 0n;
    }
    lastSnowflakeMs = ms;
    return (((ms - DISCORD_EPOCH) << 22n) | lastIncrement).toString();
  }

  const ownerUserId = options.ownerUserId ?? nextSnowflake();
  const botUserId = options.botUserId ?? nextSnowflake();
  const guildId = options.guildId ?? nextSnowflake();
  const applicationId = options.applicationId ?? nextSnowflake();
  const guild = { id: guildId, name: 'Synthetic Guild', owner_id: ownerUserId };
  const state = {
    botUser: { id: botUserId, username: 'memento-bot', discriminator: '0000', bot: true },
    application: { id: applicationId, name: 'memento-bot', flags: options.applicationFlags ?? 0 },
    guilds: [guild],
    guild,
    members: new Map([
      [ownerUserId, { user: { id: ownerUserId, username: 'owner' }, roles: [], nick: null }],
      [botUserId, { user: { id: botUserId, username: 'memento-bot' }, roles: [], nick: null }],
    ]),
    roles: [{ id: guildId, name: '@everyone', permissions: '0', position: 0, managed: false }],
    channels: new Map(),
    messages: new Map(),
    audit: [],
  };

  const requests = [];
  const openSockets = new Set();
  const forced = [];
  const holds = [];
  let dateSkewMs = 0;
  let auditHeld = false;
  let hideCreatedThreads = false;
  let nextThreadOwner = null;

  function addAudit({ actionType, targetId, userId, changes = [], reason = null }) {
    const entry = {
      id: nextSnowflake(), action_type: actionType, target_id: targetId, user_id: userId,
      changes, reason, visible: !auditHeld, dropped: false,
    };
    state.audit.push(entry);
    return entry;
  }

  function match(rule, method, path) {
    if (!rule) return true;
    if (rule.method && rule.method !== method) return false;
    if (typeof rule.path === 'string') return rule.path === path;
    if (rule.path instanceof RegExp) return rule.path.test(path);
    if (typeof rule.match === 'function') return rule.match({ method, path });
    return true;
  }

  function takeForced(method, path) {
    const index = forced.findIndex(rule => match(rule, method, path));
    if (index < 0) return null;
    const rule = forced[index];
    rule.times -= 1;
    if (rule.times <= 0) forced.splice(index, 1);
    return rule;
  }

  async function takeHold(method, path) {
    const index = holds.findIndex(rule => match(rule, method, path));
    if (index < 0) return;
    const hold = holds.splice(index, 1)[0];
    hold.arrivedResolve({ method, path });
    await hold.gate;
  }

  function sendJson(response, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    response.setHeader('Date', new Date(clock.now() + dateSkewMs).toUTCString());
    response.setHeader('Content-Type', 'application/json');
    for (const [key, value] of Object.entries(extraHeaders)) response.setHeader(key, value);
    response.statusCode = status;
    response.end(payload);
  }

  function sendRaw(response, status, text, extraHeaders = {}) {
    response.setHeader('Date', new Date(clock.now() + dateSkewMs).toUTCString());
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    for (const [key, value] of Object.entries(extraHeaders)) response.setHeader(key, value);
    response.statusCode = status;
    response.end(text);
  }

  function notFound(response, code = 0) {
    sendJson(response, 404, { message: 'Not Found', code });
  }

  function findForum(forumId) {
    const forum = state.channels.get(forumId);
    return forum && forum.type === 15 ? forum : null;
  }

  function forumOr404(response, forumId) {
    const forum = findForum(forumId);
    if (!forum) notFound(response, 10003);
    return forum;
  }

  function threadOr404(response, threadId) {
    const thread = state.channels.get(threadId);
    if (!thread || thread.type !== 11) {
      notFound(response, 10003);
      return null;
    }
    return thread;
  }

  function archive(thread, archived) {
    thread.thread_metadata.archived = archived;
    thread.thread_metadata.archive_timestamp = archived ? new Date(clock.now()).toISOString() : null;
  }

  function threadObject(thread) {
    return { ...thread, thread_metadata: { ...thread.thread_metadata }, applied_tags: [...thread.applied_tags] };
  }

  function channelObject(channel) {
    return channel.type === 11 ? threadObject(channel) : { ...channel, available_tags: [...(channel.available_tags ?? [])] };
  }

  function seedThread(params) {
    const forum = findForum(params.forumId);
    if (!forum) throw new Error('unknown forum');
    const id = params.id ?? nextSnowflake();
    const appliedTags = params.appliedTags ?? [];
    const thread = {
      id, type: 11, guild_id: guildId, parent_id: forum.id,
      owner_id: params.ownerId ?? ownerUserId,
      name: params.name ?? 'seeded thread',
      applied_tags: [...appliedTags],
      thread_metadata: {
        archived: Boolean(params.archived),
        archive_timestamp: params.archived
          ? (params.archiveTimestamp ?? new Date(clock.now()).toISOString())
          : null,
        auto_archive_duration: forum.default_auto_archive_duration,
      },
      hidden: Boolean(params.hidden),
    };
    state.channels.set(id, thread);
    state.messages.set(id, {
      id, channel_id: id, content: params.content ?? '', author: { ...state.botUser },
      timestamp: new Date(clock.now()).toISOString(),
    });
    return thread;
  }

  const hooks = {
    forceStatus(rule) {
      forced.push({
        method: rule.method, path: rule.path, match: rule.match,
        status: rule.status, body: rule.body, rawBody: rule.rawBody,
        headers: rule.headers ?? {}, times: rule.times ?? 1,
      });
      return hooks;
    },
    rateLimitNext(rule, { retryAfter = 1 } = {}) {
      return hooks.forceStatus({
        ...rule, status: 429,
        body: { message: 'You are being rate limited.', retry_after: retryAfter, global: false },
        headers: { 'X-RateLimit-Reset-After': String(retryAfter) },
      });
    },
    holdNext(rule) {
      let arrivedResolve;
      let releaseResolve;
      const arrived = new Promise(resolve => { arrivedResolve = resolve; });
      const gate = new Promise(resolve => { releaseResolve = resolve; });
      const hold = {
        method: rule.method, path: rule.path, match: rule.match,
        arrived, gate, arrivedResolve, release: () => releaseResolve(),
      };
      holds.push(hold);
      return { arrived, release: hold.release };
    },
    ownerSetTags({ threadId, appliedTags, userId = ownerUserId, reason = null }) {
      const thread = state.channels.get(threadId);
      if (!thread) throw new Error(`unknown thread ${threadId}`);
      const oldValue = [...thread.applied_tags];
      thread.applied_tags = [...appliedTags];
      return addAudit({
        actionType: 111, targetId: threadId, userId, reason,
        changes: [{ key: 'applied_tags', old_value: oldValue, new_value: [...appliedTags] }],
      });
    },
    ownerRoundTrip({ threadId, middleTags, userId = ownerUserId }) {
      const thread = state.channels.get(threadId);
      if (!thread) throw new Error(`unknown thread ${threadId}`);
      const before = [...thread.applied_tags];
      const first = hooks.ownerSetTags({ threadId, appliedTags: middleTags, userId });
      const second = hooks.ownerSetTags({ threadId, appliedTags: before, userId });
      return { before, middle: [...middleTags], after: [...thread.applied_tags], entries: [first, second] };
    },
    dropAuditEntries(countOrPredicate = 1) {
      const predicate = typeof countOrPredicate === 'function' ? countOrPredicate : null;
      const limit = typeof countOrPredicate === 'number' ? countOrPredicate : Infinity;
      let marked = 0;
      for (let index = state.audit.length - 1; index >= 0 && marked < limit; index -= 1) {
        const entry = state.audit[index];
        if ((!predicate || predicate(entry)) && !entry.dropped) {
          entry.dropped = true;
          marked += 1;
        }
      }
      return marked;
    },
    delayAuditVisibility() { auditHeld = true; },
    releaseAuditVisibility() {
      auditHeld = false;
      for (const entry of state.audit) if (!entry.dropped) entry.visible = true;
    },
    delayCreatedThreadVisibility(value = true) { hideCreatedThreads = Boolean(value); },
    revealThread(threadId) {
      const thread = state.channels.get(threadId);
      if (thread) thread.hidden = false;
      return thread;
    },
    setDateSkew(ms) { dateSkewMs = Number(ms) || 0; },
    setNextThreadOwner(userId) { nextThreadOwner = userId ?? null; },
    seedThread,
    archiveThread(threadId) {
      const thread = state.channels.get(threadId);
      if (thread) archive(thread, true);
      return thread;
    },
    deleteThread(threadId) {
      const thread = state.channels.get(threadId);
      state.channels.delete(threadId);
      state.messages.delete(threadId);
      return thread;
    },
  };

  async function handle(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    let path = url.pathname;
    if (path.startsWith(API_PREFIX)) path = path.slice(API_PREFIX.length) || '/';
    const method = request.method ?? 'GET';
    const entry = {
      method, path, query: Object.fromEntries(url.searchParams.entries()),
      authorized: request.headers.authorization === `Bot ${token}`,
      auditReasonHeader: request.headers['x-audit-log-reason'] ?? null,
      body: null, at: clock.now(),
    };
    requests.push(entry);

    const forcedResponse = takeForced(method, path);
    if (forcedResponse) {
      if (forcedResponse.rawBody !== undefined) {
        return sendRaw(response, forcedResponse.status, forcedResponse.rawBody, forcedResponse.headers);
      }
      return sendJson(response, forcedResponse.status, forcedResponse.body ?? {}, forcedResponse.headers);
    }
    await takeHold(method, path);

    if (!entry.authorized) {
      return sendJson(response, 401, { message: '401: Unauthorized', code: 0 });
    }

    if (method !== 'GET' && method !== 'DELETE') {
      const parsed = await readBody(request);
      if (!parsed.ok) return sendJson(response, 400, { message: 'Invalid Form Body', code: 50109 });
      entry.body = parsed.value;
    }
    const body = entry.body ?? {};
    const reason = decodeReason(entry.auditReasonHeader);

    if (method === 'GET' && path === '/users/@me') return sendJson(response, 200, state.botUser);
    if (method === 'GET' && path === '/applications/@me') return sendJson(response, 200, state.application);
    if (method === 'GET' && path === '/users/@me/guilds') return sendJson(response, 200, state.guilds);

    let found = path.match(/^\/guilds\/([^/]+)$/);
    if (method === 'GET' && found) {
      if (found[1] !== guildId) return notFound(response, 10004);
      return sendJson(response, 200, state.guild);
    }
    found = path.match(/^\/guilds\/([^/]+)\/members\/([^/]+)$/);
    if (method === 'GET' && found) {
      const member = state.members.get(found[2]);
      if (!member) return notFound(response, 10007);
      return sendJson(response, 200, member);
    }
    found = path.match(/^\/guilds\/([^/]+)\/roles$/);
    if (method === 'GET' && found) return sendJson(response, 200, state.roles);

    found = path.match(/^\/guilds\/([^/]+)\/channels$/);
    if (method === 'POST' && found) {
      const tags = (body.available_tags ?? []).map(tag => ({
        id: nextSnowflake(), name: tag.name, moderated: Boolean(tag.moderated),
        emoji_id: tag.emoji_id ?? null, emoji_name: tag.emoji_name ?? null,
      }));
      const channel = {
        id: nextSnowflake(), type: body.type ?? 15, guild_id: found[1],
        name: body.name, available_tags: tags,
        permission_overwrites: body.permission_overwrites ?? [],
        default_auto_archive_duration: body.default_auto_archive_duration ?? 1440,
        topic: body.topic ?? null,
      };
      state.channels.set(channel.id, channel);
      addAudit({ actionType: 10, targetId: channel.id, userId: botUserId, reason, changes: [] });
      return sendJson(response, 201, channel);
    }

    found = path.match(/^\/guilds\/([^/]+)\/threads\/active$/);
    if (method === 'GET' && found) {
      const threads = [...state.channels.values()]
        .filter(channel => channel.type === 11 && channel.parent_id && !channel.hidden
          && !channel.thread_metadata.archived)
        .sort((left, right) => (BigInt(right.id) > BigInt(left.id) ? 1 : -1))
        .map(threadObject);
      return sendJson(response, 200, { threads, members: [] });
    }

    found = path.match(/^\/guilds\/([^/]+)\/audit-logs$/);
    if (method === 'GET' && found) {
      const actionType = url.searchParams.get('action_type');
      const after = url.searchParams.get('after');
      const before = url.searchParams.get('before');
      const limit = Math.min(Number(url.searchParams.get('limit')) || auditPageSize, auditPageSize);
      let entries = state.audit.filter(item => item.visible !== false && !item.dropped);
      if (actionType !== null) entries = entries.filter(item => item.action_type === Number(actionType));
      if (after !== null) entries = entries.filter(item => BigInt(item.id) > BigInt(after));
      if (before !== null) entries = entries.filter(item => BigInt(item.id) < BigInt(before));
      entries.sort((left, right) => (after !== null
        ? (BigInt(left.id) < BigInt(right.id) ? -1 : 1)
        : (BigInt(left.id) > BigInt(right.id) ? -1 : 1)));
      return sendJson(response, 200, { audit_log_entries: entries.slice(0, limit), users: [] });
    }

    found = path.match(/^\/channels\/([^/]+)\/threads$/);
    if (method === 'POST' && found) {
      const forum = forumOr404(response, found[1]);
      if (!forum) return undefined;
      if (!body.name || typeof body.name !== 'string') {
        return sendJson(response, 400, { message: 'name is required', code: 50035 });
      }
      if ((body.applied_tags ?? []).length > 5) {
        return sendJson(response, 400, { message: 'too many tags', code: 50035 });
      }
      const id = nextSnowflake();
      const thread = {
        id, type: 11, guild_id: guildId, parent_id: forum.id,
        owner_id: nextThreadOwner ?? botUserId,
        name: body.name,
        applied_tags: [...(body.applied_tags ?? [])],
        thread_metadata: {
          archived: false, archive_timestamp: null,
          auto_archive_duration: forum.default_auto_archive_duration,
        },
        hidden: hideCreatedThreads,
      };
      nextThreadOwner = null;
      const message = {
        id, channel_id: id, content: body.message?.content ?? '',
        author: { ...state.botUser }, timestamp: new Date(clock.now()).toISOString(),
      };
      state.channels.set(id, thread);
      state.messages.set(id, message);
      addAudit({ actionType: 110, targetId: id, userId: botUserId, reason, changes: [] });
      return sendJson(response, 201, { ...threadObject(thread), message });
    }

    found = path.match(/^\/channels\/([^/]+)\/threads\/archived\/public$/);
    if (method === 'GET' && found) {
      const forum = forumOr404(response, found[1]);
      if (!forum) return undefined;
      const before = url.searchParams.get('before');
      const limit = Math.min(Number(url.searchParams.get('limit')) || archivedPageSize, archivedPageSize);
      let threads = [...state.channels.values()]
        .filter(channel => channel.type === 11 && channel.parent_id === forum.id
          && channel.thread_metadata.archived && !channel.hidden)
        .sort((left, right) => {
          const delta = Date.parse(right.thread_metadata.archive_timestamp)
            - Date.parse(left.thread_metadata.archive_timestamp);
          return delta !== 0 ? delta : (BigInt(right.id) > BigInt(left.id) ? 1 : -1);
        });
      if (before) {
        const cutoff = Date.parse(before);
        threads = threads.filter(thread => Date.parse(thread.thread_metadata.archive_timestamp) < cutoff);
      }
      const page = threads.slice(0, limit);
      return sendJson(response, 200, {
        threads: page.map(threadObject), members: [], has_more: threads.length > page.length,
      });
    }

    found = path.match(/^\/channels\/([^/]+)\/messages\/([^/]+)$/);
    if (method === 'GET' && found) {
      const thread = threadOr404(response, found[1]);
      if (!thread) return undefined;
      const message = state.messages.get(found[2]);
      if (!message) return notFound(response, 10008);
      return sendJson(response, 200, message);
    }

    found = path.match(/^\/channels\/([^/]+)$/);
    if (found) {
      const channel = state.channels.get(found[1]);
      if (!channel) return notFound(response, 10003);
      if (method === 'GET') return sendJson(response, 200, channelObject(channel));
      if (method === 'PATCH') {
        if (channel.type === 15) {
          if (body.name !== undefined) channel.name = body.name;
          if (body.topic !== undefined) channel.topic = body.topic;
          if (Array.isArray(body.available_tags)) {
            channel.available_tags = body.available_tags.map(tag => ({
              id: tag.id ?? nextSnowflake(), name: tag.name, moderated: Boolean(tag.moderated),
              emoji_id: tag.emoji_id ?? null, emoji_name: tag.emoji_name ?? null,
            }));
          }
          return sendJson(response, 200, channelObject(channel));
        }
        if (channel.thread_metadata.archived && body.archived !== false) {
          return sendJson(response, 400, { message: 'Thread is archived', code: 50083 });
        }
        const changes = [];
        if (body.name !== undefined && body.name !== channel.name) {
          changes.push({ key: 'name', old_value: channel.name, new_value: body.name });
          channel.name = body.name;
        }
        if (Array.isArray(body.applied_tags)) {
          changes.push({
            key: 'applied_tags',
            old_value: [...channel.applied_tags],
            new_value: [...body.applied_tags],
          });
          channel.applied_tags = [...body.applied_tags];
        }
        if (body.archived === true) {
          changes.push({ key: 'archived', old_value: false, new_value: true });
          archive(channel, true);
        } else if (body.archived === false) {
          changes.push({ key: 'archived', old_value: true, new_value: false });
          archive(channel, false);
        }
        addAudit({ actionType: 111, targetId: channel.id, userId: botUserId, reason, changes });
        return sendJson(response, 200, threadObject(channel));
      }
      if (method === 'DELETE') {
        state.channels.delete(channel.id);
        state.messages.delete(channel.id);
        addAudit({ actionType: 112, targetId: channel.id, userId: botUserId, reason, changes: [] });
        response.setHeader('Date', new Date(clock.now() + dateSkewMs).toUTCString());
        response.statusCode = 204;
        return response.end();
      }
    }

    return notFound(response, 0);
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { message: 'fake server error', code: 0 });
      else response.end();
    });
  });
  server.on('connection', socket => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  async function waitForNoOpenSockets(timeoutMs = 2_000) {
    if (openSockets.size === 0) return true;
    const sockets = [...openSockets];
    const controller = new AbortController();
    let remaining = sockets.length;
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const onClose = () => {
      remaining -= 1;
      if (remaining <= 0 || openSockets.size === 0) resolveClosed(true);
    };
    for (const socket of sockets) socket.once('close', onClose);
    if (openSockets.size === 0) resolveClosed(true);
    try {
      const timeout = delay(timeoutMs, undefined, { signal: controller.signal }).then(() => {
        throw new Error(`sockets still open: ${openSockets.size}`);
      });
      return await Promise.race([closed, timeout]);
    } finally {
      controller.abort();
      for (const socket of sockets) socket.off('close', onClose);
    }
  }

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    for (const hold of holds.splice(0)) hold.release();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(() => resolve()));
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${port}${API_PREFIX}`,
    origin: `http://127.0.0.1:${port}`,
    token,
    clock,
    ids: { guildId, ownerUserId, botUserId, applicationId },
    state,
    requests,
    openSockets,
    hooks,
    waitForNoOpenSockets,
    close,
  };
}
