import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { createReceipts, RECEIPT_LOG } from '../src/receipts.mjs';

const TOKEN = 'synthetic-discord-token-0123456789';
let tempDirs = [];

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'memento-receipts-'));
  tempDirs.push(directory);
  return directory;
}

function lines(agentDir) {
  return readFileSync(join(agentDir, 'logs', RECEIPT_LOG), 'utf8').trim().split(/\r?\n/);
}

afterEach(() => {
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
  tempDirs = [];
});

test('Test_Append_writes_one_json_line_per_receipt', () => {
  const agentDir = tempDir();
  const receipts = createReceipts({ agentDir });

  assert.equal(receipts.append({ event: 'first', detail: 1 }), true);
  assert.equal(receipts.append({ event: 'second' }), true);

  const [first, second] = lines(agentDir).map(line => JSON.parse(line));
  assert.equal(first.event, 'first');
  assert.equal(first.detail, 1);
  assert.equal(Number.isNaN(Date.parse(first.at)), false);
  assert.equal(second.event, 'second');
  assert.equal(receipts.path, join(agentDir, 'logs', RECEIPT_LOG));
});

test('Test_Append_when_no_agent_dir_is_known returns false without throwing', () => {
  const receipts = createReceipts({ agentDir: '' });
  assert.equal(receipts.path, null);
  assert.equal(receipts.append({ event: 'nothing' }), false);
});

test('Test_Append_refuses_an_entry_whose_string_values_carry_the_token', () => {
  const agentDir = tempDir();
  const receipts = createReceipts({ agentDir, getToken: () => TOKEN });
  const printed = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => printed.push(args.join(' '));
  console.warn = (...args) => printed.push(args.join(' '));
  console.error = (...args) => printed.push(args.join(' '));
  let accepted;
  try {
    accepted = receipts.append({
      event: 'discord-call',
      url: `https://discord.com/api/v10/channels/${TOKEN}/messages`,
      nested: { note: `token=${TOKEN}` },
      list: [`prefix ${TOKEN} suffix`],
      safe: 'unchanged',
    });
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  assert.equal(accepted, false);
  assert.equal(existsSync(join(agentDir, 'logs', RECEIPT_LOG)), false);
  assert.deepEqual(printed, []);
});

test('Test_Append_when_a_property_name_carries_the_token refuses the whole entry (B1 regression)', () => {
  const agentDir = tempDir();
  const path = join(agentDir, 'logs', RECEIPT_LOG);
  const receipts = createReceipts({ agentDir, getToken: () => TOKEN });

  assert.equal(receipts.append({ event: 'synthetic-key-probe', [TOKEN]: 'safe-marker' }), false);
  assert.equal(receipts.append({ event: 'nested-key-probe', nested: { [TOKEN]: 'safe-marker' } }), false);
  assert.equal(receipts.append({ event: 'array-key-probe', list: [{ [TOKEN]: 'safe-marker' }] }), false);
  assert.equal(receipts.append({ event: 'nested-value-probe', list: [{ note: `prefix ${TOKEN} suffix` }] }), false);

  // Nothing was written, not even a partial line, and no secret was printed.
  assert.equal(existsSync(path), false, 'refused entries must not create the receipt log');

  // A later clean entry is written alone; none of the refused payload leaks in.
  assert.equal(receipts.append({ event: 'after-refusal', detail: 'ok' }), true);
  const raw = readFileSync(path, 'utf8');
  assert.equal(raw.includes(TOKEN), false);
  assert.equal(raw.includes('safe-marker'), false);
  const logged = raw.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, 'after-refusal');
  for (const line of logged) {
    for (const key of Object.keys(line)) assert.equal(key.includes(TOKEN), false);
    assert.equal(JSON.stringify(line).includes(TOKEN), false);
  }
});

test('Test_Append_when_the_log_path_is_a_directory reports once and returns false', () => {
  const agentDir = tempDir();
  mkdirSync(join(agentDir, 'logs', RECEIPT_LOG), { recursive: true });

  const receipts = createReceipts({ agentDir });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.equal(receipts.append({ event: 'failing' }), false);
    assert.equal(receipts.append({ event: 'failing-again' }), false);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /memento receipt write failed/);
  assert.equal(existsSync(join(agentDir, 'logs', RECEIPT_LOG)), true);
});
