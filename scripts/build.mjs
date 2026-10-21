import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist');
const SOURCES = ['src', 'bin'];

export function filesUnder(directory, root = directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path, root));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll(sep, '/'));
  }
  return files.sort();
}

// Copies the current tree file by file. A source file that disappears between
// listing and reading is a concurrent edit, not a build failure.
function copyTree(source, target) {
  for (const file of filesUnder(source)) {
    const from = join(source, file);
    const to = join(target, file);
    let bytes;
    try {
      bytes = readFileSync(from);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, bytes);
  }
}

export function build() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  for (const source of SOURCES) {
    const directory = join(ROOT, source);
    if (existsSync(directory)) copyTree(directory, join(DIST, source));
  }
  const sha256 = {};
  for (const file of filesUnder(DIST)) {
    sha256[file] = createHash('sha256').update(readFileSync(join(DIST, file))).digest('hex');
  }
  const manifest = join(DIST, 'manifest.json');
  writeFileSync(manifest, `${JSON.stringify({ entry: 'src/extension.mjs', cli: 'bin/memento.mjs', sha256 }, null, 2)}\n`);
  return { files: Object.keys(sha256), sha256, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = build();
    console.log(`build ok -> dist/ (${report.files.length} files)`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
