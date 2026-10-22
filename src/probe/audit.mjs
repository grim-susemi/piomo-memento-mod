import { snowflakeTime } from '../discord/client.mjs';

export function hasAppliedTags(entry) {
  return Array.isArray(entry?.changes)
    && entry.changes.some(change => change?.key === 'applied_tags');
}

export function findStatusEntry(entries, { targetId, userId, reason }) {
  return (entries ?? []).find(entry => entry?.action_type === 111
    && entry.target_id === targetId
    && (userId === undefined || entry.user_id === userId)
    && (reason === undefined || entry.reason === reason));
}

export async function readAuditAfter(client, { guildId, actionType, after }) {
  const result = await client.getAuditLog({
    guildId, actionType, ...(after === undefined ? {} : { after }), limit: 100,
  });
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      forbidden: Boolean(result.forbidden),
      error: result.error ?? 'audit-failed',
    };
  }
  return { ok: true, entries: result.data ?? [] };
}

export async function newestAuditId(client, { guildId, actionType }) {
  const result = await client.getAuditLog({ guildId, actionType, limit: 100 });
  if (!result.ok) {
    return { ok: false, status: result.status, forbidden: Boolean(result.forbidden) };
  }
  return { ok: true, id: (result.data ?? [])[0]?.id ?? '0' };
}

/**
 * Bounded live audit protocol: at most `reads` reads, `intervalMs` apart.
 * Returns the first matching entry and when it was first seen.
 */
export async function findAuditBounded({
  read, match, now, sleep, reads = 3, intervalMs = 20_000,
}) {
  const attempts = [];
  for (let index = 0; index < reads; index += 1) {
    const result = await read();
    attempts.push({
      at: now(), ok: result.ok, status: result.status ?? null,
      entries: result.entries?.length ?? 0,
    });
    if (!result.ok) return { ok: false, reason: 'audit-unavailable', status: result.status, attempts };
    const entry = (result.entries ?? []).find(match);
    if (entry) {
      const seenAt = now();
      return {
        ok: true,
        entry,
        seenAt,
        delayMs: Math.max(0, seenAt - snowflakeTime(entry.id)),
        attempts,
        reads: index + 1,
      };
    }
    if (index < reads - 1) await sleep(intervalMs);
  }
  return { ok: true, entry: null, attempts, reads };
}
