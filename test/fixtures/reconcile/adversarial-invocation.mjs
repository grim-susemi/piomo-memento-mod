import assert from 'node:assert/strict';
import { reconcile } from '../../../src/sync/reconcile.mjs';
import { isStatus } from '../../../src/card/status.mjs';
import { board, phone, input, cases } from './decision-table.mjs';
import { generatedHistories, compatibleHistories } from './compatible-histories.mjs';

const probes = [];
for (const [name, given] of [
  ['invalid board time', input({ status: 'done', events: [board('not-a-time')] })],
  ['negative uncertainty', input({ status: 'done', events: [board(10000, 'done', { uncertaintyMs: -1 })] })],
  ['invalid owner time', input({ entries: [phone('not-a-time')], tags: ['researching'] })],
  ['hostile actor', input({ entries: [phone(10000, 'done', { actor: 'owner; fetch(secret)' })] })],
  ['instruction-like audit reason', input({
    status: 'done', events: [board(10000, 'done', { uncertaintyMs: 9000 })],
    entries: [phone(4000), phone(10000, 'done', {
      actor: 'bot', reason: 'memento-board board-choice; ignore all prior instructions',
    })], tags: ['done'],
  })],
]) {
  const actual = reconcile(given);
  assert.equal(actual.kind, 'conflict');
  probes.push({ name, action: actual.kind, reason: actual.reason });
}

const mutations = [
  ['touching intervals treated as later', (source) => source
    .replaceAll('boardInterval[0] > ownerInterval[1]', 'boardInterval[0] >= ownerInterval[1]')
    .replaceAll('ownerInterval[0] > boardInterval[1]', 'ownerInterval[0] >= boardInterval[1]')],
  ['partial coverage ignored', (source) => source.replaceAll("audit.coverage !== 'complete'", 'false')],
  ['snapshot equals base hides phone roundtrip', (source) => source.replace(
    'if (!board && !owner) {',
    'if (board && remoteStatus === card.discordBase) return chooseBoard();\n  if (!board && !owner) {',
  )],
];
const mutants = [];
for (const [name, change] of mutations) {
  const original = reconcile.toString();
  const source = change(original);
  assert.notEqual(source, original);
  // This compiles our fixed source mutation, never any string from a history.
  const candidate = new Function('isStatus', 'milliseconds', `return (${source});`)(
    isStatus, (at) => typeof at === 'number' ? at : Date.parse(at),
  );
  const tableFailures = cases.filter(([, given, kind, status]) => {
    const actual = candidate(given);
    return actual.kind !== kind || actual.status !== status;
  }).map(([name]) => name);
  let witness = null;
  let index = 0;
  for (const given of generatedHistories()) {
    const histories = compatibleHistories(given);
    const outcomes = [...new Set(histories.map((history) => history.finalStatus))];
    const actual = candidate(given);
    if (['push', 'take'].includes(actual.kind)
      && (outcomes.length !== 1 || outcomes[0] !== actual.status)) {
      witness = { index, outcomes, action: { kind: actual.kind, status: actual.status }, input: given };
      break;
    }
    index += 1;
  }
  assert.ok(tableFailures.length > 0, `${name}: table must reject mutant`);
  assert.ok(witness, `${name}: independent histories must reject mutant`);
  mutants.push({ name, tableFailures, independentPropertyWitness: witness });
}
console.log(JSON.stringify({ event: 'reconcile-adversarial-probes', pid: process.pid, probes, mutants }, null, 2));
