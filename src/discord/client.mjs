/**
 * Discord REST v10 client for the memento forum mirror.
 *
 * Public contract for downstream tasks:
 *   createDiscordClient({ tokenFile, baseUrl?, clock?, now?, sleep?, requestTimeoutMs? })
 *   client.getMe(options?)                         -> envelope (data = user)
 *   client.getApplication(options?)                -> envelope (data = application)
 *   client.listMyGuilds(options?)                  -> envelope (data = guild[])
 *   client.getGuild(guildId, options?)             -> envelope (data = guild)
 *   client.getGuildMember(guildId, userId, options?) -> envelope (data = member)
 *   client.getGuildRoles(guildId, options?)        -> envelope (data = role[])
 *   client.createForumChannel({ guildId, name, tags, permissionOverwrites,
 *       defaultAutoArchiveDuration = 10080, auditReason }, options?) -> envelope
 *   client.createForumPost({ forumId, name, content, appliedTags, auditReason }, options?)
 *   client.getThread(threadId, options?)           -> envelope (data = channel)
 *   client.getStarterMessage(threadId, options?)   -> envelope (data = message)
 *   client.patchThreadTags({ threadId, appliedTags, auditReason, archived? }, options?)
 *   client.listActiveForumThreads({ guildId, forumId }, options?)
 *   client.listArchivedForumThreads(forumId, options?)
 *   client.getAuditLog({ guildId, actionType, before?, after?, limit = 100 }, options?)
 *   client.archiveThread(threadId, options?)
 *   client.deleteThread(threadId, options?)
 *   withStatusTag(applied, statusTagIds, newTagId)
 *   snowflakeTime(id) -> epoch milliseconds (number)
 *
 * options = { signal?, deadlineSignal? }. A per-call deadline signal defaults to
 * requestTimeoutMs (10 s). Every method resolves an envelope:
 *   { ok, status, data, headers, date, sentAt, receivedAt, attempts,
 *     error?, message?, code?, forbidden?, gone?, retryAfterMs? }
 * `date` is the parsed Discord Date header; sentAt/receivedAt are local epoch ms.
 * No method throws for network, token-file or HTTP failure. The token is read
 * from tokenFile on every call and is [redacted] in every error message.
 */
import { readFileSync } from 'node:fs';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

export const DEFAULT_BASE_URL = 'https://discord.com/api/v10';
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_RETRIES = 3;
export const MAX_REQUESTS_PER_SECOND = 40;
export const USER_AGENT = 'DiscordBot (https://github.com/grim-susemi/piomo-memento-mod, 0.1.0)';

const RATE_WINDOW_MS = 1_000;
const REDACTED = '[redacted]';

function redact(value, token) {
  const text = String(value ?? '');
  return token ? text.split(token).join(REDACTED) : text;
}

function redactHeaders(headers, token) {
  const result = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const redactedValue = Array.isArray(value)
      ? value.map(item => (typeof item === 'string' ? redact(item, token) : item))
      : (typeof value === 'string' ? redact(value, token) : value);
    result[redact(name, token)] = redactedValue;
  }
  return result;
}

function sleepReal(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function querySuffix(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function parseBody(buffer) {
  const text = buffer.toString('utf8');
  if (text.trim() === '') return { ok: true, value: null, text };
  try {
    return { ok: true, value: JSON.parse(text), text };
  } catch {
    return { ok: false, value: null, text };
  }
}

function retryDelayMs(headers, body) {
  const bodySeconds = Number(body?.retry_after);
  const headerSeconds = Number(headers['x-ratelimit-reset-after']);
  const bodyValid = Number.isFinite(bodySeconds) && bodySeconds >= 0;
  const headerValid = Number.isFinite(headerSeconds) && headerSeconds >= 0;
  if (!bodyValid && !headerValid) return null;
  return Math.round(Math.max(bodyValid ? bodySeconds : 0, headerValid ? headerSeconds : 0) * 1_000);
}

function failure(error, message, extra = {}) {
  return {
    ok: false, status: null, data: null, headers: {}, date: null,
    sentAt: null, receivedAt: null, error, message, ...extra,
  };
}

function requestOnce({ method, url, token, payload, extraHeaders, signal, deadlineSignal,
  now, requestTimeoutMs }) {
  return new Promise(resolve => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve(failure('bad-url', 'invalid Discord base URL', { attempts: 1 }));
      return;
    }
    const secure = target.protocol === 'https:';
    const agent = secure
      ? new HttpsAgent({ keepAlive: true, maxSockets: 4 })
      : new HttpAgent({ keepAlive: true, maxSockets: 4 });
    const deadline = deadlineSignal ?? AbortSignal.timeout(requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const sentAt = now();
    let receivedAt = null;
    let settled = false;
    let request;

    const finish = result => {
      if (settled) return;
      settled = true;
      combined.removeEventListener('abort', onAbort);
      agent.destroy();
      resolve({ ...result, sentAt, receivedAt: receivedAt ?? now() });
    };
    const abortedError = () => (deadline.aborted ? 'timeout' : 'aborted');
    function onAbort() {
      finish(failure(abortedError(), 'request aborted'));
      request?.destroy();
    }

    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      Authorization: `Bot ${token}`,
      ...extraHeaders,
    };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }

    try {
      request = (secure ? httpsRequest : httpRequest)(target, { method, agent, headers }, response => {
        receivedAt = now();
        const dateHeader = response.headers.date ? Date.parse(response.headers.date) : Number.NaN;
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const parsed = parseBody(Buffer.concat(chunks));
          const status = response.statusCode ?? 0;
          const envelope = {
            ok: status >= 200 && status < 300 && parsed.ok,
            status,
            data: status >= 200 && status < 300 && parsed.ok ? parsed.value : null,
            headers: response.headers,
            date: Number.isNaN(dateHeader) ? null : dateHeader,
          };
          if (!envelope.ok) {
            envelope.headers = redactHeaders(response.headers, token);
            envelope.error = status === 429 ? 'rate-limited' : 'http';
            envelope.code = typeof parsed.value?.code === 'number' ? parsed.value.code : null;
            if (status === 401 || status === 403) envelope.forbidden = true;
            if (status === 404 && envelope.code === 10003) envelope.gone = true;
            const delay = retryDelayMs(response.headers, parsed.value);
            if (delay !== null) envelope.retryAfterMs = delay;
            envelope.message = redact(parsed.value?.message ?? '', token).slice(0, 500);
            if (!parsed.ok) {
              envelope.error = 'invalid-json';
              envelope.rawText = redact(parsed.text, token).slice(0, 500);
            }
          }
          finish(envelope);
        });
        response.on('error', error => finish(failure(
          combined.aborted ? abortedError() : 'network', redact(error.message, token),
        )));
      });
    } catch (error) {
      finish(failure('network', redact(error.message, token)));
      return;
    }

    request.on('error', error => finish(failure(
      combined.aborted ? abortedError() : 'network', redact(error.message, token),
    )));
    combined.addEventListener('abort', onAbort, { once: true });
    if (combined.aborted) {
      onAbort();
      return;
    }
    try {
      request.end(payload ?? undefined);
    } catch (error) {
      finish(failure('network', redact(error.message, token)));
      request.destroy();
    }
  });
}

/**
 * Creates the client. `clock` may be { now, sleep } (virtual clocks from the fake
 * server satisfy it); otherwise pass `now`/`sleep` individually.
 */
export function createDiscordClient(options = {}) {
  const tokenFile = options.tokenFile;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const now = options.clock?.now ?? options.now ?? Date.now;
  const sleep = options.clock?.sleep ?? options.sleep ?? sleepReal;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sendTimes = [];
  const bucketResets = new Map();
  const routeBuckets = new Map();
  let pacingTail = Promise.resolve();

  const routeKey = (method, path) => `${method} ${path}`;
  const bucketKey = route => routeBuckets.get(route) ?? `route:${route}`;

  function recordRateLimit(method, path, headers) {
    const remaining = Number(headers?.['x-ratelimit-remaining']);
    const resetAfter = Number(headers?.['x-ratelimit-reset-after']);
    const bucket = headers?.['x-ratelimit-bucket'];
    const route = routeKey(method, path);
    const key = typeof bucket === 'string' && bucket.length > 0 ? `bucket:${bucket}` : `route:${route}`;
    if (key.startsWith('bucket:')) routeBuckets.set(route, key);
    if (Number.isFinite(remaining) && remaining === 0
      && Number.isFinite(resetAfter) && resetAfter >= 0) {
      bucketResets.set(key, now() + resetAfter * 1_000);
    } else if (Number.isFinite(remaining) && remaining > 0) {
      bucketResets.delete(key);
    }
  }

  async function reserveSendSlot(method, path, signal) {
    const ticket = pacingTail.then(async () => {
      const route = routeKey(method, path);
      const key = bucketKey(route);
      const resetAt = bucketResets.get(key);
      if (resetAt !== undefined) {
        const wait = resetAt - now();
        if (wait > 0) await sleep(wait, { signal });
        bucketResets.delete(key);
      }
      let current = now();
      while (sendTimes.length > 0 && current - sendTimes[0] >= RATE_WINDOW_MS) sendTimes.shift();
      if (sendTimes.length >= MAX_REQUESTS_PER_SECOND) {
        const wait = RATE_WINDOW_MS - (current - sendTimes[0]);
        if (wait > 0) await sleep(wait, { signal });
        current = now();
        while (sendTimes.length > 0 && current - sendTimes[0] >= RATE_WINDOW_MS) sendTimes.shift();
      }
      sendTimes.push(now());
    });
    pacingTail = ticket.catch(() => {});
    return ticket;
  }

  function readToken() {
    if (typeof tokenFile !== 'string' || tokenFile.length === 0) return null;
    try {
      const token = readFileSync(tokenFile, 'utf8').trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  async function call(method, path, spec = {}) {
    const token = readToken();
    if (!token) return failure('token-missing', 'token file is missing or empty', { attempts: 0 });
    const deadline = spec.deadlineSignal ?? AbortSignal.timeout(requestTimeoutMs);
    const combined = spec.signal ? AbortSignal.any([spec.signal, deadline]) : deadline;
    const url = joinUrl(baseUrl, path) + querySuffix(spec.query);
    const payload = spec.body === undefined ? null : JSON.stringify(spec.body);
    const extraHeaders = {};
    if (spec.auditReason !== undefined) {
      extraHeaders['X-Audit-Log-Reason'] = encodeURIComponent(String(spec.auditReason).slice(0, 512));
    }
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        await reserveSendSlot(method, path, combined);
      } catch {
        return failure(deadline.aborted ? 'timeout' : 'aborted', 'request aborted', { attempts: attempt });
      }
      const result = await requestOnce({
        method, url, token, payload, extraHeaders, signal: spec.signal, deadlineSignal: deadline,
        now, requestTimeoutMs,
      });
      if (result.ok) recordRateLimit(method, path, result.headers);
      if (result.ok) return { ...result, attempts: attempt };
      if (result.status === 429 && attempt <= MAX_RETRIES) {
        const wait = result.retryAfterMs ?? 1_000;
        try {
          await sleep(wait, { signal: combined });
        } catch {
          return { ...result, error: deadline.aborted ? 'timeout' : 'aborted', attempts: attempt };
        }
        continue;
      }
      return { ...result, attempts: attempt };
    }
  }

  return {
    baseUrl,
    tokenFile,
    getMe: (options = {}) => call('GET', '/users/@me', options),
    getApplication: (options = {}) => call('GET', '/applications/@me', options),
    listMyGuilds: (options = {}) => call('GET', '/users/@me/guilds', options),
    getGuild: (guildId, options = {}) => call('GET', `/guilds/${guildId}`, options),
    getGuildMember: (guildId, userId, options = {}) =>
      call('GET', `/guilds/${guildId}/members/${userId}`, options),
    getGuildRoles: (guildId, options = {}) => call('GET', `/guilds/${guildId}/roles`, options),
    createForumChannel: (params, options = {}) => call('POST', `/guilds/${params.guildId}/channels`, {
      ...options,
      body: {
        name: params.name,
        type: 15,
        available_tags: (params.tags ?? []).map(tag => (
          typeof tag === 'string'
            ? { name: tag }
            : {
              name: tag.name,
              ...(tag.moderated === undefined ? {} : { moderated: tag.moderated }),
              ...(tag.emoji_id === undefined ? {} : { emoji_id: tag.emoji_id }),
              ...(tag.emoji_name === undefined ? {} : { emoji_name: tag.emoji_name }),
            }
        )),
        permission_overwrites: params.permissionOverwrites ?? [],
        default_auto_archive_duration: params.defaultAutoArchiveDuration ?? 10080,
      },
      auditReason: params.auditReason,
    }),
    createForumPost: (params, options = {}) => call('POST', `/channels/${params.forumId}/threads`, {
      ...options,
      body: {
        name: params.name,
        message: { content: params.content },
        applied_tags: params.appliedTags ?? [],
      },
      auditReason: params.auditReason,
    }),
    getThread: (threadId, options = {}) => call('GET', `/channels/${threadId}`, options),
    getStarterMessage: (threadId, options = {}) =>
      call('GET', `/channels/${threadId}/messages/${threadId}`, options),
    patchThreadTags: async (params, options = {}) => {
      let archived = params.archived;
      if (archived === undefined) {
        const thread = await call('GET', `/channels/${params.threadId}`, options);
        if (!thread.ok) return thread;
        archived = Boolean(thread.data?.thread_metadata?.archived);
      }
      const body = { applied_tags: params.appliedTags };
      if (archived) body.archived = false;
      return call('PATCH', `/channels/${params.threadId}`, {
        ...options, body, auditReason: params.auditReason,
      });
    },
    listActiveForumThreads: async ({ guildId, forumId }, options = {}) => {
      const result = await call('GET', `/guilds/${guildId}/threads/active`, options);
      if (!result.ok) return result;
      return { ...result, data: (result.data?.threads ?? []).filter(thread => thread.parent_id === forumId) };
    },
    listArchivedForumThreads: async (forumId, options = {}) => {
      const threads = [];
      let before = options.before;
      let pages = 0;
      for (;;) {
        const result = await call('GET', `/channels/${forumId}/threads/archived/public`, {
          ...options, query: { before, limit: 100 },
        });
        if (!result.ok) return result;
        const page = result.data?.threads ?? [];
        threads.push(...page);
        pages += 1;
        if (!result.data?.has_more || page.length === 0) {
          return { ...result, data: threads, meta: { pages } };
        }
        before = page[page.length - 1]?.thread_metadata?.archive_timestamp;
        if (!before || pages > 1_000) return { ...result, data: threads, meta: { pages } };
      }
    },
    getAuditLog: async (params, options = {}) => {
      const entries = [];
      const pageLimit = params.limit ?? 100;
      let after = params.after;
      let pages = 0;
      if (after === undefined) {
        const descending = [];
        let before = params.before;
        for (;;) {
          const result = await call('GET', `/guilds/${params.guildId}/audit-logs`, {
            ...options,
            query: { action_type: params.actionType, before, limit: pageLimit },
          });
          if (!result.ok) return result;
          const page = result.data?.audit_log_entries ?? [];
          descending.push(...page);
          pages += 1;
          if (page.length < pageLimit || pages > 1_000) {
            return { ...result, data: descending, meta: { pages } };
          }
          before = page[page.length - 1].id;
        }
      }
      for (;;) {
        const result = await call('GET', `/guilds/${params.guildId}/audit-logs`, {
          ...options,
          query: { action_type: params.actionType, after, before: params.before, limit: pageLimit },
        });
        if (!result.ok) return result;
        const page = result.data?.audit_log_entries ?? [];
        entries.push(...page);
        pages += 1;
        if (page.length < pageLimit || pages > 1_000) {
          return { ...result, data: entries, meta: { pages } };
        }
        after = page[page.length - 1].id;
      }
    },
    archiveThread: (threadId, options = {}) =>
      call('PATCH', `/channels/${threadId}`, { ...options, body: { archived: true } }),
    deleteThread: (threadId, options = {}) => call('DELETE', `/channels/${threadId}`, options),
  };
}

/** Replaces every status tag with newTagId while keeping non-status tags in order. */
export function withStatusTag(applied, statusTagIds, newTagId) {
  const statuses = new Set(statusTagIds);
  const result = (applied ?? []).filter(tag => !statuses.has(tag));
  if (newTagId) result.push(newTagId);
  return [...new Set(result)];
}

/** Discord snowflake timestamp: (id >> 22) + 1420070400000, in epoch milliseconds. */
export function snowflakeTime(id) {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}
