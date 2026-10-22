// memento board contract v1: plain JS shape checker shared by the API and its tests.
// Node built-ins only. Exports are documented in docs/board-contract.md.
import { STATUS_KEYS, STATUS_LABELS, isStatus } from './card/status.mjs';

export const BOARD_STATE_SCHEMA = 'memento.board-state.v1';
export const API_KEY = Symbol.for('omo.memento.api.v1');
export const TEXT_CAP_BYTES = 4096;
export const LOG_LIMIT = 10;
export const DISCORD_STATES = Object.freeze(['none', 'posting', 'linked', 'deleted', 'conflict', 'invalid']);
export const WRITE_DISCORD = Object.freeze(['pushed', 'pending', 'off', 'conflict']);
export const LOG_ACTORS = Object.freeze(['owner', 'memento']);
export const LOG_VIAS = Object.freeze(['board', 'discord', 'paste', 'old-wiki', 'sync']);
export const LOG_CHANGES = Object.freeze(['create', 'status', 'original', 'link', 'conflict', 'remote-deleted',
  'adopted-orphan', 'invalid-remote', 'skipped-secret']);
export const SET_STATUS_KEYS = Object.freeze(['action', 'id', 'status', 'rev', 'requestId']);
export const REPLY_CODES = Object.freeze({
  409: ['STALE', 'BUSY'],
  400: ['BAD_REQUEST', 'UNKNOWN_CARD', 'BAD_STATUS'],
  500: ['WRITE_FAILED'],
  501: ['MEMENTO_UNAVAILABLE', 'API_VERSION_UNSUPPORTED'],
});

const TOP_KEYS = ['schema', 'ok', 'lastSync', 'unpushedCommits', 'statuses', 'cards'];
const CARD_REQUIRED = ['id', 'rev', 'title', 'description', 'status', 'created', 'updated', 'source', 'sourceRef',
  'original', 'notes', 'originalTruncated', 'notesTruncated', 'discord', 'log'];
const CARD_OPTIONAL = ['project', 'conflict'];
const UNREADABLE_KEYS = ['id', 'unreadable', 'log'];
const LOG_REQUIRED = ['at', 'actor', 'via', 'change', 'reason'];
const LOG_OPTIONAL = ['from', 'to'];
const SOURCES = ['paste', 'discord', 'old-wiki'];
const ID_RE = /^\d{8}-[a-z2-7]{4}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const enc = new TextEncoder();

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isIso = (v) => isStr(v) && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
const isRev = (v) => Number.isInteger(v) && v >= 1;

function keys(obj, required, optional, path, errors) {
  for (const k of Object.keys(obj)) {
    if (!required.includes(k) && !optional.includes(k)) errors.push(`${path}: unknown key ${k}`);
  }
  for (const k of required) if (!Object.hasOwn(obj, k)) errors.push(`${path}: missing key ${k}`);
}

export function validateLogEntry(entry, path = 'log', errors = []) {
  if (!isObj(entry)) { errors.push(`${path}: not an object`); return errors; }
  keys(entry, LOG_REQUIRED, LOG_OPTIONAL, path, errors);
  if (Object.hasOwn(entry, 'at') && !isIso(entry.at)) errors.push(`${path}.at: not an ISO time`);
  if (Object.hasOwn(entry, 'reason') && !isStr(entry.reason)) errors.push(`${path}.reason: not a string`);
  for (const [k, allowed] of [['actor', LOG_ACTORS], ['via', LOG_VIAS], ['change', LOG_CHANGES]]) {
    if (Object.hasOwn(entry, k) && !allowed.includes(entry[k])) errors.push(`${path}.${k}: bad value`);
  }
  for (const k of LOG_OPTIONAL) {
    if (Object.hasOwn(entry, k) && !isStatus(entry[k])) errors.push(`${path}.${k}: bad status`);
  }
  return errors;
}

function validateLog(log, path, errors) {
  if (!Array.isArray(log)) { errors.push(`${path}: not an array`); return; }
  if (log.length > LOG_LIMIT) errors.push(`${path}: more than ${LOG_LIMIT} entries`);
  log.forEach((e, i) => validateLogEntry(e, `${path}[${i}]`, errors));
  for (let i = 1; i < log.length; i++) {
    if (isIso(log[i - 1]?.at) && isIso(log[i]?.at) && Date.parse(log[i - 1].at) < Date.parse(log[i].at)) {
      errors.push(`${path}: not newest first`);
      break;
    }
  }
}

function validateText(card, field, flag, path, errors) {
  if (!isStr(card[field])) { errors.push(`${path}.${field}: not a string`); return; }
  if (enc.encode(card[field]).length > TEXT_CAP_BYTES) errors.push(`${path}.${field}: over ${TEXT_CAP_BYTES} bytes`);
  if (typeof card[flag] !== 'boolean') errors.push(`${path}.${flag}: not a boolean`);
}

export function validateCard(card, path = 'card', errors = []) {
  if (!isObj(card)) { errors.push(`${path}: not an object`); return errors; }
  if (Object.hasOwn(card, 'unreadable')) {
    keys(card, UNREADABLE_KEYS, [], path, errors);
    if (!isStr(card.id) || !ID_RE.test(card.id)) errors.push(`${path}.id: bad id`);
    if (!isStr(card.unreadable) || card.unreadable === '') errors.push(`${path}.unreadable: empty reason`);
    validateLog(card.log, `${path}.log`, errors);
    return errors;
  }
  keys(card, CARD_REQUIRED, CARD_OPTIONAL, path, errors);
  if (!isStr(card.id) || !ID_RE.test(card.id)) errors.push(`${path}.id: bad id`);
  if (!isRev(card.rev)) errors.push(`${path}.rev: not a positive integer`);
  if (!isStr(card.title) || card.title === '') errors.push(`${path}.title: empty`);
  if (!isStr(card.description) || /[\r\n]/.test(card.description) || [...card.description].length > 120) {
    errors.push(`${path}.description: not one line of <= 120 chars`);
  }
  if (!isStatus(card.status)) errors.push(`${path}.status: bad status`);
  for (const k of ['created', 'updated']) if (!isIso(card[k])) errors.push(`${path}.${k}: not an ISO time`);
  if (!SOURCES.includes(card.source)) errors.push(`${path}.source: bad source`);
  if (!isStr(card.sourceRef)) errors.push(`${path}.sourceRef: not a string`);
  if (Object.hasOwn(card, 'project') && !isStr(card.project)) errors.push(`${path}.project: not a string`);
  validateText(card, 'original', 'originalTruncated', path, errors);
  validateText(card, 'notes', 'notesTruncated', path, errors);
  const d = card.discord;
  if (!isObj(d)) errors.push(`${path}.discord: not an object`);
  else {
    keys(d, ['state'], ['url'], `${path}.discord`, errors);
    if (!DISCORD_STATES.includes(d.state)) errors.push(`${path}.discord.state: bad state`);
    if (Object.hasOwn(d, 'url') && !(isStr(d.url) && d.url.startsWith('https://'))) errors.push(`${path}.discord.url: not https`);
    const hasConflict = Object.hasOwn(card, 'conflict');
    if ((d.state === 'conflict') !== hasConflict) errors.push(`${path}.conflict: present iff discord.state is conflict`);
  }
  if (Object.hasOwn(card, 'conflict')) {
    const c = card.conflict;
    if (!isObj(c)) errors.push(`${path}.conflict: not an object`);
    else {
      keys(c, ['card', 'discord', 'since'], [], `${path}.conflict`, errors);
      if (!isStatus(c.card)) errors.push(`${path}.conflict.card: bad status`);
      if (!Array.isArray(c.discord) || c.discord.length === 0 || !c.discord.every(isStatus)) {
        errors.push(`${path}.conflict.discord: not a non-empty status list`);
      }
      if (!isIso(c.since)) errors.push(`${path}.conflict.since: not an ISO time`);
    }
  }
  validateLog(card.log, `${path}.log`, errors);
  return errors;
}

export function validateBoardState(state) {
  const errors = [];
  if (!isObj(state)) return { ok: false, errors: ['state: not an object'] };
  keys(state, TOP_KEYS, [], 'state', errors);
  if (state.schema !== BOARD_STATE_SCHEMA) errors.push('state.schema: wrong schema');
  if (typeof state.ok !== 'boolean') errors.push('state.ok: not a boolean');
  if (state.lastSync !== null && !isIso(state.lastSync)) errors.push('state.lastSync: not null or ISO time');
  if (!Number.isInteger(state.unpushedCommits) || state.unpushedCommits < 0) errors.push('state.unpushedCommits: not a count');
  const st = state.statuses;
  const statusOk = (s, i) => isObj(s) && Object.keys(s).length === 2
    && s.key === STATUS_KEYS[i] && s.label === STATUS_LABELS[STATUS_KEYS[i]];
  if (!Array.isArray(st) || st.length !== STATUS_KEYS.length || !st.every(statusOk)) {
    errors.push('state.statuses: not the 7 statuses in order');
  }
  if (!Array.isArray(state.cards)) errors.push('state.cards: not an array');
  else {
    const seen = new Set();
    state.cards.forEach((c, i) => {
      validateCard(c, `state.cards[${i}]`, errors);
      if (isObj(c) && seen.has(c.id)) errors.push(`state.cards[${i}].id: duplicate`);
      if (isObj(c)) seen.add(c.id);
    });
  }
  return { ok: errors.length === 0, errors };
}

// Shape check of a POST /memento body. Returns null when well-formed, else the 400 code.
export function checkSetStatusBody(body) {
  if (!isObj(body)) return 'BAD_REQUEST';
  const ks = Object.keys(body);
  if (ks.length !== SET_STATUS_KEYS.length || !SET_STATUS_KEYS.every((k) => ks.includes(k))) return 'BAD_REQUEST';
  if (body.action !== 'setStatus' || !isStr(body.id) || !isRev(body.rev)) return 'BAD_REQUEST';
  if (!isStr(body.requestId) || body.requestId === '') return 'BAD_REQUEST';
  if (!isStatus(body.status)) return 'BAD_STATUS';
  return null;
}

// Expected verdict for a body against a board state, without Discord or locks:
// {status: 200} | {status: 400|409, code}. Unreadable cards answer UNKNOWN_CARD.
export function expectedSetStatusVerdict(state, body) {
  const bad = checkSetStatusBody(body);
  if (bad) return { status: 400, code: bad };
  const card = state.cards.find((c) => c.id === body.id);
  if (!card || Object.hasOwn(card, 'unreadable')) return { status: 400, code: 'UNKNOWN_CARD' };
  if (card.rev !== body.rev) return { status: 409, code: 'STALE' };
  return { status: 200 };
}

// Shape check of any POST /memento reply {status, body}. The 500 WRITE_FAILED
// reply is exactly {ok:false, code:'WRITE_FAILED'}: no extra keys, no rev, no detail.
export function validateReply(reply) {
  if (!isObj(reply) || !isObj(reply.body)) return false;
  const { status, body } = reply;
  if (status === 200) {
    return Object.keys(body).length === 3 && body.ok === true && isRev(body.rev) && WRITE_DISCORD.includes(body.discord);
  }
  const codes = REPLY_CODES[status];
  if (!codes || body.ok !== false || !codes.includes(body.code)) return false;
  if (body.code === 'STALE') return Object.keys(body).length === 3 && isRev(body.rev);
  return Object.keys(body).length === 2;
}
