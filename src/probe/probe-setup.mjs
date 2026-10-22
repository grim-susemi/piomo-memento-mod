import { snowflakeTime } from '../discord/client.mjs';
import { findAuditBounded, hasAppliedTags, newestAuditId, readAuditAfter } from './audit.mjs';
import {
  MESSAGE_CONTENT_FLAGS, PROBE_STATE_SCHEMA, PROBE_TEXT, PROBE_TITLE,
  hasRuntimePermissions,
} from './constants.mjs';
import {
  computePermissions, resolveForum, resolveGuild, resolveProbePost, withProbeStatus,
} from './forum.mjs';
import { nowIso, probePartialPath, probeStatePath, writeJsonAtomic } from './io.mjs';
import { writeOwnerAction, writeOwnerCreateForum } from './instructions.mjs';

const REPLACEMENT = '\uFFFD';

async function cleanupThread(client, {
  guildId, threadId, uuid, now, sleep, auditReads, auditIntervalMs,
}) {
  const cursor = await newestAuditId(client, { guildId, actionType: 112 });
  const removed = await client.deleteThread(threadId);
  const gone = await client.getThread(threadId);
  const entries = [];
  for (let index = 0; index < auditReads; index += 1) {
    const audit = await readAuditAfter(client, { guildId, actionType: 112, after: cursor.id ?? '0' });
    if (audit.ok) entries.push(...audit.entries);
    if (entries.some(entry => entry?.target_id === threadId)) break;
    if (index < auditReads - 1) await sleep(auditIntervalMs);
  }
  return {
    attempted: true,
    deleteStatus: removed.status ?? null,
    deleteOk: Boolean(removed.ok || removed.gone),
    gone: Boolean(gone.gone),
    deleteAuditSeen: entries.some(entry => entry?.target_id === threadId),
    at: nowIso(now),
    uuid,
  };
}

async function cleanupProbe(ctx, fields) {
  const ids = [...new Set([
    ...(fields.probePostId ? [fields.probePostId] : []),
    ...(fields.extraProbePostIds ?? []),
  ])];
  if (ids.length === 0) return null;
  const results = [];
  for (const threadId of ids) results.push(await cleanupThread(ctx.client, {
    guildId: fields.guildId,
    threadId,
    uuid: ctx.uuid(),
    now: ctx.now,
    sleep: ctx.sleep,
    auditReads: ctx.options.auditReads ?? 3,
    auditIntervalMs: ctx.options.auditIntervalMs ?? 20_000,
  }));
  return { threads: results };
}

async function writePartial(ctx, fields, extra) {
  const partial = {
    ...fields,
    ...extra,
    checkedAt: nowIso(ctx.now),
  };
  await writeJsonAtomic(probePartialPath(ctx.outDir), partial);
  return partial;
}

async function stop(ctx, reason, fields, extra = {}, { cleanup = false } = {}) {
  const next = { ...fields, ...extra };
  if (cleanup) next.cleanup = await cleanupProbe(ctx, next);
  const partial = await writePartial(ctx, next, { phase: 'stopped', reason });
  return { code: 1, phase: 'stopped', reason, fields: partial, status: extra.status ?? null };
}

function roundTrip(sentContent, readContent) {
  if (typeof sentContent !== 'string') {
    return readContent.includes(PROBE_TEXT) && !readContent.includes(REPLACEMENT);
  }
  return Buffer.from(sentContent, 'utf8').equals(Buffer.from(readContent, 'utf8'))
    && !readContent.includes(REPLACEMENT);
}

function clockFromEnvelope(envelope) {
  const midpoint = Math.round(((envelope.sentAt ?? 0) + (envelope.receivedAt ?? 0)) / 2);
  return {
    clockOffsetMs: snowflakeTime(envelope.threadId) - midpoint,
    rttMs: Math.max(0, (envelope.receivedAt ?? 0) - (envelope.sentAt ?? 0)),
    dateOffsetMs: envelope.date === null || envelope.date === undefined
      ? null
      : envelope.date - (envelope.receivedAt ?? 0),
  };
}

async function latestThread(client, threadId) {
  const result = await client.getThread(threadId);
  return result.ok ? result.data : null;
}

export async function runSetup(ctx) {
  const { client, options, state, me } = ctx;
  const fields = {
    ...(state?.fields ?? {}),
    botUserId: me?.id ?? state?.botUserId ?? null,
  };

  const application = await client.getApplication();
  if (!application.ok) {
    return stop(ctx, 'application-unavailable', fields, { status: application.status ?? null });
  }
  const flags = BigInt(application.data?.flags ?? 0);
  fields.intent = (flags & MESSAGE_CONTENT_FLAGS) !== 0n;
  fields.applicationId = application.data?.id ?? null;
  fields.applicationFlags = Number(flags);
  if (!fields.intent) {
    return stop(ctx, 'message-content-intent-off', fields);
  }

  const guild = await resolveGuild(client, options.guildName);
  if (!guild.ok) return stop(ctx, guild.reason, fields, { guildNames: guild.guildNames ?? null });
  fields.guildId = guild.guild.id;
  fields.guildName = guild.guild.name;
  const guildDetails = await client.getGuild(fields.guildId);
  if (!guildDetails.ok) {
    return stop(ctx, 'guild-read-failed', fields, { status: guildDetails.status ?? null });
  }
  fields.guildName = guildDetails.data?.name ?? fields.guildName;
  fields.ownerUserId = guildDetails.data?.owner_id ?? null;
  if (!fields.ownerUserId) return stop(ctx, 'guild-owner-missing', fields);

  const permissions = await computePermissions(client, fields.guildId, fields.botUserId);
  if (!permissions.ok) {
    return stop(ctx, permissions.reason, fields, { status: permissions.status ?? null });
  }
  fields.permissionBits = permissions.bits.toString();
  fields.permissions = permissions.permissions;
  fields.administrator = permissions.administrator;
  if (!hasRuntimePermissions(fields.permissions)) {
    const missing = Object.entries(fields.permissions)
      .filter(([, value]) => !value).map(([name]) => name);
    return stop(ctx, 'missing-permissions', fields, { missingPermissions: missing });
  }

  const forum = await resolveForum(client, {
    guildId: fields.guildId,
    botUserId: fields.botUserId,
    permissions: fields.permissions,
    administrator: fields.administrator,
    forumId: options.forumId,
    stateForumId: state?.forumId,
  });
  if (forum.boundary) {
    await writeOwnerCreateForum({ outDir: ctx.outDir });
    const partial = await writePartial(ctx, fields, {
      phase: 'awaiting-forum', reason: forum.boundary,
    });
    return { code: 4, phase: 'awaiting-forum', reason: forum.boundary, fields: partial };
  }
  if (!forum.ok) {
    return stop(ctx, forum.reason, fields, {
      status: forum.status ?? null,
      forumIds: forum.forumIds ?? null,
      tagNames: forum.tagNames ?? null,
    });
  }
  fields.forumId = forum.forum.id;
  fields.forumName = forum.forum.name;
  fields.forumPrivate = forum.forumPrivate;
  fields.tagIds = forum.tagIds;
  fields.tagNames = (forum.forum.available_tags ?? []).map(tag => tag.name);

  const post = await resolveProbePost(client, {
    guildId: fields.guildId,
    forum: forum.forum,
    tagIds: fields.tagIds,
    stateProbePostId: state?.probePostId,
    uuid: ctx.uuid,
    probeContent: options.probeContent,
    normalizeIntake: ctx.normalizeIntake,
  });
  if (!post.ok) {
    return stop(ctx, post.reason, fields, { status: post.status ?? null, code: post.code ?? null });
  }
  let thread = post.thread;
  if (thread.thread_metadata?.archived) {
    const unarchived = await client.patchThreadTags({
      threadId: thread.id,
      appliedTags: thread.applied_tags ?? [],
      auditReason: 'memento-probe reopen',
      archived: true,
    });
    if (!unarchived.ok) {
      return stop(ctx, 'probe-post-reopen-failed', {
        ...fields, probePostId: thread.id, extraProbePostIds: post.extras,
      }, { status: unarchived.status ?? null }, { cleanup: true });
    }
    thread = await latestThread(client, thread.id) ?? thread;
  }
  fields.probePostId = thread.id;
  fields.probePostCreated = post.created;
  fields.extraProbePostIds = post.extras;

  const starter = await client.getStarterMessage(thread.id);
  if (!starter.ok) {
    return stop(ctx, 'starter-read-failed', fields, { status: starter.status ?? null }, { cleanup: true });
  }
  const readContent = typeof starter.data?.content === 'string' ? starter.data.content : '';
  fields.koreanRoundTrip = roundTrip(post.sentContent, readContent);
  fields.koreanTitleRoundTrip = thread.name === PROBE_TITLE;
  if (!fields.koreanRoundTrip) {
    return stop(ctx, 'korean-round-trip-failed', fields, {}, { cleanup: true });
  }

  if (post.envelope?.ok) {
    const clock = clockFromEnvelope({
      ...post.envelope,
      threadId: thread.id,
    });
    Object.assign(fields, clock);
  } else if (state?.clockOffsetMs !== undefined) {
    fields.clockOffsetMs = state.clockOffsetMs;
    fields.rttMs = state.rttMs;
    fields.dateOffsetMs = state.dateOffsetMs ?? null;
  } else if (starter.date !== null && starter.date !== undefined) {
    fields.clockOffsetMs = starter.date - starter.receivedAt;
    fields.rttMs = Math.max(0, starter.receivedAt - starter.sentAt);
    fields.dateOffsetMs = fields.clockOffsetMs;
  } else {
    fields.clockOffsetMs = 0;
    fields.rttMs = 0;
    fields.dateOffsetMs = null;
  }
  fields.clockOffsetWarning = Math.abs(fields.clockOffsetMs) > 2_000;

  const cursor = await newestAuditId(client, { guildId: fields.guildId, actionType: 111 });
  if (!cursor.ok) {
    return stop(ctx, 'audit-unavailable', fields, { status: cursor.status ?? null }, { cleanup: true });
  }
  const reason = `memento-probe ${ctx.uuid()}`;
  const patchedTags = withProbeStatus(thread.applied_tags ?? [], fields.tagIds, 'researching');
  const patched = await client.patchThreadTags({
    threadId: thread.id, appliedTags: patchedTags, auditReason: reason,
  });
  if (!patched.ok) {
    return stop(ctx, 'tag-patch-failed', fields, { status: patched.status ?? null }, { cleanup: true });
  }
  const audit = await findAuditBounded({
    read: () => readAuditAfter(client, {
      guildId: fields.guildId, actionType: 111, after: cursor.id,
    }),
    match: entry => entry?.action_type === 111 && entry.target_id === thread.id
      && entry.user_id === fields.botUserId,
    now: ctx.now,
    sleep: ctx.sleep,
    reads: options.auditReads ?? 3,
    intervalMs: options.auditIntervalMs ?? 20_000,
  });
  if (!audit.ok) {
    return stop(ctx, 'audit-unavailable', fields, { status: audit.status ?? null }, { cleanup: true });
  }
  fields.auditHasAppliedTags = audit.entry ? hasAppliedTags(audit.entry) : false;
  fields.reasonEchoed = audit.entry?.reason === reason;
  fields.botAuditEntryId = audit.entry?.id ?? null;
  fields.botAuditActorId = audit.entry?.user_id ?? null;
  fields.auditReads = audit.reads;
  if (!audit.entry || !fields.auditHasAppliedTags) {
    return stop(ctx, 'audit-without-applied-tags', fields, {}, { cleanup: true });
  }

  const archived = await client.archiveThread(thread.id);
  if (!archived.ok) {
    return stop(ctx, 'archive-failed', fields, { status: archived.status ?? null }, { cleanup: true });
  }
  let archivedThread = null;
  let archivedPages = 0;
  for (let index = 0; index < (options.auditReads ?? 3); index += 1) {
    const listing = await client.listArchivedForumThreads(fields.forumId);
    if (!listing.ok) {
      return stop(ctx, 'archived-list-unavailable', fields, { status: listing.status ?? null }, { cleanup: true });
    }
    archivedPages = listing.meta?.pages ?? archivedPages;
    archivedThread = (listing.data ?? []).find(item => item.id === thread.id) ?? null;
    if (archivedThread) break;
    if (index < (options.auditReads ?? 3) - 1) await ctx.sleep(options.auditIntervalMs ?? 20_000);
  }
  fields.archivedListed = Boolean(archivedThread);
  fields.archivedPages = archivedPages;
  if (!archivedThread) {
    return stop(ctx, 'archived-list-missing', fields, {}, { cleanup: true });
  }

  const plannedTags = withProbeStatus(patchedTags, fields.tagIds, 'planned');
  const plain = await client.patchThreadTags({
    threadId: thread.id,
    appliedTags: plannedTags,
    auditReason: `memento-probe archived-plain ${ctx.uuid()}`,
    archived: false,
  });
  fields.archivedPatchPlain = Boolean(plain.ok);
  fields.archivedPatchPlainStatus = plain.status ?? null;
  fields.archivedPatchPlainCode = plain.code ?? null;
  const unarchive = await client.patchThreadTags({
    threadId: thread.id,
    appliedTags: plannedTags,
    auditReason: `memento-probe archived-unarchive ${ctx.uuid()}`,
    archived: true,
  });
  fields.archivedPatchUnarchive = Boolean(unarchive.ok);
  fields.archivedPatchUnarchiveStatus = unarchive.status ?? null;
  if (!unarchive.ok) {
    return stop(ctx, 'archived-unarchive-failed', fields, {
      status: unarchive.status ?? null, code: unarchive.code ?? null,
    }, { cleanup: true });
  }
  const reopened = await latestThread(client, thread.id);
  fields.probePostArchivedAfterSetup = Boolean(reopened?.thread_metadata?.archived);

  const ownerCursor = await newestAuditId(client, { guildId: fields.guildId, actionType: 111 });
  fields.ownerAuditSeen = false;
  fields.ownerAuditHasAppliedTags = false;
  fields.ownerAuditDelayMs = null;
  fields.botPatchOwnerPost = false;
  fields.deleteObserved = false;

  const nextState = {
    schema: PROBE_STATE_SCHEMA,
    phase: 'awaiting-owner',
    forumId: fields.forumId,
    tagIds: fields.tagIds,
    guildId: fields.guildId,
    ownerUserId: fields.ownerUserId,
    botUserId: fields.botUserId,
    probePostId: fields.probePostId,
    extraProbePostIds: fields.extraProbePostIds,
    marker: post.marker ?? state?.marker ?? null,
    sentContent: post.sentContent ?? state?.sentContent ?? null,
    clockOffsetMs: fields.clockOffsetMs,
    rttMs: fields.rttMs,
    dateOffsetMs: fields.dateOffsetMs,
    auditHasAppliedTags: fields.auditHasAppliedTags,
    reasonEchoed: fields.reasonEchoed,
    koreanRoundTrip: fields.koreanRoundTrip,
    archivedListed: fields.archivedListed,
    archivedPatchPlain: fields.archivedPatchPlain,
    archivedPatchUnarchive: fields.archivedPatchUnarchive,
    ownerAuditCursor: ownerCursor.ok ? ownerCursor.id : '0',
    fields,
    createdAt: state?.createdAt ?? nowIso(ctx.now),
    updatedAt: nowIso(ctx.now),
  };
  await writeJsonAtomic(probeStatePath(ctx.outDir), nextState);
  const partial = await writePartial(ctx, fields, { phase: 'awaiting-owner', reason: null });
  await writeOwnerAction({
    outDir: ctx.outDir,
    forumId: fields.forumId,
    probePostId: fields.probePostId,
    tagIds: fields.tagIds,
  });
  return { code: 4, phase: 'awaiting-owner', fields: partial, state: nextState };
}

export { cleanupThread };
