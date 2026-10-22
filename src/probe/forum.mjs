import { withStatusTag } from '../discord/client.mjs';
import {
  ADMINISTRATOR_BIT, FORUM_NAME, PROBE_MARKER_PREFIX, PROBE_TEXT, PROBE_TITLE,
  RUNTIME_PERMISSION_BITS, STATUS_LABELS, VIEW_CHANNEL_BIT, permissionsFromBits,
  tagIdsByLabel, tagNamesMatch,
} from './constants.mjs';

export async function resolveGuild(client, guildName) {
  const result = await client.listMyGuilds();
  if (!result.ok) {
    return {
      ok: false,
      reason: result.forbidden ? 'guild-list-forbidden' : 'guild-list-unavailable',
      status: result.status ?? null,
    };
  }
  const guilds = result.data ?? [];
  const matches = guilds.filter(guild => guild?.name === guildName);
  if (matches.length === 0) {
    return { ok: false, reason: 'guild-not-found', guildNames: guilds.map(guild => guild?.name) };
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'guild-ambiguous', guildIds: matches.map(guild => guild.id) };
  }
  return { ok: true, guild: matches[0] };
}

export async function computePermissions(client, guildId, botUserId) {
  const [member, roles] = await Promise.all([
    client.getGuildMember(guildId, botUserId),
    client.getGuildRoles(guildId),
  ]);
  if (!member.ok) {
    return { ok: false, reason: 'bot-member-unavailable', status: member.status ?? null };
  }
  if (!roles.ok) {
    return { ok: false, reason: 'guild-roles-unavailable', status: roles.status ?? null };
  }
  const memberRoles = new Set(member.data?.roles ?? []);
  let bits = 0n;
  for (const role of roles.data ?? []) {
    if (role.id === guildId || memberRoles.has(role.id)) {
      bits |= BigInt(role.permissions ?? '0');
    }
  }
  return { ok: true, bits, permissions: permissionsFromBits(bits), administrator: (bits & ADMINISTRATOR_BIT) === ADMINISTRATOR_BIT };
}

async function getChannel(client, channelId) {
  const result = await client.getThread(channelId);
  if (result.ok) return { ok: true, channel: result.data };
  if (result.gone) return { ok: true, channel: null };
  return { ok: false, status: result.status ?? null, forbidden: Boolean(result.forbidden) };
}

function isForumPrivate(forum, guildId, botUserId, administrator) {
  const overwrites = forum.permission_overwrites ?? [];
  const everyone = overwrites.find(item => item.id === guildId && (item.type === 0 || item.type === undefined));
  if (!everyone) return false;
  const everyoneDeny = BigInt(everyone.deny ?? '0');
  const everyoneAllow = BigInt(everyone.allow ?? '0');
  if ((everyoneDeny & VIEW_CHANNEL_BIT) !== VIEW_CHANNEL_BIT) return false;
  if ((everyoneAllow & VIEW_CHANNEL_BIT) === VIEW_CHANNEL_BIT) return false;
  if (administrator) return true;
  const bot = overwrites.find(item => item.id === botUserId && (item.type === 1 || item.type === undefined));
  if (!bot) return false;
  const botAllow = BigInt(bot.allow ?? '0');
  const botDeny = BigInt(bot.deny ?? '0');
  if ((botDeny & VIEW_CHANNEL_BIT) === VIEW_CHANNEL_BIT) return false;
  return (botAllow & VIEW_CHANNEL_BIT) === VIEW_CHANNEL_BIT;
}

export function validateForum(forum, { guildId, botUserId, permissions, administrator }) {
  if (!forum) return { ok: false, reason: 'forum-not-found' };
  if (forum.type !== 15) return { ok: false, reason: 'forum-wrong-type', type: forum.type };
  if (forum.name !== FORUM_NAME) return { ok: false, reason: 'forum-wrong-name', name: forum.name };
  if (!tagNamesMatch(forum.available_tags)) {
    return {
      ok: false,
      reason: 'forum-tags-mismatch',
      tagNames: (forum.available_tags ?? []).map(tag => tag?.name),
    };
  }
  const tagIds = tagIdsByLabel(forum.available_tags);
  if (!tagIds) return { ok: false, reason: 'forum-tags-mismatch' };
  if (!isForumPrivate(forum, guildId, botUserId, administrator)) {
    return { ok: false, reason: 'forum-not-private' };
  }
  return { ok: true, forum, tagIds, forumPrivate: true };
}

async function findForumByAudit(client, guildId) {
  const audit = await client.getAuditLog({ guildId, actionType: 10, limit: 100 });
  if (!audit.ok) {
    return { ok: false, reason: 'forum-discovery-unavailable', status: audit.status ?? null };
  }
  const candidates = [];
  const seen = new Set();
  for (const entry of audit.data ?? []) {
    if (!entry?.target_id || seen.has(entry.target_id)) continue;
    seen.add(entry.target_id);
    const channel = await getChannel(client, entry.target_id);
    if (!channel.ok) continue;
    if (channel.channel?.type === 15 && channel.channel.name === FORUM_NAME) {
      candidates.push(channel.channel);
    }
  }
  if (candidates.length > 1) {
    return { ok: false, reason: 'forum-ambiguous', forumIds: candidates.map(forum => forum.id) };
  }
  return { ok: true, forum: candidates[0] ?? null };
}

async function createForum(client, { guildId, botUserId, permissions }) {
  if (!permissions.manageChannels) {
    return { ok: false, boundary: 'forum-create-requires-manage-channels' };
  }
  const result = await client.createForumChannel({
    guildId,
    name: FORUM_NAME,
    tags: [...STATUS_LABELS],
    permissionOverwrites: [
      { id: guildId, type: 0, allow: '0', deny: String(VIEW_CHANNEL_BIT) },
      { id: botUserId, type: 1, allow: String(RUNTIME_PERMISSION_BITS), deny: '0' },
    ],
    defaultAutoArchiveDuration: 10080,
    auditReason: 'memento-probe forum',
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.forbidden ? 'forum-create-forbidden' : 'forum-create-failed',
      status: result.status ?? null,
      code: result.code ?? null,
    };
  }
  return { ok: true, forum: result.data };
}

export async function resolveForum(client, {
  guildId, botUserId, permissions, administrator, forumId, stateForumId,
}) {
  if (forumId) {
    const found = await getChannel(client, forumId);
    if (!found.ok) return { ok: false, reason: 'forum-lookup-failed', status: found.status };
    return validateForum(found.channel, { guildId, botUserId, permissions, administrator });
  }
  if (stateForumId) {
    const found = await getChannel(client, stateForumId);
    if (!found.ok) return { ok: false, reason: 'forum-lookup-failed', status: found.status };
    if (found.channel) {
      return validateForum(found.channel, { guildId, botUserId, permissions, administrator });
    }
  }
  const audited = await findForumByAudit(client, guildId);
  if (!audited.ok) return audited;
  if (audited.forum) {
    return validateForum(audited.forum, { guildId, botUserId, permissions, administrator });
  }
  const created = await createForum(client, { guildId, botUserId, permissions });
  if (created.boundary) return created;
  if (!created.ok) return created;
  return validateForum(created.forum, { guildId, botUserId, permissions, administrator });
}

async function probeCandidates(client, { guildId, forumId }) {
  const active = await client.listActiveForumThreads({ guildId, forumId });
  if (!active.ok) return { ok: false, reason: 'thread-list-unavailable', status: active.status ?? null };
  const archived = await client.listArchivedForumThreads(forumId);
  if (!archived.ok) return { ok: false, reason: 'archived-list-unavailable', status: archived.status ?? null };
  const threads = [...(active.data ?? []), ...(archived.data ?? [])]
    .filter(thread => thread?.type === 11 && thread.parent_id === forumId && thread.name === PROBE_TITLE);
  return { ok: true, threads };
}

async function markedThreads(client, threads) {
  const matches = [];
  for (const thread of threads) {
    const message = await client.getStarterMessage(thread.id);
    if (message.ok && typeof message.data?.content === 'string'
      && message.data.content.includes(PROBE_MARKER_PREFIX)) {
      matches.push({ thread, content: message.data.content });
    }
  }
  return matches;
}

function sortBySnowflakeDesc(items) {
  return [...items].sort((left, right) => (BigInt(right.thread.id) > BigInt(left.thread.id) ? 1 : -1));
}

export async function resolveProbePost(client, {
  guildId, forum, tagIds, stateProbePostId, uuid, probeContent, normalizeIntake,
}) {
  if (stateProbePostId) {
    const found = await getChannel(client, stateProbePostId);
    if (found.ok && found.channel?.type === 11 && found.channel.parent_id === forum.id) {
      return {
        ok: true, thread: found.channel, created: false, extras: [],
        sentContent: null, marker: null,
      };
    }
  }
  const listed = await probeCandidates(client, { guildId, forumId: forum.id });
  if (!listed.ok) return listed;
  const marked = sortBySnowflakeDesc(await markedThreads(client, listed.threads));
  if (marked.length > 0) {
    return {
      ok: true,
      thread: marked[0].thread,
      created: false,
      extras: marked.slice(1).map(item => item.thread.id),
      sentContent: marked[0].content,
      marker: null,
    };
  }

  const marker = `${PROBE_MARKER_PREFIX}${uuid()}`;
  const text = normalizeIntake(probeContent ?? PROBE_TEXT).trimEnd();
  const content = `${text}\n\n메멘토 프로브 · ${marker}`;
  const result = await client.createForumPost({
    forumId: forum.id,
    name: PROBE_TITLE,
    content,
    appliedTags: [tagIds.idea],
    auditReason: `memento-probe create ${uuid()}`,
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.forbidden ? 'probe-post-forbidden' : 'probe-post-create-failed',
      status: result.status ?? null,
      code: result.code ?? null,
    };
  }
  return {
    ok: true,
    thread: result.data,
    created: true,
    extras: [],
    sentContent: content,
    marker,
    envelope: result,
  };
}

/** Adds a status tag in place of every other status tag. */
export function withProbeStatus(currentTags, tagIds, key) {
  const statusIds = Object.values(tagIds ?? {});
  return withStatusTag(currentTags, statusIds, tagIds[key]);
}
