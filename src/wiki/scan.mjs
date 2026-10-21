/**
 * Read-only old-wiki scanner.
 *
 * Every exported function only reads: readdirSync, readFileSync, statSync and
 * realpathSync. Output files are written by bin/memento.mjs after
 * assertOutOutsideRoot has proven the output directory is outside the wiki.
 * Symbolic links are never followed, so a link cannot escape the root.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

export const KS_X_1001_SYLLABLE_COUNT = 2350;

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
const CJK_FIRST = 0x4e00;
const CJK_LAST = 0x9fff;
const QUESTION = 0x3f;
const REPLACEMENT = 0xfffd;

const QUESTION_RUN = /[\uAC00-\uD7A3]\?{2,}|\?{2,}[\uAC00-\uD7A3]/;

export const KS_X_1001_SYLLABLES = buildKsx1001Syllables();

/** Decode EUC-KR lead/trail pairs B0A1-C8FE once; exactly 2,350 syllables. */
function buildKsx1001Syllables() {
  const decoder = new TextDecoder('euc-kr');
  const syllables = new Set();
  for (let lead = 0xb0; lead <= 0xc8; lead += 1) {
    for (let trail = 0xa1; trail <= 0xfe; trail += 1) {
      const decoded = decoder.decode(Uint8Array.from([lead, trail]));
      if (decoded.length === 1 && isHangulSyllable(decoded)) syllables.add(decoded);
    }
  }
  return syllables;
}

export function isHangulSyllable(value) {
  if (typeof value !== 'string' || value.length !== 1) return false;
  const code = value.codePointAt(0);
  return code >= HANGUL_FIRST && code <= HANGUL_LAST;
}

function isCjkIdeograph(value) {
  if (typeof value !== 'string' || value.length !== 1) return false;
  const code = value.codePointAt(0);
  return code >= CJK_FIRST && code <= CJK_LAST;
}

function isRareSyllable(value) {
  return isHangulSyllable(value) && !KS_X_1001_SYLLABLES.has(value);
}

export function decodeStrictUtf8(bytes) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { error: 'utf8' };
  }
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value.length === 0) return '';
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

export function parseFrontmatter(text) {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return { frontmatter: {}, body: source, hasFrontmatter: false };
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    frontmatter[pair[1]] = parseScalar(pair[2]);
  }
  return { frontmatter, body: source.slice(match[0].length), hasFrontmatter: true };
}

/**
 * Broken-Korean rules, in a fixed order:
 * replacement-char, question-run, cjk-mixed, adjacency.
 */
export function brokenReasons(text, frontmatter = {}) {
  const reasons = [];
  if (text.includes('\uFFFD')) reasons.push('replacement-char');
  if (QUESTION_RUN.test(text)) reasons.push('question-run');

  const lang = typeof frontmatter?.lang === 'string' ? frontmatter.lang.trim().toLowerCase() : '';
  const chars = [...text];
  let hasHangul = false;
  let ideographs = 0;
  let adjacency = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (isHangulSyllable(char)) {
      hasHangul = true;
      continue;
    }
    const code = char.codePointAt(0);
    if (code !== QUESTION && code !== REPLACEMENT && !isCjkIdeograph(char)) continue;
    if (isCjkIdeograph(char)) ideographs += 1;
    if (isRareSyllable(chars[index - 1]) || isRareSyllable(chars[index + 1])) adjacency = true;
  }
  if (hasHangul && ideographs >= 3 && lang !== 'zh' && lang !== 'ja') reasons.push('cjk-mixed');
  if (adjacency) reasons.push('adjacency');
  return reasons;
}

function statusRank(status) {
  return status === 'lesson' ? 0 : 1;
}

function folderRank(folder) {
  return folder === 'knowledge' ? 0 : 1;
}

function timestampOf(entry) {
  for (const key of ['updated_at', 'created_at']) {
    const value = entry?.[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return Number.NEGATIVE_INFINITY;
}

/** lesson first, knowledge before drafts, newest updated/created, path ascending. */
export function rankCandidates(entries, limit = 50) {
  const sorted = [...entries].sort((left, right) => {
    const byStatus = statusRank(left.status) - statusRank(right.status);
    if (byStatus !== 0) return byStatus;
    const byFolder = folderRank(left.folder) - folderRank(right.folder);
    if (byFolder !== 0) return byFolder;
    const leftTime = timestampOf(left);
    const rightTime = timestampOf(right);
    if (leftTime !== rightTime) return leftTime > rightTime ? -1 : 1;
    if (left.path === right.path) return 0;
    return left.path < right.path ? -1 : 1;
  });
  return sorted.slice(0, Math.max(0, limit));
}

function walkTree(base) {
  const files = [];
  const symlinks = [];
  const visit = (dir, prefix) => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        symlinks.push(rel);
        continue;
      }
      if (entry.isDirectory()) visit(abs, rel);
      else if (entry.isFile()) files.push({ rel, abs });
    }
  };
  visit(base, '');
  return { files, symlinks };
}

export function hashEntries(entries, readBytes = readFileSync) {
  const files = {};
  const unreadable = [];
  for (const entry of entries) {
    try {
      files[entry.rel] = createHash('sha256').update(readBytes(entry.abs)).digest('hex');
    } catch (error) {
      unreadable.push({ path: entry.rel, code: error?.code ?? 'error' });
    }
  }
  return {
    files,
    coverage: { total: entries.length, hashed: Object.keys(files).length, unreadable },
  };
}

export function hashTree(root) {
  const base = resolve(root);
  const tree = walkTree(base);
  const hashed = hashEntries(tree.files);
  return {
    schema: 'memento.wiki-hash.v1',
    root: base,
    algorithm: 'sha256',
    files: hashed.files,
    coverage: { ...hashed.coverage, symlinksSkipped: tree.symlinks },
  };
}

export function manifestsEqual(left, right) {
  const leftFiles = left?.files ?? {};
  const rightFiles = right?.files ?? {};
  const leftKeys = Object.keys(leftFiles);
  if (leftKeys.length !== Object.keys(rightFiles).length) return false;
  for (const key of leftKeys) {
    if (rightFiles[key] !== leftFiles[key]) return false;
  }
  return true;
}

function resolveRealPath(target) {
  let current = target;
  const rest = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return rest.length === 0 ? real : join(real, ...rest);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) return join(current, ...rest);
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

function trimTrailingSeparators(value) {
  const trimmed = value.replace(/[\\/]+$/, '');
  return trimmed.length === 0 ? sep : trimmed;
}

/** Refuse any output directory that is the wiki root or lives inside it. */
export function assertOutOutsideRoot(root, out) {
  const rootKey = trimTrailingSeparators(resolveRealPath(resolve(root)));
  const outKey = trimTrailingSeparators(resolveRealPath(resolve(out)));
  const fold = process.platform === 'win32' ? value => value.toLowerCase() : value => value;
  const foldedRoot = fold(rootKey);
  const foldedOut = fold(outKey);
  if (foldedOut === foldedRoot || foldedOut.startsWith(`${foldedRoot}${sep}`)) {
    const error = new Error(`output directory must be outside the wiki root (${rootKey})`);
    error.code = 'OUT_INSIDE_ROOT';
    throw error;
  }
}

function isPoolLocation(rel) {
  return /^knowledge\/.+\.md$/.test(rel) || /^drafts\/[^/]+\.md$/.test(rel);
}

function isPoolCandidate(rel, frontmatter) {
  const status = frontmatter.status;
  const source = frontmatter.source;
  if (rel.startsWith('knowledge/')) {
    return source === 'manual' && (status === 'candidate' || status === 'lesson');
  }
  return status === 'candidate';
}

function summaryOf(frontmatter, body) {
  const explicit = typeof frontmatter.summary === 'string' ? frontmatter.summary.trim() : '';
  const text = explicit.length > 0 ? explicit : [...body.replace(/^\s+/, '')].slice(0, 120).join('').trimEnd();
  return text.normalize('NFC');
}

/**
 * Scan a wiki read-only: hash every root file, classify the candidate pool and
 * return at most `limit` ranked rows plus the excluded broken notes.
 */
export function scanWiki(root, options = {}) {
  const limit = options.limit ?? 50;
  const base = resolve(root);
  const stats = statSync(base);
  if (!stats.isDirectory()) {
    const error = new Error(`wiki root is not a directory: ${base}`);
    error.code = 'ENOTDIR';
    throw error;
  }

  const tree = walkTree(base);
  const hashed = hashEntries(tree.files);
  const hashes = {
    schema: 'memento.wiki-hash.v1',
    root: base,
    algorithm: 'sha256',
    files: hashed.files,
    coverage: { ...hashed.coverage, symlinksSkipped: tree.symlinks },
  };

  const unreadable = new Map(hashed.coverage.unreadable.map(entry => [entry.path, entry.code]));
  let scanned = 0;
  let pool = 0;
  const candidates = [];
  const excludedBroken = [];

  for (const file of tree.files) {
    if (!isPoolLocation(file.rel)) continue;
    scanned += 1;
    const folder = file.rel.startsWith('knowledge/') ? 'knowledge' : 'drafts';
    if (unreadable.has(file.rel)) {
      excludedBroken.push({ path: file.rel, folder, reasons: ['unreadable'], code: unreadable.get(file.rel) });
      continue;
    }
    const decoded = decodeStrictUtf8(readFileSync(file.abs));
    if (decoded.error) {
      excludedBroken.push({ path: file.rel, folder, reasons: [decoded.error] });
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(decoded.text);
    if (!isPoolCandidate(file.rel, frontmatter)) continue;
    pool += 1;
    const reasons = brokenReasons(decoded.text, frontmatter);
    if (reasons.length > 0) {
      excludedBroken.push({ path: file.rel, folder, reasons });
      continue;
    }
    candidates.push({
      path: file.rel,
      folder,
      title: (frontmatter.title ?? '').normalize('NFC'),
      summary: summaryOf(frontmatter, body),
      status: frontmatter.status,
      updated_at: frontmatter.updated_at ?? frontmatter.created_at ?? '',
      created_at: frontmatter.created_at ?? '',
    });
  }

  const rows = rankCandidates(candidates, limit).map((candidate, index) => ({
    n: index + 1,
    path: candidate.path,
    folder: candidate.folder,
    title: candidate.title,
    summary: candidate.summary,
    status: candidate.status,
    updated_at: candidate.updated_at,
  }));

  return {
    hashes,
    rows,
    excludedBroken,
    counts: {
      files: tree.files.length,
      scanned,
      pool,
      excludedBroken: excludedBroken.length,
      rows: rows.length,
    },
  };
}
