import test from 'node:test';
import assert from 'node:assert/strict';

import { cutGraphemes } from '../src/card/text.mjs';

const loneSurrogate =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('cutGraphemes returns text unchanged when it already fits', () => {
  assert.equal(cutGraphemes('가나다', 3, '…'), '가나다');
  assert.equal(cutGraphemes('👍👍', 4, '…'), '👍👍');
});

test('cutGraphemes cuts Hangul on a syllable boundary and appends the suffix', () => {
  const result = cutGraphemes('가나다라마바사', 5, '…');
  assert.equal(result, '가나다라…');
  assert.equal(result.length, 5);
});

test('cutGraphemes never splits an emoji or a surrogate pair', () => {
  const result = cutGraphemes('👍👍👍', 5, '…');
  assert.equal(result, '👍👍…');
  assert.equal(result.length, 5);
  assert.equal(loneSurrogate.test(result), false);
});

test('cutGraphemes keeps a ZWJ family emoji whole or drops it entirely', () => {
  const family = '👨‍👩‍👧‍👦';
  const result = cutGraphemes(`${family}${family}`, 12, '…');
  assert.equal(result, `${family}…`);
  assert.equal(loneSurrogate.test(result), false);
});

test('cutGraphemes handles a suffix that does not fit maxChars', () => {
  assert.equal(cutGraphemes('가나다', 1, '…'), '…');
  assert.equal(cutGraphemes('가나다', 0, '…'), '');
  assert.equal(cutGraphemes('가나다', 2, '…(잘림)'), '…(');
});

test('cutGraphemes result length never exceeds maxChars', () => {
  const text = `${'가'.repeat(50)}👍${'나'.repeat(50)}`;
  for (let maxChars = 0; maxChars <= 120; maxChars += 7) {
    for (const suffix of ['', '…', '…(잘림)']) {
      const result = cutGraphemes(text, maxChars, suffix);
      assert.ok(result.length <= maxChars, `${maxChars}/${suffix}`);
      assert.equal(loneSurrogate.test(result), false);
    }
  }
});

test('cutGraphemes rejects invalid arguments', () => {
  assert.throws(() => cutGraphemes('가', -1, '…'), RangeError);
  assert.throws(() => cutGraphemes('가', 1.5, '…'), RangeError);
  assert.throws(() => cutGraphemes(null, 1, '…'), TypeError);
  assert.throws(() => cutGraphemes('가', 1, null), TypeError);
});
