import assert from 'node:assert/strict';
import { reconcile } from '../../../src/sync/reconcile.mjs';
import { input, board, phone } from './decision-table.mjs';
import { compatibleHistories } from './compatible-histories.mjs';

const uncertain = input({
  status: 'done', events: [board(10000)], entries: [phone(11000)],
  tags: ['researching'],
});
const laterRoundtrip = input({
  status: 'done', events: [board(10000)],
  entries: [phone(13000), phone(16000, 'idea', { from: 'researching' })],
});
const clock = Date.now;
const random = Math.random;
const fetch = globalThis.fetch;
const forbidden = () => { throw new Error('ambient I/O, clock or randomness used'); };
const before = process.getActiveResourcesInfo().toSorted();
try {
  Date.now = forbidden;
  Math.random = forbidden;
  globalThis.fetch = forbidden;
  const overlapAction = reconcile(uncertain);
  const roundtripAction = reconcile(laterRoundtrip);
  assert.equal(overlapAction.kind, 'conflict');
  assert.equal(roundtripAction.kind, 'take');
  assert.equal(roundtripAction.status, 'idea');
  const histories = compatibleHistories(uncertain);
  assert.equal(new Set(histories.map((history) => history.finalStatus)).size, 2);
  assert.deepEqual(process.getActiveResourcesInfo().toSorted(), before);
  console.log(JSON.stringify({
    event: 'reconcile-direct-invocation', pid: process.pid, ambientReadsBlocked: true,
    activeResourcesBefore: before, activeResourcesAfter: process.getActiveResourcesInfo().toSorted(),
    overlapping: { input: uncertain, action: overlapAction, compatibleHistories: histories },
    laterOwnerRoundtrip: { input: laterRoundtrip, action: roundtripAction },
  }, null, 2));
} finally {
  Date.now = clock;
  Math.random = random;
  globalThis.fetch = fetch;
}
