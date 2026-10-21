import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WIKI_SRC = join(ROOT, 'src', 'wiki');
const CLI = join(ROOT, 'bin', 'memento.mjs');

const MUTATION_PATTERNS = [
  /\bwriteFile(Sync)?\b/,
  /\bappendFile(Sync)?\b/,
  /\bopenSync\s*\(/,
  /\bwriteSync\b/,
  /\brm(Sync)?\b/,
  /\brename(Sync)?\b/,
  /\bunlink(Sync)?\b/,
  /\bmkdir(Sync)?\b/,
  /\bcopyFile(Sync)?\b/,
  /\bchmod(Sync)?\b/,
  /\btruncate(Sync)?\b/,
  /\bcreateWriteStream\b/,
  /\bmkdtemp(Sync)?\b/,
];

const SIDE_EFFECT_PATTERNS = [
  /\bsetTimeout\b/,
  /\bsetInterval\b/,
  /\bsetImmediate\b/,
  /\bnode:child_process\b/,
  /\bchild_process\b/,
  /\bnode:https\b/,
  /\bnode:http\b/,
  /\bnode:net\b/,
  /\bnode:dgram\b/,
  /\bfetch\s*\(/,
  /\bAtomics\.wait\b/,
];

const READ_ONLY_FS_IMPORTS = new Set(['readdirSync', 'readFileSync', 'statSync', 'realpathSync']);

function wikiSources() {
  return readdirSync(WIKI_SRC)
    .filter(name => name.endsWith('.mjs'))
    .map(name => ({ name, text: readFileSync(join(WIKI_SRC, name), 'utf8') }));
}

test('Test_WikiScannerSource has no mutation or side-effect APIs', () => {
  const sources = wikiSources();
  assert.equal(sources.length > 0, true);
  for (const { name, text } of sources) {
    for (const pattern of MUTATION_PATTERNS) {
      assert.equal(pattern.test(text), false, `${name} matches ${pattern}`);
    }
    for (const pattern of SIDE_EFFECT_PATTERNS) {
      assert.equal(pattern.test(text), false, `${name} matches ${pattern}`);
    }
  }
});

test('Test_WikiScannerSource imports node:fs read calls only', () => {
  for (const { name, text } of wikiSources()) {
    const fsImports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs'/g)];
    assert.equal(fsImports.length, 1, `${name} must import node:fs once`);
    const names = fsImports[0][1].split(',').map(part => part.trim()).filter(Boolean);
    for (const imported of names) {
      assert.equal(READ_ONLY_FS_IMPORTS.has(imported), true, `${name} imports ${imported}`);
    }
  }
});

test('Test_Cli_wiki_scan guards the output directory before any write', () => {
  const source = readFileSync(CLI, 'utf8');
  const start = source.indexOf('async function runWikiScan(root, out)');
  assert.equal(start >= 0, true);
  const end = source.indexOf('\nasync function main(', start);
  assert.equal(end > start, true);
  const branch = source.slice(start, end);
  const guard = branch.indexOf('assertOutOutsideRoot');
  const mkdir = branch.indexOf('mkdir(');
  const write = branch.indexOf('writeFile(');
  assert.equal(guard >= 0, true);
  assert.equal(mkdir > guard, true);
  assert.equal(write > guard, true);
  assert.equal(branch.includes('hashTree('), true);
  assert.equal(branch.includes('scanWiki('), true);
});

test('Test_WikiScannerSource never writes outside its root by following links', () => {
  for (const { name, text } of wikiSources()) {
    assert.equal(/isSymbolicLink\s*\(\)/.test(text), true, `${name} must skip symbolic links`);
  }
});
