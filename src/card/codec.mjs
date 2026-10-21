import { isStatus } from './status.mjs';

export const SCHEMA = 'memento.card.v1';

export const SOURCES = Object.freeze(['paste', 'discord', 'old-wiki']);
export const DISCORD_STATES = Object.freeze([
  'none',
  'posting',
  'linked',
  'deleted',
  'conflict',
  'invalid',
]);
export const EVENT_ACTORS = Object.freeze(['owner', 'memento']);
export const EVENT_VIA = Object.freeze([
  'board',
  'discord',
  'paste',
  'old-wiki',
  'sync',
]);
export const EVENT_CHANGES = Object.freeze([
  'create',
  'status',
  'original',
  'link',
  'conflict',
  'remote-deleted',
  'adopted-orphan',
  'invalid-remote',
  'skipped-secret',
]);

export const FRONTMATTER_KEYS = Object.freeze([
  'description',
  'id',
  'status',
  'created',
  'updated',
  'source',
  'source_ref',
  'project',
  'rev',
  'discord_channel',
  'discord_thread',
  'discord_base',
  'discord_state',
  'discord_posting_since',
  'discord_edit_seen',
  'original_incomplete',
  'conflict_card',
  'conflict_discord',
  'conflict_since',
  'schema',
]);

const FIELD_KEYS = Object.freeze({
  description: 'description',
  id: 'id',
  status: 'status',
  created: 'created',
  updated: 'updated',
  source: 'source',
  source_ref: 'sourceRef',
  project: 'project',
  rev: 'rev',
  discord_channel: 'discordChannel',
  discord_thread: 'discordThread',
  discord_base: 'discordBase',
  discord_state: 'discordState',
  discord_posting_since: 'discordPostingSince',
  discord_edit_seen: 'discordEditSeen',
  original_incomplete: 'originalIncomplete',
  conflict_card: 'conflictCard',
  conflict_discord: 'conflictDiscord',
  conflict_since: 'conflictSince',
  schema: 'schema',
});

const OPTIONAL_KEYS = new Set([
  'project',
  'discord_posting_since',
  'discord_edit_seen',
  'original_incomplete',
]);
const CONFLICT_KEYS = Object.freeze([
  'conflict_card',
  'conflict_discord',
  'conflict_since',
]);
const ORPHAN_INCOMPLETE_STATES = Object.freeze([
  'linked',
  'deleted',
  'invalid',
  'conflict',
]);
const REQUIRED_KEYS = Object.freeze(
  FRONTMATTER_KEYS.filter(
    (key) => !OPTIONAL_KEYS.has(key) && !CONFLICT_KEYS.includes(key),
  ),
);

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ID_RE = /^\d{8}-[a-z2-7]{4}$/;
const PLAIN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+@~-]*$/;
const INTEGER_RE = /^(?:0|[1-9]\d*)$/;
const KEY_RE = /^([a-z][a-z0-9_]*): (.*)$/;

const ORIGINAL_HEADER = '\n\n## 원문\n\n';
const MEMO_MARKER = '\n\n## 메모\n\n';
const LOG_MARKER = '\n\n## 변경 기록\n\n';
const FENCE_OPEN = '```jsonl\n';
const FENCE_CLOSE = '\n```\n';

const EVENT_JSON_KEYS = new Set([
  'at',
  'event_id',
  'actor',
  'via',
  'change',
  'from',
  'to',
  'reason',
  'evidence',
  'remote_at',
]);

export class CardFormatError extends Error {
  constructor(reason) {
    super(`invalid card: ${reason}`);
    this.name = 'CardFormatError';
    this.code = reason;
  }
}

function unreadable(reason) {
  return { unreadable: true, reason };
}

function isIso(value) {
  return (
    typeof value === 'string' &&
    ISO_RE.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codePoints(value) {
  return [...value].length;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  for (;;) {
    index = haystack.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += 1;
  }
}

function parseFrontmatterValue(raw) {
  if (raw.startsWith('"')) {
    try {
      const value = JSON.parse(raw);
      if (typeof value === 'string') return { value };
    } catch {
      // fall through to the single error shape
    }
    return { error: 'value' };
  }
  if (raw.startsWith('[')) {
    try {
      const value = JSON.parse(raw);
      if (Array.isArray(value)) return { value };
    } catch {
      // fall through to the single error shape
    }
    return { error: 'value' };
  }
  if (raw === 'true') return { value: true };
  if (raw === 'false') return { value: false };
  if (INTEGER_RE.test(raw)) return { value: Number(raw) };
  if (PLAIN_RE.test(raw)) return { value: raw };
  return { error: 'value' };
}

function encodeString(value) {
  if (
    PLAIN_RE.test(value) &&
    value !== 'true' &&
    value !== 'false' &&
    !INTEGER_RE.test(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function validateEvent(event) {
  if (!isPlainObject(event)) return 'jsonl';
  if (!isIso(event.at)) return 'jsonl';
  if (
    typeof event.eventId !== 'string' ||
    event.eventId.length === 0 ||
    /[\r\n]/.test(event.eventId)
  ) {
    return 'jsonl';
  }
  if (!EVENT_ACTORS.includes(event.actor)) return 'jsonl';
  if (!EVENT_VIA.includes(event.via)) return 'jsonl';
  if (!EVENT_CHANGES.includes(event.change)) return 'jsonl';
  if (Object.hasOwn(event, 'from') && !isStatus(event.from)) return 'jsonl';
  if (Object.hasOwn(event, 'to') && !isStatus(event.to)) return 'jsonl';
  if (typeof event.reason !== 'string') return 'jsonl';
  if (Object.hasOwn(event, 'evidence') && typeof event.evidence !== 'string') {
    return 'jsonl';
  }
  if (Object.hasOwn(event, 'remoteAt') && !isIso(event.remoteAt)) {
    return 'jsonl';
  }
  const textValues = [event.eventId, event.reason];
  if (Object.hasOwn(event, 'evidence')) textValues.push(event.evidence);
  if (textValues.some((value) => value.normalize('NFC') !== value)) {
    return 'jsonl';
  }
  return null;
}

export function validateCard(card) {
  if (!isPlainObject(card)) return 'card';

  for (const key of REQUIRED_KEYS) {
    if (!Object.hasOwn(card, FIELD_KEYS[key])) return `missing_${key}`;
  }

  const hasConflictKeys = CONFLICT_KEYS.filter((key) =>
    Object.hasOwn(card, FIELD_KEYS[key]),
  );
  if (card.discordState === 'conflict') {
    if (hasConflictKeys.length !== CONFLICT_KEYS.length) return 'conflict_fields';
  } else if (hasConflictKeys.length > 0) {
    return 'conflict_fields';
  }

  if (card.schema !== SCHEMA) return 'schema';

  if (
    typeof card.description !== 'string' ||
    /[\r\n]/.test(card.description) ||
    codePoints(card.description) < 1 ||
    codePoints(card.description) > 120
  ) {
    return 'description';
  }
  if (typeof card.id !== 'string' || !ID_RE.test(card.id)) return 'id';
  if (!isStatus(card.status)) return 'unknown_status';
  if (!isIso(card.created)) return 'created';
  if (!isIso(card.updated)) return 'updated';
  if (!SOURCES.includes(card.source)) return 'source';
  if (typeof card.sourceRef !== 'string' || /[\r\n]/.test(card.sourceRef)) {
    return 'source_ref';
  }
  if (Object.hasOwn(card, 'project')) {
    if (
      typeof card.project !== 'string' ||
      card.project.length === 0 ||
      /[\r\n]/.test(card.project)
    ) {
      return 'project';
    }
  }
  if (!Number.isInteger(card.rev) || card.rev < 0) return 'rev';
  if (
    typeof card.discordChannel !== 'string' ||
    /[\r\n]/.test(card.discordChannel)
  ) {
    return 'discord_channel';
  }
  if (
    typeof card.discordThread !== 'string' ||
    /[\r\n]/.test(card.discordThread)
  ) {
    return 'discord_thread';
  }
  if (
    typeof card.discordBase !== 'string' ||
    !(card.discordBase === '' || isStatus(card.discordBase))
  ) {
    return 'discord_base';
  }
  if (!DISCORD_STATES.includes(card.discordState)) return 'discord_state';
  if (
    Object.hasOwn(card, 'discordPostingSince') &&
    !isIso(card.discordPostingSince)
  ) {
    return 'discord_posting_since';
  }
  if (Object.hasOwn(card, 'discordEditSeen') && !isIso(card.discordEditSeen)) {
    return 'discord_edit_seen';
  }
  if (
    Object.hasOwn(card, 'originalIncomplete') &&
    card.originalIncomplete !== true
  ) {
    return 'original_incomplete';
  }
  if (Object.hasOwn(card, 'conflictCard') && !isStatus(card.conflictCard)) {
    return 'conflict_fields';
  }
  if (
    Object.hasOwn(card, 'conflictDiscord') &&
    (!Array.isArray(card.conflictDiscord) ||
      card.conflictDiscord.length === 0 ||
      !card.conflictDiscord.every((value) => isStatus(value)))
  ) {
    return 'conflict_fields';
  }
  if (Object.hasOwn(card, 'conflictSince') && !isIso(card.conflictSince)) {
    return 'conflict_fields';
  }

  if (
    typeof card.title !== 'string' ||
    /[\r\n]/.test(card.title) ||
    codePoints(card.title) < 1 ||
    codePoints(card.title) > 100
  ) {
    return 'title';
  }
  if (typeof card.original !== 'string') return 'original';
  if (typeof card.notes !== 'string') return 'notes';
  if (card.original.includes('\r') || card.notes.includes('\r')) return 'crlf';
  if (
    card.original.normalize('NFC') !== card.original ||
    card.notes.normalize('NFC') !== card.notes
  ) {
    return 'nfc';
  }
  if (
    countOccurrences(
      card.original + MEMO_MARKER + card.notes + LOG_MARKER,
      MEMO_MARKER,
    ) !== 1
  ) {
    return 'ambiguous_body';
  }

  const stringFields = [
    card.description,
    card.title,
    card.sourceRef,
    card.discordChannel,
    card.discordThread,
    card.discordBase,
  ];
  if (Object.hasOwn(card, 'project')) stringFields.push(card.project);
  if (stringFields.some((value) => value.normalize('NFC') !== value)) {
    return 'nfc';
  }

  if (!Array.isArray(card.log) || card.log.length === 0) return 'jsonl';

  if (Object.hasOwn(card, 'originalIncomplete')) {
    const adopted = card.log.some(
      (event) =>
        isPlainObject(event) &&
        event.change === 'adopted-orphan' &&
        event.actor === 'memento' &&
        event.via === 'sync',
    );
    if (
      card.source !== 'discord' ||
      !ORPHAN_INCOMPLETE_STATES.includes(card.discordState) ||
      card.discordChannel.length === 0 ||
      card.discordThread.length === 0 ||
      !card.original.endsWith('…(잘림)') ||
      !adopted
    ) {
      return 'original_incomplete';
    }
  }

  for (const event of card.log) {
    const reason = validateEvent(event);
    if (reason) return reason;
  }
  return null;
}

function serializeEvent(event) {
  const out = {
    at: event.at,
    event_id: event.eventId,
    actor: event.actor,
    via: event.via,
    change: event.change,
  };
  if (Object.hasOwn(event, 'from')) out.from = event.from;
  if (Object.hasOwn(event, 'to')) out.to = event.to;
  out.reason = event.reason;
  if (Object.hasOwn(event, 'evidence')) out.evidence = event.evidence;
  if (Object.hasOwn(event, 'remoteAt')) out.remote_at = event.remoteAt;
  return JSON.stringify(out);
}

export function serialize(card) {
  const reason = validateCard(card);
  if (reason) throw new CardFormatError(reason);

  const lines = [];
  for (const key of FRONTMATTER_KEYS) {
    const internal = FIELD_KEYS[key];
    if (!Object.hasOwn(card, internal)) continue;
    const value = card[internal];
    if (key === 'rev') lines.push(`rev: ${value}`);
    else if (key === 'original_incomplete') lines.push('original_incomplete: true');
    else if (key === 'conflict_discord') {
      lines.push(`conflict_discord: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${encodeString(value)}`);
    }
  }

  const frontmatter = ['---', ...lines, '---'].join('\n');
  const events = card.log.map(serializeEvent).join('\n');
  const body = [
    `# ${card.title}`,
    '',
    '## 원문',
    '',
    card.original,
    '',
    '## 메모',
    '',
    card.notes,
    '',
    '## 변경 기록',
    '',
    '```jsonl',
    events,
    '```',
    '',
  ].join('\n');

  return Buffer.from(`${frontmatter}\n\n${body}`, 'utf8');
}

function parseBody(body, card) {
  if (!body.startsWith('# ')) return 'body';
  const titleEnd = body.indexOf('\n');
  if (titleEnd === -1) return 'body';
  const title = body.slice(2, titleEnd);
  if (!body.startsWith(ORIGINAL_HEADER, titleEnd)) return 'body';

  const originalStart = titleEnd + ORIGINAL_HEADER.length;
  const logAt = body.lastIndexOf(LOG_MARKER);
  if (logAt < originalStart) return 'body';
  const memoAt = body.lastIndexOf(MEMO_MARKER, logAt - 1);
  if (memoAt < originalStart) return 'body';

  const fence = body.slice(logAt + LOG_MARKER.length);
  const close = fence.endsWith(FENCE_CLOSE)
    ? FENCE_CLOSE
    : fence.endsWith('\n```')
      ? '\n```'
      : null;
  if (!fence.startsWith(FENCE_OPEN) || close === null) {
    return 'body';
  }
  const jsonl = fence.slice(FENCE_OPEN.length, fence.length - close.length);
  const lines = jsonl.split('\n');
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    return 'jsonl';
  }

  const log = [];
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return 'jsonl';
    }
    if (!isPlainObject(event)) return 'jsonl';
    for (const key of Object.keys(event)) {
      if (!EVENT_JSON_KEYS.has(key)) return 'jsonl';
    }
    const mapped = {
      at: event.at,
      eventId: event.event_id,
      actor: event.actor,
      via: event.via,
      change: event.change,
    };
    if (Object.hasOwn(event, 'from')) mapped.from = event.from;
    if (Object.hasOwn(event, 'to')) mapped.to = event.to;
    mapped.reason = event.reason;
    if (Object.hasOwn(event, 'evidence')) mapped.evidence = event.evidence;
    if (Object.hasOwn(event, 'remote_at')) mapped.remoteAt = event.remote_at;
    log.push(mapped);
  }

  card.title = title;
  card.original = body.slice(originalStart, memoAt);
  card.notes = body.slice(memoAt + MEMO_MARKER.length, logAt);
  card.log = log;
  return null;
}

export function parse(bytes) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
    return unreadable('input');
  }
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return unreadable('bom');
  }
  if (buffer.includes(0x0d)) return unreadable('crlf');

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return unreadable('utf8');
  }
  if (text.includes('\uFFFD')) return unreadable('replacement');
  if (text.normalize('NFC') !== text) return unreadable('nfc');
  if (!text.startsWith('---\n')) return unreadable('frontmatter');

  const closing = text.indexOf('\n---\n\n', 3);
  if (closing === -1) return unreadable('frontmatter');
  const frontmatterText = text.slice(4, closing);
  const body = text.slice(closing + 6);

  const entries = [];
  const seen = new Set();
  for (const line of frontmatterText.split('\n')) {
    const match = KEY_RE.exec(line);
    if (!match) return unreadable('frontmatter');
    const [, key, raw] = match;
    if (seen.has(key)) return unreadable('duplicate_key');
    seen.add(key);
    if (!FRONTMATTER_KEYS.includes(key)) return unreadable('unknown_key');
    const parsed = parseFrontmatterValue(raw);
    if (parsed.error) return unreadable(parsed.error);
    entries.push([key, parsed.value]);
  }

  let lastIndex = -1;
  for (const [key] of entries) {
    const index = FRONTMATTER_KEYS.indexOf(key);
    if (index <= lastIndex) return unreadable('key_order');
    lastIndex = index;
  }

  for (const key of REQUIRED_KEYS) {
    if (!seen.has(key)) return unreadable(`missing_${key}`);
  }

  const conflictPresent = CONFLICT_KEYS.filter((key) => seen.has(key));
  const state = entries.find(([key]) => key === 'discord_state')?.[1];
  if (state === 'conflict') {
    if (conflictPresent.length !== CONFLICT_KEYS.length) {
      return unreadable('conflict_fields');
    }
  } else if (conflictPresent.length > 0) {
    return unreadable('conflict_fields');
  }

  const card = {};
  for (const [key, value] of entries) {
    card[FIELD_KEYS[key]] = value;
  }

  const bodyReason = parseBody(body, card);
  if (bodyReason) return unreadable(bodyReason);

  const invalid = validateCard(card);
  if (invalid) return unreadable(invalid);

  let canonical;
  try {
    canonical = serialize(card);
  } catch (error) {
    return unreadable(
      error instanceof CardFormatError ? error.code : 'invalid',
    );
  }
  if (!canonical.equals(buffer)) return unreadable('noncanonical');
  return { card };
}

export function normalizeIntake(text) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string');
  }
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').normalize('NFC');
}
