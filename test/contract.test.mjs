import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateBoardState, validateCard, expectedSetStatusVerdict, validateReply, TEXT_CAP_BYTES, LOG_LIMIT,
} from '../src/contract.mjs';
import { validateCard as validateSourceCard, serialize, parse } from '../src/card/codec.mjs';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const state = load('board-state.v1.json');
const { cases } = load('setStatus-cases.json');
const { replies } = load('replies.json');
const clone = (v) => structuredClone(v);
const source = load('board-source-card.json');

test('board-state fixture passes and covers the required card mix', () => {
  assert.deepEqual(validateBoardState(state), { ok: true, errors: [] });
  assert.equal(state.cards.length, 12);
  const readable = state.cards.filter((c) => !('unreadable' in c));
  assert.equal(new Set(readable.map((c) => c.status)).size, 7);
  const states = readable.map((c) => c.discord.state);
  for (const s of ['conflict', 'deleted', 'posting', 'invalid']) assert.ok(states.includes(s), s);
  assert.equal(state.cards.filter((c) => 'unreadable' in c).length, 1);
  const cut = readable.find((c) => c.originalTruncated);
  assert.ok(Buffer.byteLength(cut.original) <= TEXT_CAP_BYTES && /^[가-힣]+$/.test(cut.original));
  assert.ok(state.cards.some((c) => c.log.length === LOG_LIMIT));
  for (const c of state.cards) assert.ok(Array.isArray(c.log));
});

test('every card validates on its own', () => {
  for (const c of state.cards) assert.deepEqual(validateCard(c), [], c.id);
});

test('unknown top-level key is rejected', () => {
  const bad = { ...clone(state), extra: 1 };
  const r = validateBoardState(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('unknown key extra')));
});

test('malformed state shapes are rejected', () => {
  const mutate = (fn) => { const s = clone(state); fn(s); return validateBoardState(s).ok; };
  assert.equal(validateBoardState(null).ok, false);
  assert.equal(mutate((s) => { s.schema = 'memento.board-state.v2'; }), false);
  assert.equal(mutate((s) => { s.statuses.pop(); }), false);
  assert.equal(mutate((s) => { s.cards[0].log[0].evidence = {}; }), false);
  assert.equal(mutate((s) => { s.cards[0].original = '가'.repeat(1366); }), false);
  assert.equal(mutate((s) => { const c = s.cards.find((x) => x.log.length === LOG_LIMIT); c.log.push(c.log.at(-1)); }), false);
  assert.equal(mutate((s) => { const c = s.cards.find((x) => x.conflict); delete c.conflict; }), false);
  assert.equal(mutate((s) => { s.cards[1].status = '메모'; }), false);
  assert.equal(mutate((s) => { s.cards[0].log[0].actor = 'attacker'; }), false);
  assert.equal(mutate((s) => { s.cards[0].log[0].via = 'capture'; }), false);
  assert.equal(mutate((s) => { s.cards[0].log[0].change = 'delete-all'; }), false);
  assert.equal(mutate((s) => { s.statuses[0] = { key: 'idea', label: '메모', extra: 1 }; }), false);
  assert.equal(mutate((s) => { [s.statuses[0], s.statuses[1]] = [s.statuses[1], s.statuses[0]]; }), false);
  assert.equal(mutate((s) => { s.cards.find((x) => x.log.length === LOG_LIMIT).log.reverse(); }), false);
});

test('each setStatus case yields its expected verdict', () => {
  assert.ok(cases.length >= 6);
  for (const c of cases) assert.deepEqual(expectedSetStatusVerdict(state, c.body), c.expect, c.name);
});

test('canonical reply fixture is the exact WRITE_FAILED 500', () => {
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0], { status: 500, body: { ok: false, code: 'WRITE_FAILED' } });
  for (const r of replies) assert.equal(validateReply(r), true);
});

test('reply shapes', () => {
  assert.equal(validateReply({ status: 200, body: { ok: true, rev: 3, discord: 'pending' } }), true);
  assert.equal(validateReply({ status: 409, body: { ok: false, code: 'STALE', rev: 3 } }), true);
  assert.equal(validateReply({ status: 409, body: { ok: false, code: 'BUSY' } }), true);
  assert.equal(validateReply({ status: 501, body: { ok: false, code: 'MEMENTO_UNAVAILABLE' } }), true);
  assert.equal(validateReply({ status: 500, body: { ok: false, code: 'WRITE_FAILED' } }), true);
  assert.equal(validateReply({ status: 500, body: { ok: false, code: 'WRITE_FAILED', detail: 'x' } }), false);
  assert.equal(validateReply({ status: 500, body: { ok: false, code: 'WRITE_FAILED', rev: 3 } }), false);
  assert.equal(validateReply({ status: 500, body: { ok: true, code: 'WRITE_FAILED' } }), false);
  assert.equal(validateReply({ status: 500, body: { ok: false, code: 'STALE' } }), false);
  assert.equal(validateReply({ status: 409, body: { ok: false, code: 'WRITE_FAILED' } }), false);
  assert.equal(validateReply({ status: 500, body: { ok: false, code: 'UNKNOWN' } }), false);
  assert.equal(validateReply({ status: 500, body: { ok: false } }), false);
  assert.equal(validateReply({ status: 200, body: { ok: true, rev: 3, discord: 'sent' } }), false);
  assert.equal(validateReply({ status: 400, body: { ok: false, code: 'STALE' } }), false);
});

test('status objects pass regardless of property order', () => {
  const s = clone(state);
  s.statuses = s.statuses.map(({ key, label }) => ({ label, key }));
  assert.deepEqual(validateBoardState(s), { ok: true, errors: [] });
});

test('board card is the projection of its 14-entry source card', () => {
  assert.equal(source.log.length, 14);
  assert.equal([...source.original].length, 2000);
  assert.ok(source.log.some((e) => 'evidence' in e));
  const card = state.cards.find((c) => c.id === source.id);
  const pick = ({ at, actor, via, change, from, to, reason }) =>
    ({ at, actor, via, change, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), reason });
  assert.deepEqual(card.log, source.log.slice(-LOG_LIMIT).reverse().map(pick));
  for (const [field, flag] of [['original', 'originalTruncated'], ['notes', 'notesTruncated']]) {
    const full = Buffer.from(source[field]);
    assert.ok(full.length > TEXT_CAP_BYTES && card[flag] === true);
    assert.ok(source[field].startsWith(card[field]));
    const len = Buffer.byteLength(card[field]);
    assert.ok(len <= TEXT_CAP_BYTES);
    const next = [...source[field].slice(card[field].length)][0];
    assert.ok(len + Buffer.byteLength(next) > TEXT_CAP_BYTES);
  }
});

test('source card is a valid canonical card whose history matches its status', () => {
  assert.equal(validateSourceCard(source), null);
  assert.deepEqual(parse(serialize(source)), { card: source });
  const card = state.cards.find((c) => c.id === source.id);
  const lastStatus = source.log.filter((e) => e.change === 'status').at(-1);
  assert.equal(lastStatus.to, source.status);
  assert.equal(card.status, source.status);
  assert.equal(card.rev, source.rev);
  assert.equal(card.discord.state, source.discordState);
  assert.equal(source.log.at(-1).change, 'invalid-remote');
  assert.ok(!('to' in source.log.at(-1)));
});
