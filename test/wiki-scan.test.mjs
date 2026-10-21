import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, linkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertOutOutsideRoot,
  hashEntries,
  hashTree,
  manifestsEqual,
  rankCandidates,
  scanWiki,
} from '../src/wiki/scan.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'memento.mjs');
const FIXTURE_ROOT = join(ROOT, 'test', 'fixtures', 'wiki-broken');
const tempDirs = [];

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'memento-wiki-'));
  tempDirs.push(directory);
  return directory;
}

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, SENPI_CODING_AGENT_DIR: tempDir() },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function entry(path, extra = {}) {
  return {
    path,
    folder: path.startsWith('knowledge/') ? 'knowledge' : 'drafts',
    title: path,
    summary: path,
    status: 'candidate',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

after(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('Test_RankCandidates orders lesson first, then knowledge, then newest, then path', () => {
  const ranked = rankCandidates([
    entry('drafts/lesson-draft.md', { status: 'lesson', updated_at: '2020-01-01T00:00:00.000Z' }),
    entry('drafts/new-draft.md', { updated_at: '2026-12-01T00:00:00.000Z' }),
    entry('knowledge/b-old.md', { updated_at: '2026-02-01T00:00:00.000Z' }),
    entry('knowledge/a-new.md', { updated_at: '2026-03-01T00:00:00.000Z' }),
    entry('knowledge/c-created.md', { updated_at: undefined, created_at: '2026-04-01T00:00:00.000Z' }),
    entry('knowledge/b-old.md', { updated_at: '2026-02-01T00:00:00.000Z' }),
  ]);
  assert.deepEqual(ranked.map(row => row.path), [
    'drafts/lesson-draft.md',
    'knowledge/c-created.md',
    'knowledge/a-new.md',
    'knowledge/b-old.md',
    'knowledge/b-old.md',
    'drafts/new-draft.md',
  ]);
});

test('Test_RankCandidates caps rows at 50 and drops nothing silently before the cap', () => {
  const many = Array.from({ length: 60 }, (_, index) => entry(
    `knowledge/general/note-${String(index).padStart(2, '0')}.md`,
    { updated_at: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z` },
  ));
  const ranked = rankCandidates(many);
  assert.equal(ranked.length, 50);
  assert.equal(new Set(ranked.map(row => row.path)).size, 50);
  assert.equal(rankCandidates(many, 3).length, 3);
});

test('Test_HashTree hashes every fixture file and reports complete coverage', () => {
  const manifest = hashTree(FIXTURE_ROOT);
  const paths = Object.keys(manifest.files);
  assert.equal(paths.length, 19);
  assert.equal(manifest.coverage.total, 19);
  assert.equal(manifest.coverage.hashed, 19);
  assert.deepEqual(manifest.coverage.unreadable, []);
  assert.equal(paths.includes('knowledge/general/notes.txt'), true);
  assert.equal(paths.includes('drafts/sub/draft-deep.md'), true);
  assert.equal(paths.includes('note.md'), true);

  const expected = createHash('sha256').update(readFileSync(join(FIXTURE_ROOT, 'note.md'))).digest('hex');
  assert.equal(manifest.files['note.md'], expected);
  assert.equal(manifestsEqual(manifest, hashTree(FIXTURE_ROOT)), true);
});

test('Test_HashEntries reports unreadable files instead of claiming a full hash', () => {
  const result = hashEntries([
    { rel: 'ok.md', abs: 'ok.md' },
    { rel: 'locked.md', abs: 'locked.md' },
  ], path => {
    if (path === 'locked.md') throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return Buffer.from('ok', 'utf8');
  });
  assert.equal(result.coverage.total, 2);
  assert.equal(result.coverage.hashed, 1);
  assert.deepEqual(result.coverage.unreadable, [{ path: 'locked.md', code: 'EPERM' }]);
  assert.equal(Object.keys(result.files).length, 1);
});

test('Test_ManifestsEqual compares key by key', () => {
  const before = { files: { a: '1', b: '2' } };
  assert.equal(manifestsEqual(before, { files: { a: '1', b: '2' } }), true);
  assert.equal(manifestsEqual(before, { files: { a: '1', b: '3' } }), false);
  assert.equal(manifestsEqual(before, { files: { a: '1' } }), false);
  assert.equal(manifestsEqual(before, { files: { a: '1', b: '2', c: '3' } }), false);
});

test('Test_AssertOutOutsideRoot refuses a directory nested inside the wiki', () => {
  assert.throws(() => assertOutOutsideRoot(FIXTURE_ROOT, join(FIXTURE_ROOT, 'evidence')), error => error.code === 'OUT_INSIDE_ROOT');
  assert.throws(() => assertOutOutsideRoot(FIXTURE_ROOT, FIXTURE_ROOT), error => error.code === 'OUT_INSIDE_ROOT');
  assert.throws(() => assertOutOutsideRoot(FIXTURE_ROOT, join(FIXTURE_ROOT, '..', 'wiki-broken', 'out')), error => error.code === 'OUT_INSIDE_ROOT');
  assert.doesNotThrow(() => assertOutOutsideRoot(FIXTURE_ROOT, join(tempDir(), 'out')));
});

test('Test_Cli_wiki_scan writes manifests and candidate tables outside the wiki', () => {
  const out = join(tempDir(), 'scan-out');
  const fixtureBefore = hashTree(FIXTURE_ROOT);

  const result = runCli(['wiki-scan', '--root', FIXTURE_ROOT, '--out', out]);

  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.stdout.includes('wiki-scan: stable true'), true, result.stdout);
  assert.equal(result.stdout.includes('rows 8'), true, result.stdout);
  assert.equal(result.stdout.includes('knowledge/general/bad-replacement.md'), true, result.stdout);

  const before = readJson(join(out, 'wiki-hash-before.json'));
  const after = readJson(join(out, 'wiki-hash-after.json'));
  const candidates = readJson(join(out, 'wiki-candidates.json'));
  const counts = readJson(join(out, 'wiki-counts.json'));
  assert.deepEqual(counts, { files: 19, scanned: 16, pool: 13, excludedBroken: 6, rows: 8 });
  assert.equal(manifestsEqual(before, after), true);
  assert.equal(before.coverage.total, 19);
  assert.equal(candidates.rows.length, 8);
  assert.equal(candidates.excludedBroken.length, 6);
  assert.equal(readFileSync(join(out, 'wiki-candidates.md'), 'utf8').includes('knowledge/general/ok-mixed.md'), true);

  assert.equal(manifestsEqual(fixtureBefore, hashTree(FIXTURE_ROOT)), true);
  assert.throws(() => statSync(join(FIXTURE_ROOT, 'wiki-counts.json')), error => error.code === 'ENOENT');
});

test('Test_Cli_wiki_scan refuses an output directory inside the wiki before writing', () => {
  const out = join(FIXTURE_ROOT, 'scan-out');
  const fixtureBefore = hashTree(FIXTURE_ROOT);

  const result = runCli(['wiki-scan', '--root', FIXTURE_ROOT, '--out', out]);

  assert.equal(result.status, 2, JSON.stringify(result));
  assert.equal(`${result.stdout}${result.stderr}`.includes('outside the wiki root'), true);
  assert.throws(() => statSync(out), error => error.code === 'ENOENT');
  assert.equal(manifestsEqual(fixtureBefore, hashTree(FIXTURE_ROOT)), true);
});

test('Test_Cli_wiki_scan rejects missing options and a missing root', () => {
  const noRoot = runCli(['wiki-scan', '--out', join(tempDir(), 'out')]);
  assert.equal(noRoot.status, 2);
  assert.equal(noRoot.stderr.includes('--root'), true);

  const noOut = runCli(['wiki-scan', '--root', FIXTURE_ROOT]);
  assert.equal(noOut.status, 2);
  assert.equal(noOut.stderr.includes('--out'), true);

  const missingRoot = runCli(['wiki-scan', '--root', join(tempDir(), 'absent'), '--out', join(tempDir(), 'out')]);
  assert.equal(missingRoot.status, 2);
  assert.equal(`${missingRoot.stdout}${missingRoot.stderr}`.includes('absent'), true);
});

test('Test_Cli_help_lists_wiki_scan_and_keeps_doctor_parse_behavior', () => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.equal(help.stdout.includes('wiki-scan'), true);
  assert.equal(help.stdout.includes('--root'), true);
  assert.equal(help.stdout.includes('--out'), true);

  const parse = runCli(['doctor', '--parse', join(ROOT, 'test', 'fixtures', 'invalid', 'cp949.md')]);
  assert.equal(parse.status, 2);
  assert.equal(parse.stdout.trim(), 'unreadable: utf8');
});

test('Test_ScanWiki keeps every root file hashed even when not a candidate', () => {
  const result = scanWiki(FIXTURE_ROOT);
  assert.equal(result.hashes.coverage.total, 19);
  assert.equal(result.hashes.files['drafts/sub/draft-deep.md'] !== undefined, true);
  assert.equal(result.rows.some(row => row.path === 'drafts/sub/draft-deep.md'), false);
  assert.equal(result.rows.some(row => row.path === 'note.md'), false);
  assert.equal(result.excludedBroken.some(row => row.path.endsWith('draft-deep.md')), false);
});

test('Test_Cli_wiki_scan_is_repeatable', () => {
  const one = join(tempDir(), 'one');
  const two = join(tempDir(), 'two');
  assert.equal(runCli(['wiki-scan', '--root', FIXTURE_ROOT, '--out', one]).status, 0);
  assert.equal(runCli(['wiki-scan', '--root', FIXTURE_ROOT, '--out', two]).status, 0);
  for (const name of ['wiki-candidates.json', 'wiki-candidates.md', 'wiki-counts.json', 'wiki-hash-before.json']) {
    assert.equal(readFileSync(join(one, name), 'utf8'), readFileSync(join(two, name), 'utf8'), name);
  }
});

const OUTPUT_NAMES = [
  'wiki-hash-before.json',
  'wiki-hash-after.json',
  'wiki-candidates.json',
  'wiki-candidates.md',
  'wiki-counts.json',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeWikiNote(wiki, rel, frontmatter, body) {
  const target = join(wiki, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `---\n${frontmatter}\n---\n${body}\n`);
}

test('Test_Cli_wiki_scan_refuses_existing_or_linked_output_files', () => {
  for (const name of OUTPUT_NAMES) {
    for (const kind of ['symlink', 'hardlink', 'regular']) {
      const wiki = tempDir();
      const out = tempDir();
      writeWikiNote(wiki, 'knowledge/general/owner-note.md', 'title: "owner"\nstatus: candidate\nsource: manual', '원본 바이트');
      const note = join(wiki, 'knowledge', 'general', 'owner-note.md');
      const original = sha256(readFileSync(note));
      const target = join(out, name);
      if (kind === 'symlink') symlinkSync(note, target, 'file');
      else if (kind === 'hardlink') linkSync(note, target);
      else writeFileSync(target, 'existing output bytes\n');
      const label = `${name} ${kind}`;

      const result = runCli(['wiki-scan', '--root', wiki, '--out', out]);

      assert.equal(result.status, 2, `${label}: ${JSON.stringify(result)}`);
      assert.equal(`${result.stdout}${result.stderr}`.includes('refusing to overwrite'), true, label);
      assert.equal(sha256(readFileSync(note)), original, `${label} must not change the wiki note`);
      assert.deepEqual(readdirSync(out), [name], `${label} must not add any output file`);
      if (kind === 'regular') assert.equal(readFileSync(target, 'utf8'), 'existing output bytes\n', label);
    }
  }

  const wiki = tempDir();
  writeWikiNote(wiki, 'knowledge/general/owner-note.md', 'title: "owner"\nstatus: candidate\nsource: manual', '원본');
  const out = tempDir();
  assert.equal(runCli(['wiki-scan', '--root', wiki, '--out', out]).status, 0);
  const rerun = runCli(['wiki-scan', '--root', wiki, '--out', out]);
  assert.equal(rerun.status, 2, JSON.stringify(rerun));
  assert.equal(`${rerun.stdout}${rerun.stderr}`.includes('refusing to overwrite'), true);
});

test('Test_Cli_wiki_scan_orders_undated_candidates_by_path', () => {
  const wiki = tempDir();
  writeWikiNote(wiki, 'knowledge/a.md', 'title: "a"\nstatus: candidate\nsource: manual', 'a');
  writeWikiNote(wiki, 'knowledge/a/z.md', 'title: "z"\nstatus: candidate\nsource: manual', 'z');
  writeWikiNote(wiki, 'knowledge/b.md', 'title: "b"\nstatus: candidate\nsource: manual', 'b');
  writeWikiNote(wiki, 'knowledge/c.md', 'title: "c"\nstatus: candidate\nsource: manual\nupdated_at: "not-a-date"\ncreated_at: "nope"', 'c');
  writeWikiNote(wiki, 'knowledge/d.md', 'title: "d"\nstatus: candidate\nsource: manual\nupdated_at: "2026-01-01T00:00:00.000Z"', 'd');
  writeWikiNote(wiki, 'knowledge/e.md', 'title: "e"\nstatus: lesson\nsource: manual', 'e');
  const out = tempDir();

  const result = runCli(['wiki-scan', '--root', wiki, '--out', out]);

  assert.equal(result.status, 0, JSON.stringify(result));
  assert.deepEqual(readJson(join(out, 'wiki-candidates.json')).rows.map(row => row.path), [
    'knowledge/e.md',
    'knowledge/d.md',
    'knowledge/a.md',
    'knowledge/a/z.md',
    'knowledge/b.md',
    'knowledge/c.md',
  ]);
  assert.deepEqual(rankCandidates([
    entry('knowledge/a/z.md', { updated_at: undefined, created_at: undefined }),
    entry('knowledge/a.md', { updated_at: undefined, created_at: undefined }),
  ]).map(row => row.path), ['knowledge/a.md', 'knowledge/a/z.md']);
  assert.deepEqual(rankCandidates([
    entry('knowledge/z.md', { updated_at: 'not-a-date', created_at: 'nope' }),
    entry('knowledge/a.md', { updated_at: undefined, created_at: undefined }),
  ]).map(row => row.path), ['knowledge/a.md', 'knowledge/z.md']);
  assert.deepEqual(rankCandidates([
    entry('knowledge/z.md', { updated_at: '2026-01-01T00:00:00.000Z' }),
    entry('knowledge/a.md', { updated_at: '2026-01-01T00:00:00.000Z' }),
  ]).map(row => row.path), ['knowledge/a.md', 'knowledge/z.md']);
});

test('Test_Cli_wiki_scan_refuses_an_output_directory_linked_into_the_wiki', () => {
  const wiki = tempDir();
  mkdirSync(join(wiki, 'knowledge'), { recursive: true });
  const outLink = join(tempDir(), 'outlink');
  symlinkSync(join(wiki, 'knowledge'), outLink, 'junction');

  const result = runCli(['wiki-scan', '--root', wiki, '--out', outLink]);

  assert.equal(result.status, 2, JSON.stringify(result));
  assert.equal(`${result.stdout}${result.stderr}`.includes('outside the wiki root'), true);
  assert.deepEqual(readdirSync(join(wiki, 'knowledge')), []);
});
