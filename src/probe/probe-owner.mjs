import { snowflakeTime } from '../discord/client.mjs';
import { hasAppliedTags, newestAuditId, readAuditAfter } from './audit.mjs';
import {
  OWNER_POST_TITLE, PROBE_SCHEMA, nextStatusKey,
} from './constants.mjs';
import { cleanupThread } from './probe-setup.mjs';
import { withProbeStatus } from './forum.mjs';
import {
  nowIso, probeJsonPath, probePartialPath, probeStatePath, writeJsonAtomic,
} from './io.mjs';
import { join } from 'node:path';

async function writeWaiting(ctx, reason, fields, extra) {
  const next = { ...fields, ...extra };
  const state = {
    ...ctx.state, phase: 'awaiting-owner', fields: next, updatedAt: nowIso(ctx.now),
  };
  await writeJsonAtomic(probeStatePath(ctx.outDir), state);
  const partial = { ...next, phase: 'awaiting-owner', reason, checkedAt: nowIso(ctx.now) };
  await writeJsonAtomic(probePartialPath(ctx.outDir), partial);
  return { code: 5, phase: 'awaiting-owner', reason, fields: partial };
}

async function cleanupOwner(ctx, fields, threadIds) {
  const results = [];
  for (const threadId of threadIds) {
    results.push(await cleanupThread(ctx.client, {
      guildId: fields.guildId,
      threadId,
      uuid: ctx.uuid(),
      now: ctx.now,
      sleep: ctx.sleep,
      auditReads: ctx.options.auditReads ?? 3,
      auditIntervalMs: ctx.options.auditIntervalMs ?? 20_000,
    }));
  }
  return { threads: results };
}

async function stopOwner(ctx, reason, fields, extra = {}, { cleanupIds = null } = {}) {
  const next = { ...fields, ...extra };
  if (cleanupIds && cleanupIds.length > 0) {
    next.cleanup = await cleanupOwner(ctx, next, cleanupIds);
  }
  const partial = { ...next, phase: 'stopped', reason, checkedAt: nowIso(ctx.now) };
  await writeJsonAtomic(probePartialPath(ctx.outDir), partial);
  const state = {
    ...ctx.state, phase: 'stopped', reason, fields: next, updatedAt: nowIso(ctx.now),
  };
  await writeJsonAtomic(probeStatePath(ctx.outDir), state);
  return { code: 1, phase: 'stopped', reason, fields: partial, status: extra.status ?? null };
}

function listThreads(active, archived) {
  const seen = new Set();
  const result = [];
  for (const thread of [...(active ?? []), ...(archived ?? [])]) {
    if (!thread?.id || seen.has(thread.id)) continue;
    seen.add(thread.id);
    result.push(thread);
  }
  return result;
}

export async function runOwnerPhase(ctx) {
  const { client, state, options } = ctx;
  if (!state?.forumId || !state?.probePostId) {
    return stopOwner(ctx, 'probe-state-incomplete', {}, {});
  }
  const fields = { ...(state.fields ?? {}) };
  const forum = await client.getThread(state.forumId);
  if (!forum.ok) {
    return stopOwner(ctx, 'forum-lookup-failed', fields, { status: forum.status ?? null });
  }
  if (forum.data?.type !== 15) {
    return stopOwner(ctx, 'forum-wrong-type', fields, { type: forum.data?.type ?? null });
  }
  fields.forumId = state.forumId;
  fields.forumPrivate = fields.forumPrivate ?? null;

  const active = await client.listActiveForumThreads({
    guildId: state.guildId, forumId: state.forumId,
  });
  if (!active.ok) {
    return stopOwner(ctx, 'thread-list-unavailable', fields, { status: active.status ?? null });
  }
  const archived = await client.listArchivedForumThreads(state.forumId);
  if (!archived.ok) {
    return stopOwner(ctx, 'archived-list-unavailable', fields, { status: archived.status ?? null });
  }
  const threads = listThreads(active.data, archived.data);
  const ownerPosts = threads.filter(thread => thread.type === 11
    && thread.parent_id === state.forumId
    && thread.name === OWNER_POST_TITLE
    && thread.owner_id === state.ownerUserId);
  if (ownerPosts.length === 0) {
    return writeWaiting(ctx, 'owner-post-not-found', fields, { ownerPostId: null });
  }
  if (ownerPosts.length > 1) {
    return stopOwner(ctx, 'multiple-owner-posts', fields, {
      ownerPostIds: ownerPosts.map(thread => thread.id),
    });
  }
  const ownerPost = ownerPosts[0];
  fields.ownerPostId = ownerPost.id;

  let ownerEntry = null;
  let probeEntry = null;
  let ownerSeenAt = null;
  const attempts = [];
  const auditReads = options.auditReads ?? 3;
  const intervalMs = options.auditIntervalMs ?? 20_000;
  for (let index = 0; index < auditReads; index += 1) {
    const audit = await readAuditAfter(client, {
      guildId: state.guildId,
      actionType: 111,
      after: state.ownerAuditCursor ?? '0',
    });
    attempts.push({
      at: nowIso(ctx.now), ok: audit.ok, status: audit.status ?? null,
      entries: audit.entries?.length ?? 0,
    });
    if (!audit.ok) {
      return stopOwner(ctx, 'owner-audit-unavailable', fields, {
        status: audit.status ?? null,
      }, { cleanupIds: [ownerPost.id, state.probePostId, ...(state.extraProbePostIds ?? [])] });
    }
    if (!ownerEntry) {
      ownerEntry = (audit.entries ?? []).find(entry => entry?.action_type === 111
        && entry.target_id === ownerPost.id && entry.user_id === state.ownerUserId) ?? null;
      if (ownerEntry) ownerSeenAt = ctx.now();
    }
    if (!probeEntry) {
      probeEntry = (audit.entries ?? []).find(entry => entry?.action_type === 111
        && entry.target_id === state.probePostId && entry.user_id === state.ownerUserId) ?? null;
    }
    if (ownerEntry && probeEntry) break;
    if (index < auditReads - 1) await ctx.sleep(intervalMs);
  }

  fields.ownerAuditSeen = Boolean(ownerEntry);
  fields.ownerAuditHasAppliedTags = ownerEntry ? hasAppliedTags(ownerEntry) : false;
  fields.ownerAuditActorId = ownerEntry?.user_id ?? null;
  fields.ownerAuditEntryId = ownerEntry?.id ?? null;
  fields.ownerAuditDelayMs = ownerEntry && ownerSeenAt !== null
    ? Math.max(0, ownerSeenAt - snowflakeTime(ownerEntry.id))
    : null;
  fields.ownerProbeAuditSeen = Boolean(probeEntry);
  fields.ownerProbeAuditHasAppliedTags = probeEntry ? hasAppliedTags(probeEntry) : false;
  fields.ownerAuditAttempts = attempts;

  if (ownerEntry && !fields.ownerAuditHasAppliedTags) {
    return stopOwner(ctx, 'owner-audit-without-applied-tags', fields, {},
      { cleanupIds: [ownerPost.id, state.probePostId, ...(state.extraProbePostIds ?? [])] });
  }
  if (probeEntry && !fields.ownerProbeAuditHasAppliedTags) {
    return stopOwner(ctx, 'owner-probe-audit-without-applied-tags', fields, {},
      { cleanupIds: [ownerPost.id, state.probePostId, ...(state.extraProbePostIds ?? [])] });
  }
  if (!ownerEntry || !probeEntry) {
    return writeWaiting(ctx, 'owner-audit-not-visible', fields, {
      ownerAuditSeen: Boolean(ownerEntry),
      ownerProbeAuditSeen: Boolean(probeEntry),
    });
  }

  const thread = await client.getThread(ownerPost.id);
  if (!thread.ok) {
    return stopOwner(ctx, 'owner-post-read-failed', fields, { status: thread.status ?? null },
      { cleanupIds: [state.probePostId, ...(state.extraProbePostIds ?? [])] });
  }
  const currentTags = thread.data?.applied_tags ?? [];
  const nextKey = nextStatusKey(currentTags, state.tagIds);
  const patchReason = `memento-probe-owner ${ctx.uuid()}`;
  const botPatch = await client.patchThreadTags({
    threadId: ownerPost.id,
    appliedTags: withProbeStatus(currentTags, state.tagIds, nextKey),
    auditReason: patchReason,
  });
  fields.botPatchOwnerPost = Boolean(botPatch.ok);
  fields.botPatchOwnerPostTag = nextKey;
  fields.botPatchOwnerPostStatus = botPatch.status ?? null;
  fields.botPatchOwnerPostCode = botPatch.code ?? null;
  if (!botPatch.ok) {
    return stopOwner(ctx, 'bot-patch-owner-post-failed', fields, {
      status: botPatch.status ?? null,
    }, { cleanupIds: [ownerPost.id, state.probePostId, ...(state.extraProbePostIds ?? [])] });
  }
  const verified = await client.getThread(ownerPost.id);
  fields.botPatchOwnerPostApplied = Boolean(verified.ok
    && (verified.data?.applied_tags ?? []).includes(state.tagIds[nextKey]));
  if (!fields.botPatchOwnerPostApplied) {
    return stopOwner(ctx, 'bot-patch-owner-post-not-applied', fields, {},
      { cleanupIds: [ownerPost.id, state.probePostId, ...(state.extraProbePostIds ?? [])] });
  }

  const targets = [...new Set([
    ownerPost.id,
    state.probePostId,
    ...(state.extraProbePostIds ?? []),
  ])];
  const deleteCursor = await newestAuditId(client, { guildId: state.guildId, actionType: 112 });
  const deleteResults = [];
  for (const threadId of targets) {
    const removed = await client.deleteThread(threadId);
    deleteResults.push({
      id: threadId, ok: Boolean(removed.ok || removed.gone),
      status: removed.status ?? null, gone: Boolean(removed.gone),
    });
  }
  const goneChecks = [];
  for (const threadId of targets) {
    const check = await client.getThread(threadId);
    goneChecks.push({
      id: threadId, gone: Boolean(check.gone), status: check.status ?? null,
      code: check.code ?? null,
    });
  }
  const deleteEntries = [];
  const reads = options.auditReads ?? 3;
  for (let index = 0; index < reads; index += 1) {
    const audit = await readAuditAfter(client, {
      guildId: state.guildId, actionType: 112, after: deleteCursor.id ?? '0',
    });
    if (audit.ok) deleteEntries.push(...audit.entries);
    if (targets.every(id => deleteEntries.some(entry => entry?.target_id === id))) break;
    if (index < reads - 1) await ctx.sleep(intervalMs);
  }
  fields.deletedThreadIds = targets;
  fields.deleteResults = deleteResults;
  fields.goneChecks = goneChecks;
  fields.deleteAuditEntryIds = [...new Set(deleteEntries
    .filter(entry => targets.includes(entry?.target_id))
    .map(entry => entry.id))];
  fields.deleteAuditSeen = targets.every(id => deleteEntries.some(entry => entry?.target_id === id));
  fields.deleteObserved = goneChecks.every(check => check.gone) && fields.deleteAuditSeen;
  if (!fields.deleteObserved) {
    return stopOwner(ctx, 'delete-verification-failed', fields, {});
  }

  if (!ctx.agentDir || !ctx.repoPath || !ctx.tokenFile) {
    return stopOwner(ctx, 'config-path-missing', fields, {});
  }
  await writeJsonAtomic(join(ctx.agentDir, 'memento', 'config.json'), {
    repoPath: ctx.repoPath,
    tokenFile: ctx.tokenFile,
    remote: null,
  });

  const final = {
    schema: PROBE_SCHEMA,
    complete: true,
    ...fields,
    checkedAt: nowIso(ctx.now),
  };
  await writeJsonAtomic(probeJsonPath(ctx.outDir), final);
  await writeJsonAtomic(probeStatePath(ctx.outDir), {
    ...ctx.state, phase: 'complete', complete: true, fields: final, updatedAt: nowIso(ctx.now),
  });
  return { code: 0, phase: 'complete', fields: final };
}
