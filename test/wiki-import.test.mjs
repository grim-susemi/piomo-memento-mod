import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { initRepo } from '../src/store/init.mjs';
import { openStore } from '../src/store/store.mjs';
import { hashTree, manifestsEqual, scanWiki } from '../src/wiki/scan.mjs';
import { importPickedRows, WikiImportError } from '../src/wiki/import.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'memento.mjs');

const tempDirs = [];
after(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

let idCounter = 0;
function testStoreOptions() {
  return {
    sleep: async () => {},
    lockWaitMs: 200,
    now: () => Date.parse('2026-10-22T00:00:00.000Z') + (idCounter += 1) * 1000,
    rand: (size) => Buffer.alloc(size, (idCounter % 250) + 1),
  };
}

async function setupStore() {
  const parent = tempDir('memento-import-repo-');
  const directory = join(parent, 'memento');
  const init = await initRepo({ dir: directory });
  assert.equal(init.ok, true);
  return { directory, store: openStore(directory, testStoreOptions()) };
}

function note(frontmatter, body) {
  return `---\n${frontmatter}\n---\n${body}`;
}

function fiveRowWiki() {
  const root = tempDir('memento-import-wiki-');
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'drafts'), { recursive: true });
  const longBody = `${'가'.repeat(1998)}👍${'나'.repeat(600)}`;
  writeFileSync(join(root, 'knowledge', 'alpha.md'), note(
    'title: 알파 아이디어\nsource: manual\nstatus: candidate\nupdated_at: 2026-03-01T00:00:00.000Z\nsummary: 알파 요약 첫 줄입니다\n둘째 줄은 설명에 안 들어갑니다',
    '알파 원문 첫 줄\n알파 원문 둘째 줄 ㅋㅋㅋ',
  ));
  writeFileSync(join(root, 'knowledge', 'beta.md'), note(
    'title: 베타 레슨\nsource: manual\nstatus: lesson\nupdated_at: 2026-01-05T00:00:00.000Z\nsummary: 베타 요약',
    '베타 원문 👍',
  ));
  writeFileSync(join(root, 'drafts', 'gamma.md'), note(
    'title: 감마 메모\nstatus: candidate\nupdated_at: 2026-04-01T00:00:00.000Z\nsummary: 감마 요약',
    '감마 원문',
  ));
  writeFileSync(join(root, 'knowledge', 'secret.md'), note(
    'title: 비밀 메모\nsource: manual\nstatus: candidate\nupdated_at: 2026-05-01T00:00:00.000Z\nsummary: 비밀 요약',
    '이 줄에는 sk-abcdefghijklmnopqrstuvwxyz 키가 있다',
  ));
  writeFileSync(join(root, 'drafts', 'long.md'), note(
    'title: 긴 메모\nstatus: candidate\nupdated_at: 2026-06-01T00:00:00.000Z\nsummary: 긴 요약',
    longBody,
  ));
  return root;
}

function wikiBytes(root) {
  const tree = hashTree(root);
  const snapshot = new Map();
  for (const path of Object.keys(tree.files)) {
    snapshot.set(path, readFileSync(join(root, path)));
  }
  return snapshot;
}

function assertWikiUntouched(root, before) {
  for (const [path, bytes] of before) {
    assert.deepEqual(readFileSync(join(root, path)), bytes, `wiki file changed: ${path}`);
  }
  assert.equal(Object.keys(hashTree(root).files).length, before.size, 'no files added under wiki root');
}

function rowByTitle(rows, title) {
  const row = rows.find((entry) => entry.title === title);
  assert.ok(row, `row missing: ${title}`);
  return row;
}

test('Test_WikiImport creates exactly the picked rows as idea cards', async () => {
  const root = fiveRowWiki();
  const { store } = await setupStore();
  const before = hashTree(root);
  const { rows } = scanWiki(root);
  assert.equal(rows.length, 5);
  const wanted = [rows[0].n, rows[2].n];
  const result = await importPickedRows({
    store,
    root,
    rows,
    pick: wanted.join(','),
    beforeHashes: before,
  });
  assert.equal(result.ok, true);
  assert.equal(result.created.length, 2);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(result.hashesEqual, true);
  const listed = await store.list();
  assert.equal(listed.cards.length, 2);
  for (const entry of result.created) {
    const card = listed.cards.find((candidate) => candidate.id === entry.id);
    assert.ok(card, `card missing: ${entry.id}`);
    const row = rows.find((candidate) => candidate.n === entry.n);
    assert.equal(card.source, 'old-wiki');
    assert.equal(card.status, 'idea');
    assert.equal(card.sourceRef, entry.sourceRef);
    assert.equal(card.sourceRef, realpathSync(join(root, row.path)));
    assert.equal(card.title, row.title);
    assert.ok(!card.original.includes('---'), 'frontmatter must be removed from original');
    assert.equal(card.log[0].via, 'old-wiki');
  }
  assertWikiUntouched(root, wikiBytes(root));
});

test('Test_WikiImport second run creates nothing and reports already-imported', async () => {
  const root = fiveRowWiki();
  const { store } = await setupStore();
  const { rows } = scanWiki(root);
  const first = await importPickedRows({ store, root, rows, pick: '1,3' });
  assert.equal(first.created.length, 2);
  const before = wikiBytes(root);
  const second = await importPickedRows({ store, root, rows, pick: '3,1' });
  assert.equal(second.ok, true);
  assert.equal(second.created.length, 0);
  assert.equal(second.failed.length, 0);
  assert.equal(second.skipped.length, 2);
  for (const entry of second.skipped) {
    assert.equal(entry.reason, 'already-imported');
    assert.ok(typeof entry.id === 'string');
  }
  const listed = await store.list();
  assert.equal(listed.cards.length, 2);
  assertWikiUntouched(root, before);
});

test('Test_WikiImport unknown and malformed picks throw before writing', async () => {
  const root = fiveRowWiki();
  const { store } = await setupStore();
  const { rows } = scanWiki(root);
  await assert.rejects(
    importPickedRows({ store, root, rows, pick: '99' }),
    (error) => error instanceof WikiImportError
      && error.code === 'BAD_PICK'
      && error.message.includes('row 99 not in candidates'),
  );
  await assert.rejects(
    importPickedRows({ store, root, rows, pick: 'x' }),
    (error) => error instanceof WikiImportError && error.code === 'BAD_PICK',
  );
  const before = hashTree(root);
  const listed = await store.list();
  assert.equal(listed.cards.length, 0);
  assert.equal(manifestsEqual(before, hashTree(root)), true);
});

test('Test_WikiImport skips a secret row and reports the pattern only', async () => {
  const root = fiveRowWiki();
  const { store } = await setupStore();
  const { rows } = scanWiki(root);
  const secret = rowByTitle(rows, '비밀 메모');
  const result = await importPickedRows({ store, root, rows, pick: String(secret.n) });
  assert.equal(result.ok, true);
  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'secret');
  assert.equal(result.skipped[0].pattern, 'sk-key');
  const listed = await store.list();
  assert.equal(listed.cards.length, 0);
});

test('Test_WikiImport cuts description to first line and 120 chars, original to 2000', async () => {
  const root = fiveRowWiki();
  const { store } = await setupStore();
  const { rows } = scanWiki(root);
  const alpha = rowByTitle(rows, '알파 아이디어');
  const long = rowByTitle(rows, '긴 메모');
  const multiLine = [
    { n: 1, path: alpha.path, folder: alpha.folder, title: alpha.title, summary: '알파 요약 첫 줄입니다\n둘째 줄은 설명에 안 들어갑니다', status: 'candidate', updated_at: '' },
    { n: 2, path: long.path, folder: long.folder, title: long.title, summary: long.summary, status: 'candidate', updated_at: '' },
  ];
  const result = await importPickedRows({ store, root, rows: multiLine, pick: '1,2' });
  assert.equal(result.created.length, 2);
  const listed = await store.list();
  const alphaCard = listed.cards.find((card) => card.title === '알파 아이디어');
  assert.equal(alphaCard.description, '알파 요약 첫 줄입니다');
  const longCard = listed.cards.find((card) => card.title === '긴 메모');
  assert.equal([...longCard.original].length, 2000);
  assert.equal([...longCard.description].length <= 120, true);
});

test('Test_WikiImport never follows symlinks or parent escapes outside the root', async () => {
  const outside = tempDir('memento-import-outside-');
  const secret = join(outside, 'outside.md');
  writeFileSync(secret, 'outside content');
  const root = tempDir('memento-import-wiki-');
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  const realDir = join(outside, 'realdir');
  mkdirSync(realDir, { recursive: true });
  writeFileSync(join(realDir, 'note.md'), 'linked body');
  const outsideBase = outside.split(/[\\/]/).pop();
  const rows = [
    { n: 2, path: `../${outsideBase}/outside.md`, folder: 'knowledge', title: '탈출', summary: '요약', status: 'candidate', updated_at: '' },
  ];
  let linkRow = null;
  for (const type of ['junction', 'file']) {
    try {
      const target = type === 'junction' ? realDir : secret;
      const link = join(root, 'knowledge', type === 'junction' ? 'jdir' : 'link.md');
      symlinkSync(target, link, type);
      linkRow = { n: 1, path: type === 'junction' ? 'knowledge/jdir/note.md' : 'knowledge/link.md', folder: 'knowledge', title: '링크', summary: '요약', status: 'candidate', updated_at: '' };
      break;
    } catch {
      continue;
    }
  }
  if (linkRow) rows.unshift(linkRow);
  const { store } = await setupStore();
  const result = await importPickedRows({ store, root, rows, pick: rows.map((row) => row.n).join(',') });
  assert.equal(result.created.length, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(result.skipped.length, rows.length);
  for (const entry of result.skipped) {
    assert.equal(entry.reason, 'symlink-or-escape');
  }
  assert.equal(readFileSync(secret, 'utf8'), 'outside content');
  const listed = await store.list();
  assert.equal(listed.cards.length, 0);
});

test('Test_WikiImportCli happy path creates cards and reruns clean, bad pick exits 2', async () => {
  const root = fiveRowWiki();
  const { rows, counts } = scanWiki(root);
  const outDir = tempDir('memento-import-out-');
  const candidatesFile = join(outDir, 'wiki-candidates.json');
  writeFileSync(candidatesFile, JSON.stringify({ schema: 'memento.wiki-candidates.v1', root, counts, rows }, null, 2));
  writeFileSync(join(outDir, 'wiki-hash-before.json'), JSON.stringify(hashTree(root), null, 2));
  const agentDir = tempDir('memento-import-agent-');
  const repoParent = tempDir('memento-import-cli-repo-');
  const repoDir = join(repoParent, 'memento');
  const repoInit = await initRepo({ dir: repoDir });
  assert.equal(repoInit.ok, true);
  mkdirSync(join(agentDir, 'memento'), { recursive: true });
  writeFileSync(join(agentDir, 'memento', 'config.json'), JSON.stringify({
    repoPath: repoDir,
    tokenFile: join(agentDir, 'memento', 'token'),
    remote: null,
  }));
  const env = { ...process.env, SENPI_CODING_AGENT_DIR: agentDir };
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120_000, env });
  const picked = [rows[0].n, rows[2].n].join(',');
  const happy = run(['wiki-import', '--candidates', candidatesFile, '--pick', picked, '--root', root]);
  assert.equal(happy.status, 0, happy.stderr);
  assert.match(happy.stdout, /created 2/);
  const again = run(['wiki-import', '--candidates', candidatesFile, '--pick', picked, '--root', root]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /created 0/);
  const bad = run(['wiki-import', '--candidates', candidatesFile, '--pick', '99', '--root', root]);
  assert.equal(bad.status, 2);
  assert.match(bad.stdout + bad.stderr, /row 99 not in candidates/);
});

function configuredAgent(repoDir) {
  const agentDir = tempDir('memento-import-agent-');
  mkdirSync(join(agentDir, 'memento'), { recursive: true });
  writeFileSync(join(agentDir, 'memento', 'config.json'), JSON.stringify({
    repoPath: repoDir,
    tokenFile: join(agentDir, 'memento', 'token'),
    remote: null,
  }));
  return { ...process.env, SENPI_CODING_AGENT_DIR: agentDir };
}

function scannedCandidates(root, outPrefix) {
  const { rows, counts } = scanWiki(root);
  const outDir = tempDir(outPrefix);
  const candidatesFile = join(outDir, 'wiki-candidates.json');
  writeFileSync(candidatesFile, JSON.stringify({ schema: 'memento.wiki-candidates.v1', root, counts, rows }, null, 2));
  writeFileSync(join(outDir, 'wiki-hash-before.json'), JSON.stringify(hashTree(root), null, 2));
  return { outDir, candidatesFile, rows };
}

function cardFiles(repoDir) {
  return readdirSync(join(repoDir, 'cards')).filter((name) => name.endsWith('.md'));
}

test('Test_WikiImport refuses a data repo equal to or inside the wiki root', async () => {
  const root = tempDir('memento-import-colloc-');
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'solo.md'), note(
    'title: 솔로\nsource: manual\nstatus: candidate\nupdated_at: 2026-02-01T00:00:00.000Z\nsummary: 솔로 요약',
    '솔로 원문',
  ));
  const repoDir = join(root, 'data');
  assert.equal((await initRepo({ dir: repoDir })).ok, true);
  const store = openStore(repoDir, testStoreOptions());
  const { rows } = scanWiki(root);
  assert.equal(rows.length, 1);
  const nested = [repoDir, join(root, 'sub', '..', 'data')];
  for (const candidate of nested) {
    await assert.rejects(
      importPickedRows({ store, root, rows, pick: '1', repoDir: candidate, beforeHashes: hashTree(root) }),
      (error) => error instanceof WikiImportError
        && error.code === 'REPO_INSIDE_WIKI'
        && error.message.includes('data repo must be outside the wiki root'),
    );
  }
  let aliasRoot = null;
  try {
    aliasRoot = join(tempDir('memento-import-alias-'), 'wiki-link');
    symlinkSync(root, aliasRoot, 'junction');
  } catch {
    aliasRoot = null;
  }
  if (aliasRoot) {
    await assert.rejects(
      importPickedRows({ store, root: aliasRoot, rows, pick: '1', repoDir, beforeHashes: hashTree(root) }),
      (error) => error instanceof WikiImportError && error.code === 'REPO_INSIDE_WIKI',
    );
  }
  assert.deepEqual(cardFiles(repoDir), []);
  const listed = await store.list();
  assert.equal(listed.cards.length, 0);
  const { candidatesFile } = scannedCandidates(root, 'memento-import-colloc-out-');
  const env = configuredAgent(repoDir);
  const refused = spawnSync(process.execPath,
    [CLI, 'wiki-import', '--candidates', candidatesFile, '--pick', '1', '--root', root],
    { encoding: 'utf8', timeout: 120_000, env });
  assert.equal(refused.status, 2);
  assert.match(refused.stdout + refused.stderr, /data repo must be outside the wiki root/);
  assert.deepEqual(cardFiles(repoDir), []);
});

test('Test_WikiImport skips secret-shaped titles and descriptions with pattern only', async () => {
  const value = `ghp_${'A'.repeat(30)}`;
  const root = tempDir('memento-import-meta-secret-');
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'drafts'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'body-secret.md'), note(
    'title: 본문 비밀\nsource: manual\nstatus: candidate\nupdated_at: 2026-02-01T00:00:00.000Z\nsummary: 본문 요약',
    `앞부분 ${value} 뒷부분`,
  ));
  writeFileSync(join(root, 'knowledge', 'summary-secret.md'), note(
    `title: 요약 비밀\nsource: manual\nstatus: candidate\nupdated_at: 2026-03-01T00:00:00.000Z\nsummary: 요약에 ${value} 포함`,
    '깨끗한 본문',
  ));
  writeFileSync(join(root, 'drafts', 'title-secret.md'), note(
    `title: 제목에 ${value} 포함\nstatus: candidate\nupdated_at: 2026-04-01T00:00:00.000Z\nsummary: 제목 요약`,
    '깨끗한 본문 둘',
  ));
  const secretRows = scanWiki(root).rows;
  assert.equal(secretRows.length, 3);
  const outDir = tempDir('memento-import-meta-out-');
  const candidatesFile = join(outDir, 'wiki-candidates.json');
  writeFileSync(candidatesFile, JSON.stringify({ schema: 'memento.wiki-candidates.v1', root, rows: secretRows }, null, 2));
  writeFileSync(join(outDir, 'wiki-hash-before.json'), JSON.stringify(hashTree(root), null, 2));
  const repoDir = join(tempDir('memento-import-meta-repo-'), 'memento');
  assert.equal((await initRepo({ dir: repoDir })).ok, true);
  const env = configuredAgent(repoDir);
  const result = spawnSync(process.execPath,
    [CLI, 'wiki-import', '--candidates', candidatesFile, '--pick', '1,2,3', '--root', root],
    { encoding: 'utf8', timeout: 120_000, env });
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout + result.stderr;
  assert.match(output, /skipped: row 1 secret \(github-token\)/);
  assert.match(output, /skipped: row 2 secret \(github-token\)/);
  assert.match(output, /skipped: row 3 secret \(github-token\)/);
  assert.match(output, /created 0/);
  assert.equal(output.includes(value), false);
  assert.deepEqual(cardFiles(repoDir), []);
});

test('Test_WikiImport refuses a missing or unreadable scan before-manifest', async () => {
  const root = tempDir('memento-import-nobase-');
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'solo.md'), note(
    'title: 솔로\nsource: manual\nstatus: candidate\nupdated_at: 2026-02-01T00:00:00.000Z\nsummary: 솔로 요약',
    '솔로 원문',
  ));
  const { outDir, candidatesFile } = scannedCandidates(root, 'memento-import-nobase-out-');
  const repoDir = join(tempDir('memento-import-nobase-repo-'), 'memento');
  assert.equal((await initRepo({ dir: repoDir })).ok, true);
  const env = configuredAgent(repoDir);
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120_000, env });
  rmSync(join(outDir, 'wiki-hash-before.json'));
  const missing = run(['wiki-import', '--candidates', candidatesFile, '--pick', '1', '--root', root]);
  assert.equal(missing.status, 2);
  assert.match(missing.stdout + missing.stderr, /scan before-manifest/);
  assert.deepEqual(cardFiles(repoDir), []);
  writeFileSync(join(outDir, 'wiki-hash-before.json'), 'not json{{{');
  const corrupt = run(['wiki-import', '--candidates', candidatesFile, '--pick', '1', '--root', root]);
  assert.equal(corrupt.status, 2);
  assert.match(corrupt.stdout + corrupt.stderr, /scan before-manifest/);
  assert.deepEqual(cardFiles(repoDir), []);
});

test('Test_WikiImport secret paths never appear in the stringified result', async () => {
  const first = `ghp_${'A'.repeat(30)}`;
  const second = `ghp_${'B'.repeat(30)}`;
  const root = tempDir('memento-import-secret-return-');
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'drafts'), { recursive: true });
  writeFileSync(join(root, 'knowledge', `${first}.md`), note(
    'title: 첫 파일\nsource: manual\nstatus: candidate\nupdated_at: 2026-02-01T00:00:00.000Z\nsummary: 첫 요약',
    '깨끗한 본문 하나',
  ));
  writeFileSync(join(root, 'drafts', `${second}.md`), note(
    'title: 둘 파일\nstatus: candidate\nupdated_at: 2026-03-01T00:00:00.000Z\nsummary: 둘 요약',
    '깨끗한 본문 둘',
  ));
  const { rows } = scanWiki(root);
  assert.equal(rows.length, 2);
  const before = hashTree(root);
  const { store } = await setupStore();
  const result = await importPickedRows({ store, root, rows, pick: '1,2', beforeHashes: before });
  assert.equal(result.ok, true);
  assert.equal(result.created.length, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(result.skipped.length, 2);
  const text = JSON.stringify(result);
  assert.equal(text.includes(first), false);
  assert.equal(text.includes(second), false);
  for (const entry of result.skipped) {
    assert.deepEqual(entry, { n: entry.n, reason: 'secret', pattern: 'github-token' });
  }
  const keys = Object.keys(result.hashesAfter.files);
  assert.equal(keys.length, Object.keys(before.files).length);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(result.hashesEqual, true);
});

test('Test_WikiImport changed unpicked note still reports hashesEqual false', async () => {
  const root = tempDir('memento-import-stale-');
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'drafts'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'picked.md'), note(
    'title: 고른 글\nsource: manual\nstatus: candidate\nupdated_at: 2026-02-01T00:00:00.000Z\nsummary: 고른 요약',
    '고른 원문',
  ));
  writeFileSync(join(root, 'drafts', 'other.md'), note(
    'title: 다른 글\nstatus: candidate\nupdated_at: 2026-03-01T00:00:00.000Z\nsummary: 다른 요약',
    '다른 원문',
  ));
  const { rows } = scanWiki(root);
  const before = hashTree(root);
  writeFileSync(join(root, 'drafts', 'other.md'), note(
    'title: 다른 글\nstatus: candidate\nupdated_at: 2026-03-01T00:00:00.000Z\nsummary: 다른 요약',
    '바뀐 다른 원문',
  ));
  const picked = rows.find((row) => row.path === 'knowledge/picked.md');
  const { store } = await setupStore();
  const result = await importPickedRows({ store, root, rows, pick: String(picked.n), beforeHashes: before });
  assert.equal(result.created.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.hashesEqual, false);
});

test('Test_WikiImport literal redaction names never lose ordinary entries', async () => {
  const secretDir = `ghp_${'A'.repeat(30)}`;
  const secretFile = `ghp_${'B'.repeat(30)}`;
  const root = tempDir('memento-import-literal-collision-');
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'knowledge', secretDir), { recursive: true });
  mkdirSync(join(root, 'knowledge', '[redacted-0281ee5d]'), { recursive: true });
  mkdirSync(join(root, 'drafts'), { recursive: true });
  writeFileSync(join(root, 'knowledge', secretDir, 'note.md'), note(
    'title: 비밀 폴더 글\nsource: manual\nstatus: candidate\nupdated_at: 2026-02-01T00:00:00.000Z\nsummary: 비밀 폴더 요약',
    '비밀 폴더 본문',
  ));
  writeFileSync(join(root, 'drafts', `${secretFile}.md`), note(
    'title: 비밀 파일 글\nstatus: candidate\nupdated_at: 2026-03-01T00:00:00.000Z\nsummary: 비밀 파일 요약',
    '비밀 파일 본문',
  ));
  writeFileSync(join(root, 'knowledge', '[redacted-0281ee5d]', 'note.md'), 'ordinary note body');
  writeFileSync(join(root, 'knowledge', '[redacted-0281ee5d]', 'note.md#2'), 'occupied resolution body');
  writeFileSync(join(root, 'knowledge', 'plain.md'), 'plain ordinary body');
  const { rows } = scanWiki(root);
  assert.equal(rows.length, 2);
  const before = hashTree(root);
  assert.equal(Object.keys(before.files).length, 5);
  const { store } = await setupStore();
  const forward = await importPickedRows({ store, root, rows, pick: `${rows[0].n},${rows[1].n}`, beforeHashes: before });
  const backward = await importPickedRows({ store, root, rows, pick: `${rows[1].n},${rows[0].n}`, beforeHashes: before });
  for (const result of [forward, backward]) {
    assert.equal(result.ok, true);
    assert.equal(result.created.length, 0);
    assert.equal(result.skipped.length, 2);
    assert.equal(result.failed.length, 0);
    assert.equal(result.hashesEqual, true);
    const text = JSON.stringify(result);
    assert.equal(text.includes(secretDir), false);
    assert.equal(text.includes(secretFile), false);
    const publicFiles = result.hashesAfter.files;
    assert.equal(Object.keys(publicFiles).length, 5);
    assert.equal(publicFiles['knowledge/[redacted-0281ee5d]/note.md'], before.files['knowledge/[redacted-0281ee5d]/note.md']);
    assert.equal(publicFiles['knowledge/[redacted-0281ee5d]/note.md#3'], before.files[`knowledge/${secretDir}/note.md`]);
    assert.equal(publicFiles['knowledge/[redacted-0281ee5d]/note.md#2'], before.files['knowledge/[redacted-0281ee5d]/note.md#2']);
    assert.equal(publicFiles['knowledge/plain.md'], before.files['knowledge/plain.md']);
    assert.equal(publicFiles[`drafts/${secretFile}.md`], undefined);
  }
  assert.deepEqual(backward.hashesAfter.files, forward.hashesAfter.files);
});

test('Test_WikiImport omitted repoDir still refuses an inside-wiki store root', async () => {
  const root = tempDir('memento-import-omitted-');
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'solo.md'), note(
    'title: 솔로\nsource: manual\nstatus: candidate\nupdated_at: 2026-02-01T00:00:00.000Z\nsummary: 솔로 요약',
    '솔로 원문',
  ));
  const repoDir = join(root, 'data');
  assert.equal((await initRepo({ dir: repoDir })).ok, true);
  const wikiBefore = hashTree(root);
  const repoBefore = hashTree(repoDir);
  const store = openStore(repoDir, testStoreOptions());
  const { rows } = scanWiki(root);
  assert.equal(rows.length, 1);
  await assert.rejects(
    importPickedRows({ store, root, rows, pick: '1', beforeHashes: wikiBefore }),
    (error) => error instanceof WikiImportError && error.code === 'REPO_INSIDE_WIKI',
  );
  assert.equal(manifestsEqual(wikiBefore, hashTree(root)), true);
  assert.equal(manifestsEqual(repoBefore, hashTree(repoDir)), true);
  assert.deepEqual(cardFiles(repoDir), []);
});

test('Test_WikiImport mismatched repoDir never overrides the actual store root', async () => {
  const root = tempDir('memento-import-mismatch-');
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'solo.md'), note(
    'title: 솔로\nsource: manual\nstatus: candidate\nupdated_at: 2026-02-01T00:00:00.000Z\nsummary: 솔로 요약',
    '솔로 원문',
  ));
  const repoDir = join(root, 'data');
  assert.equal((await initRepo({ dir: repoDir })).ok, true);
  const outside = join(tempDir('memento-import-mismatch-out-'), 'memento');
  assert.equal((await initRepo({ dir: outside })).ok, true);
  const wikiBefore = hashTree(root);
  const repoBefore = hashTree(repoDir);
  const outsideBefore = hashTree(outside);
  const store = openStore(repoDir, testStoreOptions());
  const { rows } = scanWiki(root);
  for (const declared of [outside, root]) {
    await assert.rejects(
      importPickedRows({ store, root, rows, pick: '1', repoDir: declared, beforeHashes: wikiBefore }),
      (error) => error instanceof WikiImportError && error.code === 'REPO_MISMATCH',
    );
  }
  assert.equal(manifestsEqual(wikiBefore, hashTree(root)), true);
  assert.equal(manifestsEqual(repoBefore, hashTree(repoDir)), true);
  assert.equal(manifestsEqual(outsideBefore, hashTree(outside)), true);
  assert.deepEqual(cardFiles(repoDir), []);
  assert.deepEqual(cardFiles(outside), []);
});

test('Test_WikiImportCli secret-shaped filename skips with pattern only', async () => {
  const value = `ghp_${'A'.repeat(30)}`;
  const root = tempDir('memento-import-secret-name-');
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  writeFileSync(join(root, 'knowledge', `${value}.md`), note(
    'title: 파일명 비밀\nsource: manual\nstatus: candidate\nupdated_at: 2026-02-01T00:00:00.000Z\nsummary: 파일명 요약',
    '깨끗한 본문',
  ));
  const { candidatesFile, rows } = scannedCandidates(root, 'memento-import-secret-name-out-');
  assert.equal(rows.length, 1);
  const repoDir = join(tempDir('memento-import-secret-name-repo-'), 'memento');
  assert.equal((await initRepo({ dir: repoDir })).ok, true);
  const env = configuredAgent(repoDir);
  const result = spawnSync(process.execPath,
    [CLI, 'wiki-import', '--candidates', candidatesFile, '--pick', '1', '--root', root],
    { encoding: 'utf8', timeout: 120_000, env });
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout + result.stderr;
  assert.match(output, /skipped: row 1 secret \(github-token\)/);
  assert.match(output, /created 0/);
  assert.equal(output.includes(value), false);
  assert.deepEqual(cardFiles(repoDir), []);
});
