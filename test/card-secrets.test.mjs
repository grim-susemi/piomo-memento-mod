import test from 'node:test';
import assert from 'node:assert/strict';

import { findSecret } from '../src/card/secrets.mjs';

const cases = [
  [
    'discord-token',
    'MTA5NzU4NDY4Mjc1MzYzNTM1OA.Gk3dQ2.9c0zAbCdEfGhIjKlMnOpQrStUvW',
  ],
  ['sk-key', 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx'],
  ['github-token', 'ghp_1234567890abcdefghijklmnopqrstuvwxyz'],
  ['aws-access-key', 'AKIA1234567890ABCDEF'],
  ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEexample'],
  ['env-key', 'API_KEY=abcdefghijklmnopqrstuvwxyz012345'],
];

for (const [name, text] of cases) {
  test(`findSecret reports ${name}`, () => {
    assert.equal(findSecret(`before ${text} after`), name);
  });
}

test('findSecret reports the literal Scope BEGIN guard for PGP and generic headers', () => {
  assert.equal(findSecret('-----BEGIN PGP PRIVATE KEY BLOCK-----'), 'private-key');
  assert.equal(findSecret('-----BEGIN CERTIFICATE-----'), 'private-key');
  assert.equal(findSecret('-----BEGIN'), 'private-key');
});

test('findSecret misses Korean prose that mentions API keys and tokens', () => {
  assert.equal(findSecret('API 키와 토큰은 여기에 적지 마세요. ㅋㅋㅋ'), null);
  assert.equal(findSecret('디스코드 토큰을 붙여넣으면 카드를 만들지 않습니다.'), null);
});

test('findSecret misses short or unrelated assignments', () => {
  assert.equal(findSecret('key=short'), null);
  assert.equal(findSecret('monkey=short'), null);
  assert.equal(findSecret('disk-usage is high today'), null);
  assert.equal(findSecret('AKIA1234'), null);
  assert.equal(findSecret('ghp_short'), null);
});

test('findSecret returns null for non-string input', () => {
  assert.equal(findSecret(null), null);
  assert.equal(findSecret(undefined), null);
  assert.equal(findSecret(42), null);
});
