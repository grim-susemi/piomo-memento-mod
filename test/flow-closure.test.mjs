// TASK13 B1/B2: pure closed-world baseline and mutation table.
//
// This file is deliberately not part of test/no-background.test.mjs: it reads
// source text only and never starts the real lifecycle, a fake server, a
// timer, a scheduled task or a child process.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyze,
  LARGE_FUNCTIONS,
  sourceFiles,
} from './fixtures/no-background/flow-closure.mjs';
import { requestOffenders } from './fixtures/no-background/request-rules.mjs';
import { timerOffenders } from './fixtures/no-background/timer-rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INVENTORY = JSON.parse(readFileSync(
  join(ROOT, 'test', 'fixtures', 'no-background', 'reviewed-flows.json'),
  'utf8',
));
const MUTATIONS = JSON.parse(readFileSync(
  join(ROOT, 'test', 'fixtures', 'no-background', 'flow-mutations.json'),
  'utf8',
));
const FILES = sourceFiles(ROOT);

const REQUIRED_CENSUS = [
  'setTimeout', 'clearTimeout', 'setInterval', 'setImmediate',
  'sleepReal', 'realSleep', 'sleep', 'delay', 'createDeadline', 'dispose',
  'URL', 'fetch', 'httpsRequest', 'httpRequest', 'HttpsAgent', 'HttpAgent',
  'requestOnce', 'joinUrl', 'querySuffix', 'baseUrl', 'DEFAULT_BASE_URL',
  'globalThis', 'prototype', '.constructor', 'defineProperty', 'setPrototypeOf',
  'Reflect', 'Proxy', 'eval', 'Function', 'with', 'createRequire', 'import(',
];
const REQUIRED_SPECIFIERS = [
  'node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram',
  'node:http2', 'node:vm', 'node:module', 'node:timers', 'node:timers/promises',
];
const REQUIRED_MUTATIONS = [
  'attempt4.foreign-pin-status-url',
  'attempt4.foreign-pin-status-specifier',
  'attempt4.dispose-control-wrapper',
  'attempt4.promise-member-write',
  'control.promise-member-compound',
  'control.promise-member-computed',
  'control.promise-member-increment',
  'control.abortsignal-member-write',
  'control.line-owner-sleep-wrapper',
  'control.line-setup-sleep-wrapper',
  'control.line-client-baseUrl-wrapper',
  'control.line-fake-handle-url-wrapper',
  'control.line-sync-baseUrl-wrapper',
  'attempt5.dispose-return-gate',
  'attempt5.promise-definegetter',
  'attempt5.object-defineproperty',
  'attempt5.reflect-defineproperty',
  'attempt7.comment-body-decoy-gate',
  'attempt7.string-body-decoy-gate',
  'attempt7.unrelated-body-decoy-gate',
];

function applyMutation(files, row) {
  let changed = false;
  const next = files.map((file) => {
    if (file.path !== row.file) return file;
    const count = file.source.split(row.find).length - 1;
    assert.equal(count, 1, `${row.id}: find must occur exactly once in ${row.file}`);
    changed = true;
    return { ...file, source: file.source.replace(row.find, row.replace) };
  });
  assert.equal(changed, true, `${row.id}: file ${row.file} is missing`);
  return next;
}

function closureCodes(files) {
  const result = analyze(files, INVENTORY);
  return {
    result,
    codes: [...result.inventory, ...result.closure].map((entry) => entry.code),
  };
}

test('Test_Reviewed_flow_inventory_covers_every_census_occurrence', () => {
  const census = new Set(INVENTORY.census.map((rule) => rule.token));
  for (const token of REQUIRED_CENSUS) {
    assert.equal(census.has(token), true, `census is missing ${token}`);
  }
  for (const specifier of REQUIRED_SPECIFIERS) {
    assert.equal(INVENTORY.specifiers.includes(specifier), true,
      `specifier census is missing ${specifier}`);
  }
  assert.deepEqual(
    new Set(INVENTORY.globalReadTokens),
    new Set(['Promise', 'AbortController', 'AbortSignal']),
  );
  assert.equal(INVENTORY.entries.every((entry) => (
    entry.unit !== 'function' || !LARGE_FUNCTIONS.has(entry.path)
  )), true, 'a high-churn function was pinned whole');
  assert.equal(INVENTORY.entries.filter((entry) => entry.file === 'src/card/status.mjs').length,
    0, 'the foreign-pin status file must have zero pins');
  assert.equal(INVENTORY.entries.filter((entry) => entry.unit === 'line')
    .every((entry) => Array.isArray(entry.controls)), true,
  'every line pin must carry its exact enclosing control chain');
  const dispose = INVENTORY.entries.find((entry) => entry.id === 'line.sync.dispose');
  assert.equal(typeof dispose?.body?.raw, 'string', 'the sync cleanup body must be pinned');
  assert.equal(dispose.body.sha256.length, 64, 'the sync cleanup body hash must be present');
  assert.equal(dispose.body.raw.includes('const discordDeadline = createDeadline('), true,
    'the cleanup body must include its owning deadline binding');
  assert.equal(dispose.body.raw.includes('discordDeadline.dispose();'), true,
    'the cleanup body must include the disposal call');
  for (const id of REQUIRED_MUTATIONS) {
    assert.equal(MUTATIONS.rows.some((row) => row.id === id), true,
      `corpus is missing ${id}`);
  }

  const result = analyze(FILES, INVENTORY);
  assert.deepEqual(result.inventory, []);
  assert.deepEqual(result.closure, []);
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, INVENTORY.entries.length);
  assert.equal(result.entries.every((entry) => entry.status === 'resolved'), true,
    JSON.stringify(result.entries.filter((entry) => entry.status !== 'resolved')));

  const timers = timerOffenders(FILES);
  const requests = requestOffenders(FILES);
  assert.deepEqual(timers, []);
  assert.deepEqual(requests.offenders, []);
  assert.equal(requests.presentationLiteral?.status, 'approved-423A');
  assert.equal(requests.presentationLiteral?.value,
    'https://discord.com/channels/${guildId}/${card.discordThread}');

  console.log(JSON.stringify({
    event: 'task13-flow-baseline',
    entries: result.entries.length,
    functions: INVENTORY.entries.filter((entry) => entry.unit === 'function').length,
    lines: INVENTORY.entries.filter((entry) => entry.unit === 'line').length,
    censusTokens: INVENTORY.census.length,
    specifiers: INVENTORY.specifiers.length,
    timerOffenders: timers.length,
    requestOffenders: requests.offenders.length,
    presentationLiteral: requests.presentationLiteral?.status ?? null,
  }));
});

test('Test_Reviewed_flow_mutation_table_rejects_every_reviewed_case', () => {
  let passed = 0;
  for (const row of MUTATIONS.rows) {
    const mutated = applyMutation(FILES, row);
    const { result, codes } = closureCodes(mutated);
    const timers = timerOffenders(mutated);
    const requests = requestOffenders(mutated);
    const reasons = [
      ...timers.map((entry) => entry.reason),
      ...requests.offenders.map((entry) => entry.reason),
    ];
    const combinedRejected = result.ok
      ? timers.length > 0 || requests.offenders.length > 0
      : true;
    if (row.id === 'attempt4.foreign-pin-status-url') {
      const status = mutated.find((file) => file.path === 'src/card/status.mjs').source;
      assert.equal(status.indexOf('globalThis.URL'), 692,
        'foreign-pin counterexample must start at the reviewed offset');
      assert.deepEqual(
        [...status.matchAll(/\bURL\b/g)].map((match) => match.index).filter((index) => index > 691),
        [703, 723],
      );
    }
    if (row.expectCode.startsWith('reason:')) {
      const needle = row.expectCode.slice('reason:'.length);
      assert.equal(reasons.some((reason) => reason.includes(needle)), true,
        `${row.id}: expected reason ${needle}; codes=${JSON.stringify(codes)} reasons=${JSON.stringify(reasons)}`);
    } else {
      assert.equal(codes.some((code) => code.startsWith(row.expectCode)), true,
        `${row.id}: expected ${row.expectCode}; codes=${JSON.stringify(codes)} reasons=${JSON.stringify(reasons)}`);
    }
    assert.equal(combinedRejected, true, `${row.id}: combined verdict unexpectedly passed`);
    passed += 1;
    console.log(JSON.stringify({
      event: 'task13-flow-mutation',
      id: row.id,
      priorCase: row.priorCase ?? null,
      expectCode: row.expectCode,
      closureCodes: codes.length,
      timerReasons: timers.length,
      requestReasons: requests.offenders.length,
      closureOnlyRejected: !result.ok,
      combinedRejected,
    }));
  }
  assert.equal(passed, MUTATIONS.rows.length);
  console.log(JSON.stringify({
    event: 'task13-flow-mutations',
    rows: MUTATIONS.rows.length,
    passed,
  }));
});
