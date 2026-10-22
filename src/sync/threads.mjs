import { normalizeIntake } from '../card/codec.mjs';
import { cutGraphemes } from '../card/text.mjs';
import { isStatus } from '../card/status.mjs';

export const POST_LIMIT = 2_000;
export const CUT_SUFFIX = '…(잘림)';
export const MARKER_RE = /memento:v1:([^:\s]+):([^:\s]+):([^:\s]+)/u;

export function markerLine(cardId, createKey, repoId) {
  return `메멘토 카드 ${cardId} · memento:v1:${repoId}:${cardId}:${createKey}`;
}

export function findMarker(content) {
  if (typeof content !== 'string') return null;
  const match = MARKER_RE.exec(content);
  if (!match) return null;
  const line = content.split('\n').find((entry) => entry.includes(match[0])) ?? match[0];
  return { repoId: match[1], cardId: match[2], createKey: match[3], line };
}

export function statusesOf(appliedTags, tagIds) {
  if (!Array.isArray(appliedTags)) return [];
  const byId = new Map(Object.entries(tagIds ?? {}).map(([key, id]) => [id, key]));
  return appliedTags.map((id) => byId.get(id)).filter(isStatus);
}

export function statusTagIds(state) {
  return Object.values(state.tagIds ?? {}).filter((id) => typeof id === 'string' && id.length > 0);
}

export function singleStatus(values) {
  return values.length === 1 && isStatus(values[0]) ? values[0] : null;
}

/** Board events since the last agreed base, with the measured uncertainty. */
export function boardEventsOf(card, state, uncertaintyMs) {
  const baseAt = Date.parse(state.bases?.[card.id] ?? card.created);
  const boundary = Number.isFinite(baseAt) ? baseAt : -Infinity;
  const correlated = new Map();
  for (const entry of [...(state.pending ?? []), ...(state.recentWrites ?? [])]) {
    if (entry?.eventId && entry?.key) correlated.set(entry.eventId, entry.key);
  }
  const events = card.log
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

/** The unresolved-state boundary; invalid cards derive it from their last invalid log event. */
export function conflictBoundary(card) {
  if (card.discordState === 'conflict' && typeof card.conflictSince === 'string') {
    const parsed = Date.parse(card.conflictSince);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (card.discordState === 'invalid') {
    const event = [...card.log].reverse().find((entry) => entry.change === 'invalid-remote');
    const parsed = event ? Date.parse(event.at) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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

export function descriptionFrom(text, max = 120) {
  const line = normalizeIntake(text).split('\n').map((entry) => entry.trim()).find((entry) => entry.length > 0);
  if (!line) return '';
  return [...line].slice(0, max).join('');
}

export function titleFrom(name) {
  const line = normalizeIntake(String(name ?? '')).split('\n')[0].trim();
  if (!line) return '제목 없음';
  return [...line].slice(0, 100).join('');
}

/** Removes our marker line and the leading title line only from a marked bot envelope. */
export function extractPostOriginal(content, _title, marker = null) {
  let text = normalizeIntake(String(content ?? ''));
  // An unmarked starter is owner data; a title prefix is not a memento envelope.
  if (!marker?.line) return text;
  const suffix = `\n\n${marker.line}`;
  if (text.endsWith(suffix)) text = text.slice(0, -suffix.length);
  else {
    const lineSuffix = `\n${marker.line}`;
    if (text.endsWith(lineSuffix)) text = text.slice(0, -lineSuffix.length);
  }
  // The marked envelope always starts with its own title line, even if the
  // owner later renamed the thread; the first line is not owner original text.
  const titleEnd = text.indexOf('\n');
  if (titleEnd > 0) {
    const rest = text.slice(titleEnd + 1);
    text = rest.startsWith('\n') ? rest.slice(1) : rest;
  }
  return text;
}

/** Title + a grapheme-safe cut of the original + marker, inside 2000 characters. */
export function composePostContent({ title, original, marker, limit = POST_LIMIT }) {
  const normalized = normalizeIntake(original);
  const overhead = title.length + marker.length + 4;
  const budget = Math.max(0, limit - overhead);
  const body = cutGraphemes(normalized, budget, CUT_SUFFIX);
  return { body, content: `${title}\n\n${body}\n\n${marker}`, truncated: body !== normalized };
}
