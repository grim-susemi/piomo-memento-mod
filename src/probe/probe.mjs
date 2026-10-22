import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { normalizeIntake } from '../card/codec.mjs';
import { GUILD_NAME } from './constants.mjs';
import { writePreparedOwnerAction } from './instructions.mjs';
import {
  nowIso, probeJsonPath, probePartialPath, probeStatePath, readJsonFile, writeJsonAtomic,
} from './io.mjs';
import { cleanupThread, runSetup } from './probe-setup.mjs';
import { runOwnerPhase } from './probe-owner.mjs';

function realSleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

async function completePreparation(context, setupResult) {
  const state = setupResult.state ?? context.state;
  const fields = { ...(setupResult.fields ?? state?.fields ?? {}) };
  const threadIds = [...new Set([
    ...(state?.probePostId ? [state.probePostId] : []),
    ...(state?.extraProbePostIds ?? []),
  ])];
  const cleanup = [];
  for (const threadId of threadIds) {
    cleanup.push(await cleanupThread(context.client, {
      guildId: state?.guildId ?? fields.guildId,
      threadId,
      uuid: context.uuid(),
      now: context.now,
      sleep: context.sleep,
      auditReads: context.options.auditReads ?? 3,
      auditIntervalMs: 1_000,
    }));
  }
  const allGone = cleanup.every(thread => thread.gone === true);
  const auditSeen = cleanup.every(thread => thread.deleteAuditSeen === true);
  Object.assign(fields, {
    probePostId: null,
    extraProbePostIds: [],
    deletedProbePostIds: threadIds,
    cleanup: { threads: cleanup },
    disposablePostsDeleted: allGone,
    deleteAuditSeen: auditSeen,
    ownerCeremonyPending: true,
    preparedAt: nowIso(context.now),
  });
  const nextState = {
    ...(state ?? {}),
    phase: 'prepared',
    complete: false,
    probePostId: null,
    extraProbePostIds: [],
    fields,
    preparedAt: fields.preparedAt,
    updatedAt: nowIso(context.now),
  };
  await writeJsonAtomic(probeStatePath(context.outDir), nextState);
  const partial = {
    ...fields, phase: 'prepared-awaiting-owner', reason: null, checkedAt: nowIso(context.now),
  };
  await writeJsonAtomic(probePartialPath(context.outDir), partial);
  await writePreparedOwnerAction({
    outDir: context.outDir,
    forumId: fields.forumId,
    tagIds: fields.tagIds ?? state?.tagIds ?? {},
    fields,
    resumeCommand: `node bin/memento.mjs probe --out "${context.outDir}" --agent-dir "${context.agentDir ?? '<agentDir>'}" --repo-path "${context.repoPath ?? '<repoPath>'}"`,
  });
  if (!allGone) {
    return {
      code: 1, phase: 'stopped', reason: 'disposable-post-cleanup-failed',
      fields: partial, state: nextState,
    };
  }
  return { code: 4, phase: 'prepared-awaiting-owner', fields: partial, state: nextState, prepared: true };
}

/**
 * Runs the live probe. Setup stops at the owner boundary (code 4); the same
 * command resumes in the owner phase after the owner's app action.
 */
export async function runProbe({
  client,
  outDir,
  tokenFile = null,
  agentDir = null,
  repoPath = null,
  guildName = GUILD_NAME,
  forumId = null,
  phase = 'auto',
  now = Date.now,
  sleep = realSleep,
  uuid = randomUUID,
  auditReads = 3,
  auditIntervalMs = 20_000,
  probeContent = undefined,
  prepareOnly = false,
}) {
  const complete = await readJsonFile(probeJsonPath(outDir));
  if (complete?.complete) {
    return { code: 0, phase: 'complete', alreadyComplete: true, fields: complete };
  }

  const me = await client.getMe();
  if (!me.ok) {
    return {
      code: 1,
      phase: 'error',
      reason: me.forbidden ? 'discord-forbidden' : 'discord-unavailable',
      status: me.status ?? null,
      error: me.error ?? null,
    };
  }

  const state = await readJsonFile(probeStatePath(outDir));
  await mkdir(outDir, { recursive: true });
  const options = {
    guildName,
    forumId,
    probeContent,
    auditReads,
    auditIntervalMs,
  };
  const context = {
    client,
    outDir,
    tokenFile,
    agentDir,
    repoPath,
    state,
    options,
    me: me.data,
    now,
    sleep,
    uuid,
    normalizeIntake,
  };

  if (phase === 'setup') {
    const result = await runSetup(context);
    if (!prepareOnly || result.phase !== 'awaiting-owner') return result;
    return completePreparation(context, result);
  }
  if (phase === 'owner') return runOwnerPhase(context);
  if (prepareOnly && state?.phase === 'awaiting-owner' && state.probePostId) {
    return completePreparation(context, {
      code: 4, phase: 'awaiting-owner', fields: state.fields ?? {}, state,
    });
  }
  if (state?.phase === 'awaiting-owner') return runOwnerPhase(context);
  const result = await runSetup(context);
  if (!prepareOnly || result.phase !== 'awaiting-owner') return result;
  return completePreparation(context, result);
}

export { realSleep };
