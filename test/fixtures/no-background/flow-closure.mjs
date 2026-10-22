// TASK13 B1/B2 closed-world reviewed-flow inventory and census.
//
// This module is test-only. It never regenerates reviewed-flows.json: the
// inventory is a manually reviewed baseline. The --print-inventory mode is a
// manual review aid, not a test path.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  enclosingFunction,
  findMatching,
  functionRanges,
  lineOf,
  maskSource,
} from './source-text.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORD = /[A-Za-z0-9_$]/;

// High-churn factories are never pinned whole. Their census occurrences are
// reviewed as exact lines instead (the consult's bounded exception).
export const LARGE_FUNCTIONS = new Set([
  'createBoardApi',
  'createDiscordClient',
  'runPass',
  'runSync',
  'startFakeDiscord',
  'startFakeDiscord>handle',
  'extension',
  'main',
  'runOwnerPhase',
  'runSetup',
  'openStore',
  'acquire',
  'verifyRecentWrites',
  'runProbe',
  'runRoundtrip',
  'runSyncCommand',
  'runProbeCommand',
]);

export const GLOBAL_READ_TOKENS = ['Promise', 'AbortController', 'AbortSignal'];

// Reviewed non-mutating methods only. Any other dotted method call is not a read.
export const GLOBAL_MEMBER_METHODS = {
  Promise: new Set(['all', 'allSettled', 'race', 'reject', 'resolve']),
  AbortSignal: new Set(['any', 'timeout']),
  AbortController: new Set(),
};

export const DEFAULT_CENSUS = [
  { token: 'setTimeout', match: 'word' },
  { token: 'clearTimeout', match: 'word' },
  { token: 'setInterval', match: 'word' },
  { token: 'setImmediate', match: 'word' },
  { token: 'sleepReal', match: 'word' },
  { token: 'realSleep', match: 'word' },
  { token: 'sleep', match: 'word' },
  { token: 'delay', match: 'word' },
  { token: 'createDeadline', match: 'word' },
  { token: 'dispose', match: 'word' },
  { token: 'URL', match: 'word' },
  { token: 'fetch', match: 'word' },
  { token: 'httpsRequest', match: 'word' },
  { token: 'httpRequest', match: 'word' },
  { token: 'HttpsAgent', match: 'word' },
  { token: 'HttpAgent', match: 'word' },
  { token: 'requestOnce', match: 'word' },
  { token: 'joinUrl', match: 'word' },
  { token: 'querySuffix', match: 'word' },
  { token: 'baseUrl', match: 'word' },
  { token: 'DEFAULT_BASE_URL', match: 'word' },
  { token: 'globalThis', match: 'word' },
  { token: 'prototype', match: 'word' },
  { token: '.constructor', match: 'literal' },
  { token: 'defineProperty', match: 'word' },
  { token: 'setPrototypeOf', match: 'word' },
  { token: 'Reflect', match: 'word' },
  { token: 'Proxy', match: 'word' },
  { token: 'eval', match: 'word' },
  { token: 'Function', match: 'word' },
  { token: 'with', match: 'word' },
  { token: 'createRequire', match: 'word' },
  { token: 'import(', match: 'import-call', lineOnly: true },
];

export const DEFAULT_SPECIFIERS = [
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'node:dgram',
  'node:http2',
  'node:vm',
  'node:module',
  'node:timers',
  'node:timers/promises',
];

export function lf(text) {
  return text.replace(/\r\n?/g, '\n');
}

export function sha256(text) {
  return createHash('sha256').update(lf(text), 'utf8').digest('hex');
}

export function sourceFiles(root) {
  const paths = [join(root, 'bin', 'memento.mjs')];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) paths.push(path);
    }
  };
  walk(join(root, 'src'));
  return paths.sort().map((path) => ({
    path: relative(root, path).replaceAll('\\', '/'),
    source: readFileSync(path, 'utf8'),
  }));
}

function methodSignatureStart(mask, bodyStart) {
  let index = bodyStart - 1;
  while (index >= 0 && /\s/.test(mask[index])) index -= 1;
  if (mask[index] !== ')') return bodyStart;
  let depth = 0;
  let open = -1;
  for (; index >= 0; index -= 1) {
    if (mask[index] === ')') depth += 1;
    else if (mask[index] === '(') {
      depth -= 1;
      if (depth === 0) {
        open = index;
        break;
      }
    }
  }
  if (open < 0) return bodyStart;
  let end = open - 1;
  while (end >= 0 && /\s/.test(mask[end])) end -= 1;
  let start = end;
  while (start >= 0 && WORD.test(mask[start])) start -= 1;
  start += 1;
  if (start > end) return bodyStart;
  let prefixEnd = start - 1;
  while (prefixEnd >= 0 && /\s/.test(mask[prefixEnd])) prefixEnd -= 1;
  let prefixStart = prefixEnd;
  while (prefixStart >= 0 && WORD.test(mask[prefixStart])) prefixStart -= 1;
  const prefix = mask.slice(prefixStart + 1, prefixEnd + 1);
  if (['async', 'get', 'set'].includes(prefix)) start = prefixStart + 1;
  return start;
}

function pathOf(region) {
  const parts = [];
  let current = region;
  while (current) {
    parts.unshift(current.name);
    current = current.parent;
  }
  return parts.join('>');
}

/** Function ranges that include the declaration/method signature, not just the body. */
export function functionRegions(mask) {
  const regions = functionRanges(mask).map((range) => ({
    ...range,
    bodyStart: range.start,
    bodyEnd: range.end,
    start: range.kind === 'function'
      ? Math.max(0, mask.lastIndexOf('function', range.start))
      : methodSignatureStart(mask, range.start),
  }));
  for (const region of regions) {
    const parents = regions
      .filter((candidate) => candidate !== region
        && candidate.bodyStart < region.bodyStart
        && candidate.bodyEnd > region.bodyEnd)
      .sort((left, right) => (left.bodyEnd - left.bodyStart) - (right.bodyEnd - right.bodyStart));
    region.parent = parents[0] ?? null;
  }
  for (const region of regions) region.path = pathOf(region);
  return regions;
}

export function enclosingRegion(regions, index) {
  return regions
    .filter((region) => index >= region.start && index <= region.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0] ?? null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function tokenIndexes(mask, rule) {
  const indexes = [];
  if (rule.match === 'literal') {
    let index = 0;
    while ((index = mask.indexOf(rule.token, index)) !== -1) {
      indexes.push(index);
      index += rule.token.length;
    }
    return indexes;
  }
  if (rule.match === 'import-call') {
    for (const match of mask.matchAll(/\bimport\s*\(/g)) indexes.push(match.index);
    return indexes;
  }
  const pattern = new RegExp(`\\b${escapeRegExp(rule.token)}\\b`, 'g');
  for (const match of mask.matchAll(pattern)) indexes.push(match.index);
  return indexes;
}

function countToken(text, rule) {
  return tokenIndexes(text, rule).length;
}

function linesOf(source) {
  const lines = [];
  let start = 0;
  for (const part of source.split('\n')) {
    const text = part.endsWith('\r') ? part.slice(0, -1) : part;
    lines.push({ start, text, number: lines.length + 1 });
    start += part.length + 1;
  }
  return lines;
}

function lineAt(source, index) {
  const lines = linesOf(source);
  for (let position = lines.length - 1; position >= 0; position -= 1) {
    if (index >= lines[position].start) return lines[position];
  }
  return lines[0];
}

function controlBlocks(source, mask) {
  const blocks = [];
  const keywords = /\b(if|else|for|while|do|try|catch|finally|switch)\b/g;
  let match;
  while ((match = keywords.exec(mask)) !== null) {
    const kind = match[1];
    let start = match.index;
    if (kind === 'if') {
      const before = mask.slice(0, start);
      const priorElse = /(?:^|[^A-Za-z0-9_$])else\s*$/.exec(before);
      if (priorElse) start = before.lastIndexOf('else', start - 1);
    }
    let cursor = match.index + kind.length;
    const skip = () => {
      while (cursor < mask.length && /\s/.test(mask[cursor])) cursor += 1;
    };
    skip();
    if (kind === 'else') {
      if (mask.startsWith('if', cursor)) continue;
      if (mask[cursor] !== '{') continue;
      const end = findMatching(mask, cursor, '{', '}');
      if (end >= 0) {
        blocks.push({ start, bodyOpen: cursor, end, header: source.slice(start, cursor + 1) });
      }
      continue;
    }
    if (['if', 'for', 'while', 'switch', 'catch'].includes(kind)) {
      if (kind === 'for' && mask.startsWith('await', cursor)) {
        cursor += 5;
        skip();
      }
      if (mask[cursor] === '(') {
        const close = findMatching(mask, cursor, '(', ')');
        if (close < 0) continue;
        cursor = close + 1;
        skip();
      } else if (kind !== 'catch') {
        continue;
      }
      if (mask[cursor] === '{') {
        const end = findMatching(mask, cursor, '{', '}');
        if (end >= 0) {
          blocks.push({ start, bodyOpen: cursor, end, header: source.slice(start, cursor + 1) });
        }
        continue;
      }
      const bodyStart = cursor;
      let depth = 0;
      let end = cursor;
      for (; end < mask.length; end += 1) {
        const char = mask[end];
        if (char === '(' || char === '[' || char === '{') depth += 1;
        else if (char === ')' || char === ']' || char === '}') depth -= 1;
        else if (char === ';' && depth === 0) {
          end += 1;
          break;
        }
      }
      if (end > bodyStart) {
        blocks.push({ start, bodyOpen: bodyStart, end: end - 1, header: source.slice(start, bodyStart) });
      }
      continue;
    }
    if (mask[cursor] !== '{') continue;
    const end = findMatching(mask, cursor, '{', '}');
    if (end >= 0) {
      blocks.push({ start, bodyOpen: cursor, end, header: source.slice(start, cursor + 1) });
    }
  }
  return blocks;
}

/** Exact enclosing control headers, nearest first. */
export function controlChain(source, mask, index) {
  return controlBlocks(source, mask)
    .filter((block) => index >= block.start && index <= block.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start)
      || left.start - right.start)
    .map((block) => ({ raw: block.header, sha256: sha256(block.header) }));
}

function lineIsCode(mask, line) {
  return mask.slice(line.start, line.start + line.text.length) === maskSource(line.text);
}

function anchorList(mask, start, end, census) {
  const text = mask.slice(start, end + 1);
  return census
    .map((rule) => ({ token: rule.token, count: countToken(text, rule) }))
    .filter((anchor) => anchor.count > 0);
}

function candidateInventory(files) {
  const entries = [];
  for (const file of files) {
    const mask = maskSource(file.source);
    const regions = functionRegions(mask);
    const groups = new Map();
    for (const rule of DEFAULT_CENSUS) {
      for (const index of tokenIndexes(mask, rule)) {
        const region = enclosingRegion(regions, index);
        const useFunction = region
          && !LARGE_FUNCTIONS.has(region.path)
          && !rule.lineOnly;
        if (useFunction) {
          const key = `fn:${file.path}:${region.path}`;
          if (!groups.has(key)) {
            groups.set(key, {
              unit: 'function',
              file: file.path,
              path: region.path,
              start: region.start,
              end: region.end,
              indexes: [],
            });
          }
          groups.get(key).indexes.push(index);
        } else {
          const line = lineAt(file.source, index);
          const key = `line:${file.path}:${line.start}`;
          if (!groups.has(key)) {
            groups.set(key, {
              unit: 'line',
              file: file.path,
              path: enclosingRegion(regions, line.start)?.path ?? '<top>',
              start: line.start,
              end: line.start + line.text.length - 1,
              raw: line.text,
              indexes: [],
            });
          }
          groups.get(key).indexes.push(index);
        }
      }
    }
    // Module specifiers are raw-text, line-only entries.
    for (const specifier of moduleSpecifiers(file.source, mask)) {
      if (!DEFAULT_SPECIFIERS.includes(specifier.value)) continue;
      const line = lineAt(file.source, specifier.index);
      const key = `line:${file.path}:${line.start}`;
      if (!groups.has(key)) {
        groups.set(key, {
          unit: 'line',
          file: file.path,
          path: enclosingRegion(regions, line.start)?.path ?? '<top>',
          start: line.start,
          end: line.start + line.text.length - 1,
          raw: line.text,
          indexes: [],
        });
      }
      groups.get(key).indexes.push(specifier.index);
    }
    for (const group of groups.values()) {
      const raw = file.source.slice(group.start, group.end + 1);
      const anchors = anchorList(mask, group.start, group.end, DEFAULT_CENSUS);
      entries.push({
        id: group.unit === 'function'
          ? `fn:${group.file}:${group.path}`
          : `line:${group.file}:${group.start}`,
        unit: group.unit,
        kind: 'reviewed',
        file: group.file,
        path: group.path,
        ...(group.unit === 'line'
          ? { raw: group.raw, occurrence: 1, controls: controlChain(file.source, mask, group.start) }
          : {}),
        sha256: sha256(raw),
        anchors,
      });
    }
  }
  entries.sort((left, right) => left.id.localeCompare(right.id));
  return {
    census: DEFAULT_CENSUS,
    specifiers: DEFAULT_SPECIFIERS,
    globalReadTokens: GLOBAL_READ_TOKENS,
    entries,
  };
}

/** Parse module specifiers from code keywords, then read the raw string. */
export function moduleSpecifiers(source, mask = maskSource(source)) {
  const result = [];
  for (const match of mask.matchAll(/\b(from|import|require)\b/g)) {
    let index = match.index + match[0].length;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (match[1] === 'import' || match[1] === 'require') {
      if (source[index] !== '(') continue;
      index += 1;
      while (index < source.length && /\s/.test(source[index])) index += 1;
    }
    const quote = source[index];
    if (quote !== "'" && quote !== '"') continue;
    let end = index + 1;
    let value = '';
    while (end < source.length && source[end] !== quote) {
      value += source[end];
      end += 1;
    }
    if (source[end] !== quote) continue;
    result.push({ value, index, line: lineOf(source, index) });
  }
  return result;
}

function resolveFunctionEntry(file, mask, regions, entry) {
  const candidates = regions.filter((region) => region.path === entry.path);
  if (candidates.length === 0) return { code: `stale-entry:${entry.id}` };
  if (candidates.length > 1) return { code: `ambiguous:${entry.id}` };
  const region = candidates[0];
  const raw = file.source.slice(region.start, region.end + 1);
  if (sha256(raw) !== entry.sha256) return { code: `region-changed:${entry.id}` };
  const anchors = anchorList(mask, region.start, region.end, DEFAULT_CENSUS);
  for (const anchor of entry.anchors) {
    const found = anchors.find((candidate) => candidate.token === anchor.token);
    if ((found?.count ?? 0) !== anchor.count) return { code: `role:${entry.id}:${anchor.token}` };
  }
  return {
    pin: {
      ...entry,
      unit: 'function',
      start: region.start,
      end: region.end,
      path: region.path,
      raw,
    },
  };
}

function resolveLineEntry(file, mask, regions, entry) {
  const matches = linesOf(file.source).filter((line) => line.text === entry.raw
    && lineIsCode(mask, line)
    && (enclosingRegion(regions, line.start)?.path ?? '<top>') === entry.path);
  if (matches.length === 0) return { code: `stale-entry:${entry.id}` };
  const occurrence = entry.occurrence ?? 1;
  if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > matches.length) {
    return { code: `stale-entry:${entry.id}` };
  }
  if (matches.length > 1 && entry.occurrence === undefined) {
    return { code: `ambiguous:${entry.id}` };
  }
  const line = matches[occurrence - 1];
  if (sha256(line.text) !== entry.sha256) return { code: `region-changed:${entry.id}` };
  const anchors = anchorList(mask, line.start, line.start + line.text.length - 1, DEFAULT_CENSUS);
  for (const anchor of entry.anchors) {
    const found = anchors.find((candidate) => candidate.token === anchor.token);
    if ((found?.count ?? 0) !== anchor.count) return { code: `role:${entry.id}:${anchor.token}` };
  }
  if (entry.body) {
    const bodyLines = entry.body.raw.split('\n');
    if (bodyLines.length < 3) return { code: `body:${entry.id}` };
    const firstLine = bodyLines[0];
    const ownerOpen = bodyLines[1].indexOf('(');
    if (ownerOpen < 0) return { code: `body:${entry.id}` };
    const ownerPrefix = bodyLines[1].slice(0, ownerOpen + 1);
    const finallyBlock = controlBlocks(file.source, mask)
      .filter((block) => block.header.indexOf('finally') === 0
        && line.start >= block.start && line.start <= block.end)
      .sort((left, right) => (left.end - left.start) - (right.end - right.start)
        || left.start - right.start)[0];
    if (!finallyBlock) return { code: `body:${entry.id}` };
    const sourceLines = linesOf(file.source);
    const starts = [];
    for (let index = 0; index < sourceLines.length; index += 1) {
      const candidate = sourceLines[index];
      if (candidate.start >= line.start) break;
      if (candidate.text !== firstLine) continue;
      if (!lineIsCode(mask, candidate)) continue;
      const owner = enclosingRegion(regions, candidate.start);
      if (!owner || owner.path !== entry.path) continue;
      const next = sourceLines[index + 1];
      if (!next || !next.text.startsWith(ownerPrefix)) continue;
      if (!lineIsCode(mask, next)) continue;
      starts.push(candidate);
    }
    if (starts.length !== 1) return { code: `body:${entry.id}` };
    const bodyStart = starts[0].start;
    if (bodyStart >= finallyBlock.start) return { code: `body:${entry.id}` };
    if (line.start < bodyStart || line.start > finallyBlock.end) {
      return { code: `body:${entry.id}` };
    }
    const actualBody = file.source.slice(bodyStart, finallyBlock.end + 1);
    if (sha256(actualBody) !== entry.body.sha256) {
      return { code: `body:${entry.id}` };
    }
  }
  const controls = controlChain(file.source, mask, line.start);
  const expectedControls = entry.controls ?? [];
  if (controls.length !== expectedControls.length
    || controls.some((control, index) => control.sha256 !== expectedControls[index].sha256
      || control.raw !== expectedControls[index].raw)) {
    return { code: `control:${entry.id}` };
  }
  return {
    pin: {
      ...entry,
      unit: 'line',
      start: line.start,
      end: line.start + line.text.length - 1,
      path: entry.path,
      raw: line.text,
    },
  };
}

export function resolveInventory(files, inventory) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const pins = [];
  const offenders = [];
  const resolved = [];
  for (const entry of inventory.entries) {
    const file = byPath.get(entry.file);
    if (!file) {
      offenders.push({ code: `stale-entry:${entry.id}`, id: entry.id, file: entry.file });
      resolved.push({ id: entry.id, status: 'stale-entry' });
      continue;
    }
    const mask = maskSource(file.source);
    const regions = functionRegions(mask);
    const result = entry.unit === 'function'
      ? resolveFunctionEntry(file, mask, regions, entry)
      : resolveLineEntry(file, mask, regions, entry);
    if (result.code) {
      offenders.push({ code: result.code, id: entry.id, file: entry.file });
      resolved.push({ id: entry.id, status: result.code.split(':')[0] });
    } else {
      pins.push(result.pin);
      resolved.push({ id: entry.id, status: 'resolved' });
    }
  }
  return { pins, offenders, entries: resolved };
}

function covers(pin, filePath, index, rule) {
  if (pin.file !== filePath) return false;
  if (rule.lineOnly && pin.unit !== 'line') return false;
  return index >= pin.start && index <= pin.end;
}

function isReadContext(mask, index, token) {
  const before = mask.slice(0, index);
  if (before.trimEnd().endsWith('.')) return false;
  const after = mask.slice(index + token.length).trimStart();
  if (after.startsWith('(')) {
    const previous = /([A-Za-z_$][\w$]*)\s*$/.exec(before)?.[1] ?? '';
    return previous === 'new';
  }
  if (!after.startsWith('.')) return false;
  const member = /^\.([A-Za-z_$][\w$]*)\s*/.exec(after);
  if (!member) return false;
  if (!after.slice(member[0].length).startsWith('(')) return false;
  const methods = GLOBAL_MEMBER_METHODS[token];
  return Boolean(methods && methods.has(member[1]));
}

export function closureOffenders(files, inventory, pins) {
  const offenders = [];
  const globals = new Set(inventory.globalReadTokens ?? GLOBAL_READ_TOKENS);
  const rules = [...(inventory.census ?? DEFAULT_CENSUS)];
  for (const token of globals) {
    if (!rules.some((rule) => rule.token === token)) rules.push({ token, match: 'word' });
  }
  for (const file of files) {
    const mask = maskSource(file.source);
    for (const rule of rules) {
      for (const index of tokenIndexes(mask, rule)) {
        if (globals.has(rule.token)) {
          if (!isReadContext(mask, index, rule.token)) {
            offenders.push({
              code: `census:${rule.token}:${file.path}:${lineOf(file.source, index)}`,
              token: rule.token,
              path: file.path,
              line: lineOf(file.source, index),
            });
          }
          continue;
        }
        if (!pins.some((pin) => covers(pin, file.path, index, rule))) {
          offenders.push({
            code: `census:${rule.token}:${file.path}:${lineOf(file.source, index)}`,
            token: rule.token,
            path: file.path,
            line: lineOf(file.source, index),
          });
        }
      }
    }
    for (const specifier of moduleSpecifiers(file.source, mask)) {
      if (!(inventory.specifiers ?? DEFAULT_SPECIFIERS).includes(specifier.value)) continue;
      if (!pins.some((pin) => pin.file === file.path && pin.unit === 'line'
        && specifier.index >= pin.start && specifier.index <= pin.end)) {
        offenders.push({
          code: `census:${specifier.value}:${file.path}:${specifier.line}`,
          token: specifier.value,
          path: file.path,
          line: specifier.line,
        });
      }
    }
  }
  return offenders;
}

export function analyze(files, inventory) {
  const resolved = resolveInventory(files, inventory);
  const closure = closureOffenders(files, inventory, resolved.pins);
  return {
    ok: resolved.offenders.length === 0 && closure.length === 0,
    pins: resolved.pins,
    entries: resolved.entries,
    closure,
    inventory: resolved.offenders,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();
  const files = sourceFiles(root);
  process.stdout.write(`${JSON.stringify(candidateInventory(files), null, 2)}\n`);
}
