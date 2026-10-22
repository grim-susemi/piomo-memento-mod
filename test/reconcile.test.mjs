import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcile } from '../src/sync/reconcile.mjs';
import { board, phone, input, cases } from './fixtures/reconcile/decision-table.mjs';
import { generatedHistories, compatibleHistories, HISTORY_SEED } from './fixtures/reconcile/compatible-histories.mjs';
import { canonicalInvalidRepro, invalidBoundaryCases, operationKeyCases } from './fixtures/reconcile/review-repros.mjs';

for (const [name, given, kind, status] of cases) {
  test(name, () => {
    // Given a decision-table history; when reconciled; then only its allowed action.
    const actual = reconcile(structuredClone(given));
    assert.equal(actual.kind, kind);
    assert.equal(actual.status, status);
    assert.equal(typeof actual.reason, 'string');
    assert.equal(typeof actual.evidence, 'object');
    if (['conflict', 'invalidRemote', 'markDeleted', 'none'].includes(kind)) {
      assert.equal(Object.hasOwn(actual, 'status'), false);
    }
  });
}

test('review invalid two-call bot-only repair preserves unresolved state without a boundary', () => {
  // Given the reviewer's linked -> invalid transition; when only a bot repairs it; then no owner intent is invented.
  const first = reconcile(structuredClone(canonicalInvalidRepro.firstInput));
  assert.equal(first.kind, 'invalidRemote');
  const second = reconcile(structuredClone(canonicalInvalidRepro.secondInput));
  assert.equal(second.kind, 'invalidRemote');
  assert.equal(second.status, undefined);
});

for (const [name, given, kind, status] of invalidBoundaryCases) {
  test(`review invalid ${name}`, () => {
    // Given the unresolved-state boundary; when reconciled; then only a provable owner repair is taken.
    const actual = reconcile(structuredClone(given));
    assert.equal(actual.kind, kind);
    assert.equal(actual.status, status);
  });
}

for (const [name, given, kind, status, interval, entryId] of operationKeyCases) {
  test(`review operation ${name}`, () => {
    // Given explicit or missing operation correlation; when reconciled; then only an exact matching PATCH narrows time.
    const actual = reconcile(structuredClone(given));
    assert.equal(actual.kind, kind);
    assert.equal(actual.status, status);
    assert.deepEqual(actual.evidence.boardInterval, interval);
    assert.equal(actual.evidence.boardAuditEntryId, entryId);
  });
}

test('ISO timestamps and numeric milliseconds yield the same ordered action', () => {
  // Given equivalent serializations; when compared; then the action is unchanged.
  const given = input({
    status: 'done',
    events: [board('2026-01-01T00:00:10.000Z')],
    entries: [phone('2026-01-01T00:00:16.000Z')],
    tags: ['researching'],
  });
  const actual = reconcile(given);
  assert.equal(actual.kind, 'take');
  assert.equal(actual.status, 'researching');
});

test('audit delivery order does not substitute for owner event time', () => {
  // Given newest-first delivery; when reconciled; then the actual latest owner wins.
  const given = input({
    status: 'done', events: [board(10000)],
    entries: [phone(16000, 'idea'), phone(13000)], tags: ['idea'],
  });
  const actual = reconcile(given);
  assert.equal(actual.kind, 'take');
  assert.equal(actual.status, 'idea');
});

test('equal-time owner entries with different terminal values cannot be ordered by IDs', () => {
  // Given indistinguishable intervals; when reconciled; then IDs cannot pick a winner.
  const given = input({
    entries: [phone(16000, 'idea', { entryId: 'zzz' }), phone(16000, 'held', { entryId: 'aaa' })],
    tags: ['held'],
  });
  assert.equal(reconcile(given).kind, 'conflict');
});

test('the append-only board history keeps causal order across a backwards local clock', () => {
  // Given two local picks in recorded order; when reconciled; then the final pick wins.
  const given = input({
    status: 'held',
    events: [board(20000), board(10000, 'held', { from: 'done', eventId: 'later-choice' })],
    entries: [phone(4000)], tags: ['researching'],
  });
  const actual = reconcile(given);
  assert.equal(actual.kind, 'push');
  assert.equal(actual.status, 'held');
});

test('frozen inputs are not mutated and repeated calls have identical evidence', () => {
  // Given recursively frozen input; when called twice; then input and result are stable.
  const given = input({ status: 'done', events: [board(10000)] });
  const freeze = (value) => {
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === 'object') freeze(child);
    }
    return Object.freeze(value);
  };
  freeze(given);
  assert.deepEqual(reconcile(given), reconcile(given));
});

test('history oracle independently exhibits two incompatible latest-owner outcomes', () => {
  // Given uncertain owner picks; when all feasible histories are replayed; then both survive.
  const given = input({
    status: 'done', events: [board(10000)], entries: [phone(11000)],
    tags: ['researching'],
  });
  const histories = compatibleHistories(given);
  assert.deepEqual(new Set(histories.map((history) => history.finalStatus)), new Set(['done', 'researching']));
  assert.ok(histories.every((history) => history.order.length === history.times.length));
});

test('seeded 2000 histories never choose a status when compatible histories disagree', (t) => {
  // Given independently enumerated schedules; when reconciled; then no ambiguous overwrite.
  const counts = { inputs: 0, histories: 0, ambiguous: 0, push: 0, take: 0, setBase: 0 };
  for (const given of generatedHistories()) {
    const histories = compatibleHistories(given);
    const outcomes = new Set(histories.map((history) => history.finalStatus));
    assert.ok(histories.length > 0, 'generator must have a feasible witness');
    const actual = reconcile(given);
    counts.inputs += 1;
    counts.histories += histories.length;
    if (outcomes.size > 1) {
      counts.ambiguous += 1;
      assert.ok(!['push', 'take'].includes(actual.kind),
        JSON.stringify({ seed: HISTORY_SEED, index: counts.inputs - 1, given, histories, actual }));
    }
    if (['push', 'take'].includes(actual.kind)) {
      counts[actual.kind] += 1;
      assert.deepEqual([...outcomes], [actual.status],
        JSON.stringify({ seed: HISTORY_SEED, index: counts.inputs - 1, given, histories, actual }));
    }
    if (actual.kind === 'setBase') counts.setBase += 1;
  }
  assert.equal(counts.inputs, 2000);
  assert.ok(counts.ambiguous > 100, 'the uncertainty property must not be vacuous');
  assert.ok(counts.push > 100 && counts.take > 100 && counts.setBase > 0);
  t.diagnostic(JSON.stringify({ event: 'compatible-history-property', seed: HISTORY_SEED, pid: process.pid, ...counts }, null, 2));
});
