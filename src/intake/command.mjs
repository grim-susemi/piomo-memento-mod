import { existsSync, readFileSync } from 'node:fs';
import { STATUS_KEYS, STATUS_LABELS } from '../card/status.mjs';
import { receiptPathFor } from '../receipts.mjs';
import { createDiscordClient } from '../discord/client.mjs';
import { hasRemote } from '../store/git.mjs';
import { isPidAlive, lockPath, readLock } from '../store/lock.mjs';

function notifyOf(ctx) {
  return typeof ctx?.ui?.notify === 'function'
    ? ctx.ui.notify.bind(ctx.ui)
    : () => {};
}

export function lastSyncAt(agentDir) {
  const path = receiptPathFor(agentDir);
  if (!path) return null;
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === '') continue;
    try {
      const entry = JSON.parse(lines[index]);
      if (entry?.event === 'sync-complete' && typeof entry.at === 'string') return entry.at;
    } catch {
      // A torn final receipt line is not a sync record.
    }
  }
  return null;
}

export function formatStatusLine({ total, counts, conflicts, unpushed, lastSync }) {
  const parts = [`메멘토: 카드 ${total}장`];
  for (const key of STATUS_KEYS) {
    parts.push(`${STATUS_LABELS[key]} ${counts[key] ?? 0}`);
  }
  parts.push(`충돌 ${conflicts}`);
  parts.push(`미푸시 ${unpushed}`);
  parts.push(`마지막 동기화 ${lastSync ?? '없음'}`);
  return parts.join(' · ');
}

async function buildStatusLine({ store, agentDir }) {
  const listed = await store.list();
  const counts = Object.fromEntries(STATUS_KEYS.map((key) => [key, 0]));
  let conflicts = 0;
  for (const card of listed.cards) {
    if (Object.hasOwn(counts, card.status)) counts[card.status] += 1;
    if (card.discordState === 'conflict') conflicts += 1;
  }
  return formatStatusLine({
    total: listed.cards.length,
    counts,
    conflicts,
    unpushed: await store.unpushedCount(),
    lastSync: lastSyncAt(agentDir),
  });
}

async function lockState(repoPath, name) {
  try {
    const view = await readLock(lockPath(repoPath, name));
    if (!view) return 'free';
    if (view.record && Number.isInteger(view.record.pid) && isPidAlive(view.record.pid)) {
      return 'held';
    }
    return 'stale';
  } catch {
    return 'unreadable';
  }
}

async function discordState(config) {
  if (!existsSync(config.tokenFile)) return 'token-missing';
  const client = createDiscordClient({ tokenFile: config.tokenFile });
  const me = await client.getMe();
  if (me.ok) return 'ok';
  if (me.forbidden) return `forbidden (${me.status})`;
  if (me.error === 'token-missing') return 'token-missing';
  return me.error ? `unreachable (${me.error})` : `unreachable (${me.status ?? 'unknown'})`;
}

export async function doctorLines({ config }) {
  if (!config || config.state !== 'configured') {
    return [`config: ${config?.state ?? 'unconfigured'} (${config?.reason ?? 'config'})`];
  }
  return [
    'config: configured',
    `lock write: ${await lockState(config.repoPath, 'write')}`,
    `lock sync: ${await lockState(config.repoPath, 'sync')}`,
    `remote: ${(await hasRemote(config.repoPath)) ? 'ok' : 'none'}`,
    `discord: ${await discordState(config)}`,
  ];
}

async function runSync(notify, syncNow) {
  if (typeof syncNow !== 'function') {
    notify('메멘토: 동기화가 아직 연결되지 않았습니다', 'info');
    return { ok: false, command: 'sync', reason: 'not-wired' };
  }
  try {
    const result = await syncNow();
    if (result?.ok === false) {
      notify(`메멘토: 동기화 실패 (${result.reason ?? 'unknown'})`, 'warning');
      return { ok: false, command: 'sync', result };
    }
    notify('메멘토: 동기화 완료', 'info');
    return { ok: true, command: 'sync', result };
  } catch {
    notify('메멘토: 동기화 실패 (error)', 'warning');
    return { ok: false, command: 'sync', reason: 'error' };
  }
}

async function runPush(notify, store) {
  const result = await store.push();
  if (!result.ok) {
    notify(`메멘토: 푸시 실패 (${result.code ?? 'unknown'})`, 'warning');
    return { ok: false, command: 'push', result };
  }
  if (result.skipped === 'no-remote') {
    notify('메멘토: 원격이 없습니다', 'warning');
    return { ok: true, command: 'push', skipped: 'no-remote' };
  }
  notify('메멘토: 푸시 완료', 'info');
  return { ok: true, command: 'push', result };
}

export async function handleMementoCommand({ args, config, store, agentDir, ctx, syncNow }) {
  const notify = notifyOf(ctx);
  const command = typeof args === 'string' ? args.trim() : '';
  if (command === '') {
    notify(await buildStatusLine({ store, agentDir }), 'info');
    return { ok: true, command: 'status' };
  }
  if (command === 'sync') return runSync(notify, syncNow);
  if (command === 'push') return runPush(notify, store);
  if (command === 'doctor') {
    notify((await doctorLines({ config })).join('\n'), 'info');
    return { ok: true, command: 'doctor' };
  }
  notify('사용법: /memento [sync|push|doctor]', 'warning');
  return { ok: false, command: 'unknown' };
}
