import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { reconcile } from '../../../src/sync/reconcile.mjs';

// Exact inputs from the independent review's canonicalInvalidRepro.
const historicalOwner = {
  entryId: 'audit-4000', at: 4000, actor: 'owner', reason: null,
  from: 'idea', to: 'researching',
};
const emptied = {
  entryId: 'audit-10000', at: 10000, actor: 'bot', reason: null,
  from: 'researching', to: null,
};
const restored = {
  entryId: 'audit-16000', at: 16000, actor: 'bot', reason: null,
  from: null, to: 'researching',
};
export const canonicalInvalidRepro = {
  firstInput: {
    card: { status: 'idea', discordBase: 'idea', discordState: 'linked', boardEvents: [] },
    remote: { exists: true, statusTags: [] },
    audit: { coverage: 'complete', entries: [historicalOwner, emptied] },
  },
  secondInput: {
    card: { status: 'idea', discordBase: 'idea', discordState: 'invalid', boardEvents: [] },
    remote: { exists: true, statusTags: ['researching'] },
    audit: { coverage: 'complete', entries: [historicalOwner, emptied, restored] },
  },
};

const invalidWithOwner = (at, since) => {
  const given = structuredClone(canonicalInvalidRepro.secondInput);
  if (since !== undefined) given.card.conflictSince = since;
  given.remote.statusTags = ['held'];
  given.audit.entries.push({
    entryId: `owner-${at}`, at, actor: 'owner', reason: null,
    from: 'researching', to: 'held',
  });
  return given;
};
const knownBotRepair = structuredClone(canonicalInvalidRepro.secondInput);
knownBotRepair.card.conflictSince = 10000;
const partialResolution = invalidWithOwner(20000, 10000);
partialResolution.audit.coverage = 'partial';
partialResolution.card.status = 'done';
partialResolution.card.boardEvents = [{
  eventId: 'resolve-current-invalid', at: 26000, uncertaintyMs: 2000,
  from: 'idea', to: 'done', resolves: true,
}];
const missingBoundaryResolution = (ownerAt) => {
  const given = invalidWithOwner(ownerAt);
  given.card.status = partialResolution.card.status;
  given.card.boardEvents = structuredClone(partialResolution.card.boardEvents);
  return given;
};

export const invalidBoundaryCases = [
  ['known boundary does not turn bot-only repair into owner intent', knownBotRepair, 'invalidRemote'],
  ['owner interval strictly after a known invalid boundary repairs it', invalidWithOwner(20000, 10000), 'take', 'held'],
  ['missing invalid boundary cannot prove even a later-looking owner repair', invalidWithOwner(20000), 'invalidRemote'],
  ['owner interval touching the invalid boundary is unresolved', invalidWithOwner(11000, 10000), 'invalidRemote'],
  ['owner interval one millisecond past the invalid boundary is fresh', invalidWithOwner(11001, 10000), 'take', 'held'],
  ['explicit invalid resolution still cannot push under partial coverage', partialResolution, 'conflict'],
  ['explicit resolution without a boundary still respects a later phone pick', missingBoundaryResolution(32000), 'take', 'held'],
  ['explicit resolution without a boundary can win over a proven earlier phone pick', missingBoundaryResolution(20000), 'push', 'done'],
  ['explicit resolution without a boundary retains overlap uncertainty', missingBoundaryResolution(27000), 'conflict'],
];

// Exact shared input from the independent review's operationKeyProbes.
export const operationKeyProbes = {
  card: {
    status: 'done', discordBase: 'idea', discordState: 'linked',
    boardEvents: [{
      eventId: 'board-choice', at: 10000, uncertaintyMs: 9000,
      from: 'idea', to: 'done', resolves: false,
    }],
  },
  remote: { exists: true, statusTags: ['done'] },
  audit: {
    coverage: 'complete',
    entries: [
      historicalOwner,
      {
        entryId: 'audit-10000', at: 10000, actor: 'bot',
        reason: 'memento-board write-op-17', from: 'researching', to: 'done',
      },
    ],
  },
};
const correlated = structuredClone(operationKeyProbes);
correlated.card.boardEvents[0].operationKey = 'write-op-17';
const eventIdSpoof = structuredClone(operationKeyProbes);
eventIdSpoof.audit.entries[1].reason = 'memento-board board-choice';
const absentKeySpoof = structuredClone(operationKeyProbes);
absentKeySpoof.audit.entries[1].reason = 'memento-board undefined';
const explicitEqualKey = structuredClone(eventIdSpoof);
explicitEqualKey.card.boardEvents[0].operationKey = 'board-choice';
const syncKey = structuredClone(correlated);
syncKey.audit.entries[1].reason = 'memento-sync write-op-17';
const prefixSpoof = structuredClone(correlated);
prefixSpoof.audit.entries[1].reason = 'memento-board write-op-17-extra';
const wrongTarget = structuredClone(correlated);
wrongTarget.audit.entries[1].to = 'held';
const partialCorrelation = structuredClone(correlated);
partialCorrelation.audit.coverage = 'partial';
const local = [1000, 19000];
const acknowledged = [9000, 11000];

export const operationKeyCases = [
  ['uncorrelated reviewer operation retains local uncertainty', operationKeyProbes, 'conflict', undefined, local, null],
  ['eventId-shaped reason is not implicit correlation', eventIdSpoof, 'conflict', undefined, local, null],
  ['absent operationKey cannot match a literal undefined reason', absentKeySpoof, 'conflict', undefined, local, null],
  ['distinct eventId and correlated operationKey acknowledge PATCH', correlated, 'setBase', 'done', acknowledged, 'audit-10000'],
  ['equal eventId and operationKey work only with explicit correlation', explicitEqualKey, 'setBase', 'done', acknowledged, 'audit-10000'],
  ['correlated sync operation also requires an exact key', syncKey, 'setBase', 'done', acknowledged, 'audit-10000'],
  ['correlated reason prefix cannot acknowledge another operation', prefixSpoof, 'conflict', undefined, local, null],
  ['correlated key with a different target cannot acknowledge PATCH', wrongTarget, 'conflict', undefined, local, null],
  ['correlated PATCH cannot bypass partial coverage', partialCorrelation, 'conflict', undefined, acknowledged, 'audit-10000'],
];

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const first = reconcile(structuredClone(canonicalInvalidRepro.firstInput));
  assert.equal(first.kind, 'invalidRemote');
  const second = reconcile(structuredClone(canonicalInvalidRepro.secondInput));
  assert.equal(second.kind, 'invalidRemote');
  assert.equal(second.status, undefined);
  const checks = [...invalidBoundaryCases, ...operationKeyCases].map(
    ([name, given, kind, status, interval, entryId]) => {
      const actual = reconcile(structuredClone(given));
      assert.equal(actual.kind, kind, name);
      assert.equal(actual.status, status, name);
      if (interval) {
        assert.deepEqual(actual.evidence.boardInterval, interval, name);
        assert.equal(actual.evidence.boardAuditEntryId, entryId, name);
      }
      return { name, input: given, action: actual };
    },
  );
  console.log(JSON.stringify({
    event: 'task8-review-delta', pid: process.pid,
    canonicalInvalidRepro: { inputs: canonicalInvalidRepro, first, second, newOwnerEvents: 0, newBoardPicks: 0 },
    checks,
  }, null, 2));
}
