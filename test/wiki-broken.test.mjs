import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  KS_X_1001_SYLLABLE_COUNT,
  KS_X_1001_SYLLABLES,
  brokenReasons,
  decodeStrictUtf8,
  parseFrontmatter,
  scanWiki,
} from '../src/wiki/scan.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_ROOT = join(ROOT, 'test', 'fixtures', 'wiki-broken');

const FRONTMATTER = '---\ntitle: "t"\nstatus: candidate\nsource: manual\n---\n';

function reasonsFor(body, frontmatter = {}) {
  return brokenReasons(`${FRONTMATTER}${body}`, { status: 'candidate', source: 'manual', ...frontmatter });
}

test('Test_KsX1001Set decodes exactly 2350 syllables and knows rare syllables', () => {
  assert.equal(KS_X_1001_SYLLABLE_COUNT, 2350);
  assert.equal(KS_X_1001_SYLLABLES.size, 2350);
  for (const syllable of ['뭐', '지', '몰', '라', '양', '꿍', '한', '글']) {
    assert.equal(KS_X_1001_SYLLABLES.has(syllable), true, syllable);
  }
  for (const syllable of ['쓕', '캻', '몤', '똠']) {
    assert.equal(KS_X_1001_SYLLABLES.has(syllable), false, syllable);
  }
});

test('Test_DecodeStrictUtf8 rejects CP949 bytes and keeps valid UTF-8', () => {
  assert.deepEqual(decodeStrictUtf8(Buffer.from('\uFFFD', 'utf8')), { text: '\uFFFD' });
  const cp949 = Buffer.from([0xb0, 0xa1, 0xb1, 0xdb]);
  const result = decodeStrictUtf8(cp949);
  assert.equal(result.error, 'utf8');
  assert.equal(result.text, undefined);
});

test('Test_ParseFrontmatter reads quoted scalars and leaves the body intact', () => {
  const parsed = parseFrontmatter('---\ntitle: "한글 제목"\nstatus: "candidate"\nsource: manual \n---\n\n본문\n');
  assert.equal(parsed.hasFrontmatter, true);
  assert.equal(parsed.frontmatter.title, '한글 제목');
  assert.equal(parsed.frontmatter.status, 'candidate');
  assert.equal(parsed.frontmatter.source, 'manual');
  assert.equal(parsed.body, '\n본문\n');
});

test('Test_BrokenReasons flags the CP949 adjacency signature', () => {
  assert.deepEqual(reasonsFor('媳쓕캻'), ['adjacency']);
  assert.deepEqual(reasonsFor('?몤씬'), ['adjacency']);
});

test('Test_BrokenReasons flags question runs next to Hangul only', () => {
  assert.deepEqual(reasonsFor('안녕?? 거기 있니'), ['question-run']);
  assert.deepEqual(reasonsFor('뭐지?몰라'), []);
  assert.deepEqual(reasonsFor('똠양꿍?'), []);
  assert.deepEqual(reasonsFor('plain English ?? here'), []);
});

test('Test_BrokenReasons flags U+FFFD anywhere', () => {
  assert.deepEqual(reasonsFor('손상된 \uFFFD 글자'), ['replacement-char']);
});

test('Test_BrokenReasons flags three CJK ideographs mixed with Hangul', () => {
  assert.deepEqual(reasonsFor('漢字文 한글 본문'), ['cjk-mixed']);
  assert.deepEqual(reasonsFor('漢字 한글'), []);
  assert.deepEqual(reasonsFor('漢字文 only ideographs'), []);
});

test('Test_BrokenReasons exempts zh and ja notes from the CJK rule', () => {
  assert.deepEqual(reasonsFor('漢字文 한글 설명', { lang: 'zh' }), []);
  assert.deepEqual(reasonsFor('漢字文 한글 설명', { lang: 'ja' }), []);
  assert.deepEqual(reasonsFor('漢字文 한글 설명', { lang: 'en' }), ['cjk-mixed']);
});

test('Test_BrokenReasons keeps ordinary Korean and mixed English notes clean', () => {
  assert.deepEqual(reasonsFor('# 한글 노트\n\nThis note mixes 한국어 and English text.'), []);
});

test('Test_ScanWiki classifies the synthetic wiki fixture exactly', () => {
  const result = scanWiki(FIXTURE_ROOT);

  assert.deepEqual(result.counts, { files: 19, scanned: 16, pool: 13, excludedBroken: 6, rows: 8 });

  assert.deepEqual(result.rows.map(row => row.path), [
    'knowledge/general/ok-mixed.md',
    'knowledge/general/ok-nfd.md',
    'knowledge/general/ok-plain.md',
    'knowledge/general/ok-question.md',
    'knowledge/general/ok-rare-question.md',
    'knowledge/general/ok-zh.md',
    'knowledge/projects/nested/ok-nested.md',
    'drafts/draft-candidate.md',
  ]);
  assert.deepEqual(result.rows.map(row => row.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(result.rows.map(row => row.folder), [
    'knowledge', 'knowledge', 'knowledge', 'knowledge', 'knowledge', 'knowledge', 'knowledge', 'drafts',
  ]);
  assert.equal(result.rows[0].status, 'lesson');
  assert.equal(result.rows[1].summary, '한글 요약 첫 문장입니다.');
  assert.equal(result.rows[1].updated_at, '2026-05-05T00:00:00.000Z');

  const excluded = new Map(result.excludedBroken.map(entry => [entry.path, entry.reasons]));
  assert.deepEqual([...excluded.keys()].sort(), [
    'drafts/draft-broken.md',
    'knowledge/general/bad-cjk.md',
    'knowledge/general/bad-mojibake.md',
    'knowledge/general/bad-question-run.md',
    'knowledge/general/bad-replacement.md',
    'knowledge/general/bad-utf8.md',
  ]);
  assert.deepEqual(excluded.get('knowledge/general/bad-mojibake.md'), ['adjacency']);
  assert.deepEqual(excluded.get('knowledge/general/bad-question-run.md'), ['question-run']);
  assert.deepEqual(excluded.get('knowledge/general/bad-replacement.md'), ['replacement-char']);
  assert.deepEqual(excluded.get('knowledge/general/bad-cjk.md'), ['cjk-mixed']);
  assert.deepEqual(excluded.get('knowledge/general/bad-utf8.md'), ['utf8']);
  assert.deepEqual(excluded.get('drafts/draft-broken.md'), ['replacement-char']);

  for (const row of result.rows) {
    assert.equal(row.path.includes('\\'), false, row.path);
    assert.equal(typeof row.title, 'string');
    assert.equal(typeof row.summary, 'string');
  }
});
