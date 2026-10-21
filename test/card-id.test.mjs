import test from 'node:test';
import assert from 'node:assert/strict';

import { idForThread, newId } from '../src/card/id.mjs';
import {
  STATUS_KEYS,
  STATUS_LABELS,
  isStatus,
  statusFromLabel,
  statusLabel,
} from '../src/card/status.mjs';

const threeBytes = (a, b, c) => () => Buffer.from([a, b, c]);

test('newId dates the id in Asia/Seoul, not in UTC', () => {
  assert.equal(
    newId(Date.UTC(2026, 9, 21, 14, 59, 59), threeBytes(0x12, 0x34, 0x56)),
    '20261021-ci2f',
  );
  assert.equal(
    newId(Date.UTC(2026, 9, 21, 15, 0, 0), threeBytes(0x12, 0x34, 0x56)),
    '20261022-ci2f',
  );
  assert.equal(
    newId(Date.UTC(2025, 11, 31, 15, 0, 0), threeBytes(0, 0, 0)),
    '20260101-aaaa',
  );
});

test('newId encodes exactly 20 random bits as four base32 characters', () => {
  assert.equal(newId(Date.UTC(2026, 9, 21), threeBytes(0, 0, 0)), '20261021-aaaa');
  assert.equal(
    newId(Date.UTC(2026, 9, 21), threeBytes(0xff, 0xff, 0xff)),
    '20261021-7777',
  );
});

test('newId with the default random source always matches the id shape', () => {
  for (let i = 0; i < 20; i += 1) {
    const id = newId(Date.UTC(2026, 9, 21));
    assert.match(id, /^20261021-[a-z2-7]{4}$/);
  }
});

test('idForThread is deterministic and dates the snowflake in Asia/Seoul', () => {
  const thread = '1562488130764800000';
  assert.equal(idForThread('123', thread), '20261022-jycv');
  assert.equal(idForThread('123', thread), idForThread('123', thread));
  assert.match(idForThread('123', thread), /^\d{8}-[a-z2-7]{4}$/);
});

test('idForThread separates guilds and threads', () => {
  const a = idForThread('123', '1562488130764800000');
  const b = idForThread('124', '1562488130764800000');
  const c = idForThread('123', '1562488130764800001');
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
});

test('status keys and Korean labels map one to one', () => {
  assert.deepEqual(STATUS_KEYS, [
    'idea',
    'researching',
    'planned',
    'building',
    'done',
    'held',
    'dropped',
  ]);
  assert.deepEqual(STATUS_KEYS.map(statusLabel), [
    '메모',
    '조사중',
    '계획됨',
    '구현중',
    '완료',
    '보류',
    '폐기',
  ]);
  for (const key of STATUS_KEYS) {
    assert.equal(isStatus(key), true);
    assert.equal(statusFromLabel(STATUS_LABELS[key]), key);
    assert.equal(statusLabel(key), STATUS_LABELS[key]);
  }
  assert.equal(isStatus('nope'), false);
  assert.equal(statusLabel('nope'), null);
  assert.equal(statusFromLabel('없는 상태'), null);
});
