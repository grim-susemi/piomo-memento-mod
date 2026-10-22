/**
 * Import of picked old-wiki candidate rows.
 *
 * Read-only against the wiki root: notes are located through realpathSync and
 * read with readFileSync only, so a symlink or a parent-dir escape never leaves
 * the root and is reported instead of followed. New cards are written through
 * the card store, which commits them to the data repo. The wiki tree is hashed
 * after the run so the caller can prove it stayed byte-identical.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { normalizeIntake } from '../card/codec.mjs';
import { findSecret } from '../card/secrets.mjs';
import {
  decodeStrictUtf8,
  hashTree,
  manifestsEqual,
  parseFrontmatter,
} from './scan.mjs';

export const IMPORT_SCHEMA = 'memento.wiki-import.v1';
export const ORIGINAL_LIMIT = 2000;
export const DESCRIPTION_LIMIT = 120;
export const IMPORT_SOURCE = 'old-wiki';

export class WikiImportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WikiImportError';
    this.code = code;
  }
}

function cutCodePoints(text, limit) {
  return [...text].slice(0, Math.max(0, limit)).join('');
}

/**
 * Resolve the pick list to candidate rows in pick order, duplicates dropped.
 * Throws WikiImportError with code BAD_PICK before anything is written when a
 * token is not a row number or names no candidate row.
 */
export function parsePick(pick, rows) {
  const byNumber = new Map();
  for (const row of rows ?? []) {
    if (typeof row?.n === 'number' && typeof row?.path === 'string') {
      byNumber.set(row.n, row);
    }
  }
  const tokens = Array.isArray(pick)
    ? pick.map((value) => String(value))
    : String(pick ?? '').split(/[\s,]+/);
  const wanted = [];
  const seen = new Set();
  let any = false;
  for (const token of tokens) {
    if (token.length === 0) continue;
    any = true;
    if (!/^\d+$/.test(token)) {
      throw new WikiImportError(`bad pick "${token}": expected a row number`, 'BAD_PICK');
    }
    const n = Number(token);
    const row = byNumber.get(n);
    if (!row) throw new WikiImportError(`row ${n} not in candidates`, 'BAD_PICK');
    if (seen.has(n)) continue;
    seen.add(n);
    wanted.push(row);
  }
  if (!any) {
    throw new WikiImportError('pick is empty: expected at least one row number', 'BAD_PICK');
  }
  return wanted;
}

/**
 * Resolve a candidate path to the real note file. A symlink anywhere in the
 * resolution, or a path that escapes the root, is reported as a skip reason
 * instead of being followed.
 */
function locateNote(root, row) {
  let base;
  try {
    base = realpathSync(resolve(root));
  } catch {
    throw new WikiImportError(`wiki root is not readable: ${root}`, 'BAD_ROOT');
  }
  const parts = String(row.path).split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || /^[a-zA-Z]:/.test(part) || part.includes('\\'))) {
    return { skip: 'symlink-or-escape' };
  }
  const abs = resolve(root, row.path);
  let siblings;
  try {
    siblings = readdirSync(dirname(abs), { withFileTypes: true });
  } catch {
    return { skip: 'missing' };
  }
  const leaf = siblings.find((entry) => entry.name === basename(abs));
  if (leaf && typeof leaf.isSymbolicLink === 'function' && leaf.isSymbolicLink()) {
    return { skip: 'symlink-or-escape' };
  }
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    return { skip: 'missing' };
  }
  if (real !== join(base, ...parts)) {
    return { skip: 'symlink-or-escape' };
  }
  return { abs: real };
}

function foldCase(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * Resolve a path to its real location, reattaching not-yet-existing trailing
 * segments onto the nearest existing ancestor.
 */
export function canonicalReal(target) {
  let current = resolve(target);
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

export function canonicalEqual(left, right) {
  return foldCase(canonicalReal(left)) === foldCase(canonicalReal(right));
}

/**
 * Refuse a data repo equal to or canonically inside the wiki root, before any
 * store write. Both sides are resolved to real paths, so a lexical alias with
 * parent segments, a junction root or a case variant is still refused.
 */
export function assertRepoOutsideWiki(root, repoDir) {
  let wikiReal;
  try {
    wikiReal = realpathSync(resolve(root));
  } catch {
    throw new WikiImportError(`wiki root is not readable: ${root}`, 'BAD_ROOT');
  }
  if (typeof repoDir !== 'string' || repoDir.length === 0) {
    throw new WikiImportError('import needs the data repo directory', 'BAD_REPO');
  }
  const repoReal = canonicalReal(repoDir);
  const foldedWiki = foldCase(wikiReal);
  const foldedRepo = foldCase(repoReal);
  if (foldedRepo === foldedWiki || foldedRepo.startsWith(`${foldedWiki}${sep}`)) {
    throw new WikiImportError('data repo must be outside the wiki root', 'REPO_INSIDE_WIKI');
  }
  return { wikiReal, repoReal };
}

/**
 * Resolve the destination authority for the no-wiki-write boundary. The
 * actual store root always wins: a caller-supplied repoDir that disagrees
 * with it is refused instead of silently overriding the check.
 */
export function resolveRepoAuthority(store, repoDir) {
  const storeRoot = typeof store?.root === 'string' && store.root.length > 0 ? store.root : null;
  const declared = typeof repoDir === 'string' && repoDir.length > 0 ? repoDir : null;
  if (storeRoot && declared && !canonicalEqual(storeRoot, declared)) {
    throw new WikiImportError('declared repo differs from the actual store root', 'REPO_MISMATCH');
  }
  const authority = storeRoot ?? declared;
  if (!authority) {
    throw new WikiImportError('import needs a verifiable store root', 'BAD_STORE');
  }
  return authority;
}

/**
 * Public projection for secret-bearing manifest keys. The true integrity
 * comparison always runs on the original unredacted manifest first; only the
 * returned projection replaces secret-bearing path segments. Each replaced
 * segment carries a deterministic digest of its original text, so two
 * different secret paths never collapse into one key and file counts stay
 * exact. Non-secret keys pass through byte-identical.
 */
export function redactSecretPath(key) {
  return String(key).split('/').map((segment) => {
    if (!findSecret(segment)) return segment;
    return `[redacted-${createHash('sha256').update(segment).digest('hex').slice(0, 8)}]`;
  }).join('/');
}

function hasSecretSegment(key) {
  return String(key).split('/').some((segment) => Boolean(findSecret(segment)));
}

/**
 * Allocate a generated redaction key against every already-claimed public
 * key: the reserved ordinary set first, then every previously generated key.
 * Resolution appends a deterministic counter and re-checks both sets, so no
 * assumption about real filenames keeps a generated key from colliding.
 */
export function allocateRedactedKey(redacted, reserved, used) {
  if (!reserved.has(redacted) && !used.has(redacted)) {
    used.add(redacted);
    return redacted;
  }
  let counter = 2;
  for (;;) {
    const candidate = `${redacted}#${counter}`;
    if (!reserved.has(candidate) && !used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    counter += 1;
  }
}

export function publicFilesManifest(files) {
  const entries = Object.entries(files ?? {});
  const reserved = new Set();
  const used = new Set();
  const projected = {};
  for (const [key, digest] of entries) {
    if (hasSecretSegment(key)) continue;
    reserved.add(key);
    used.add(key);
    projected[key] = digest;
  }
  const secretEntries = entries
    .filter(([key]) => hasSecretSegment(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [key, digest] of secretEntries) {
    projected[allocateRedactedKey(redactSecretPath(key), reserved, used)] = digest;
  }
  return projected;
}

export function publicSkipped(entries) {
  return (entries ?? []).map((entry) => (entry?.reason === 'secret'
    ? { n: entry.n, reason: entry.reason, pattern: entry.pattern }
    : entry));
}

function describeRow(row, body) {
  const raw = typeof row.summary === 'string' && row.summary.length > 0 ? row.summary : body;
  return cutCodePoints(normalizeIntake(raw).split('\n')[0], DESCRIPTION_LIMIT);
}

/**
 * Import the picked candidate rows into the store. Every picked row becomes at
 * most one card: title is the row title, description is the first summary line
 * cut to 120 chars, original is the note body with frontmatter taken off,
 * verbatim up to 2000 chars. Rows whose source_ref already exists become
 * `already-imported` skips; rows holding a secret become `secret` skips that
 * name the pattern only. Card validation failures are collected per row.
 */
export async function importPickedRows({ store, root, rows, pick, beforeHashes = null, repoDir = null } = {}) {
  if (!store || typeof store.list !== 'function' || typeof store.create !== 'function') {
    throw new WikiImportError('import needs a card store with list and create', 'BAD_STORE');
  }
  if (!Array.isArray(rows)) {
    throw new WikiImportError('import needs the candidate rows array', 'BAD_CANDIDATES');
  }
  const wanted = parsePick(pick, rows);
  assertRepoOutsideWiki(root, resolveRepoAuthority(store, repoDir));
  const existing = await store.list();
  const known = new Map((existing?.cards ?? []).map((card) => [card.sourceRef, card.id]));
  const created = [];
  const skipped = [];
  const failed = [];
  for (const row of wanted) {
    const located = locateNote(root, row);
    if (located.skip) {
      skipped.push({ n: row.n, path: row.path, reason: located.skip });
      continue;
    }
    const abs = located.abs;
    if (known.has(abs)) {
      skipped.push({ n: row.n, path: row.path, reason: 'already-imported', id: known.get(abs) });
      continue;
    }
    let bytes;
    try {
      bytes = readFileSync(abs);
    } catch {
      skipped.push({ n: row.n, path: row.path, reason: 'missing' });
      continue;
    }
    const decoded = decodeStrictUtf8(bytes);
    if (decoded.error) {
      skipped.push({ n: row.n, path: row.path, reason: decoded.error });
      continue;
    }
    const { body } = parseFrontmatter(decoded.text);
    const title = normalizeIntake(String(row.title ?? ''));
    const description = describeRow(row, body);
    const original = cutCodePoints(normalizeIntake(body), ORIGINAL_LIMIT);
    const pattern = findSecret(title)
      ?? findSecret(description)
      ?? findSecret(original)
      ?? findSecret(normalizeIntake(abs));
    if (pattern) {
      skipped.push({ n: row.n, path: row.path, reason: 'secret', pattern });
      continue;
    }
    const made = await store.create({
      title,
      description,
      original,
      source: IMPORT_SOURCE,
      sourceRef: abs,
      via: IMPORT_SOURCE,
      actor: 'owner',
    });
    if (!made.ok) {
      failed.push({ n: row.n, path: row.path, code: made.code, reason: made.reason ?? made.code });
      continue;
    }
    known.set(abs, made.id);
    created.push({ n: row.n, path: row.path, id: made.id, file: made.file, sourceRef: abs });
  }
  const hashesAfter = hashTree(root);
  const hashesEqual = beforeHashes ? manifestsEqual(beforeHashes, hashesAfter) : null;
  return {
    ok: failed.length === 0,
    schema: IMPORT_SCHEMA,
    created,
    skipped: publicSkipped(skipped),
    failed,
    hashesAfter: { ...hashesAfter, files: publicFilesManifest(hashesAfter.files) },
    hashesEqual,
  };
}
