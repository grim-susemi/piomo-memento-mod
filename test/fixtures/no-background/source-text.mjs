// Source-text helpers for TASK13's static proofs. They are deliberately small:
// mask comments/strings/regexes, then inspect real code tokens and braces.
const REGEX_KEYWORDS = new Set([
  'return', 'case', 'throw', 'typeof', 'instanceof', 'in', 'of', 'new',
  'delete', 'void', 'yield', 'await',
]);

function regexAllowed(prevChar, prevWord) {
  if (!prevChar) return true;
  if ('(=:[,!&|?{};'.includes(prevChar)) return true;
  return REGEX_KEYWORDS.has(prevWord);
}

/** Same-length text with comments, strings, templates and regexes blanked. */
export function maskSource(source) {
  const out = [...source];
  const length = source.length;
  const blank = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (out[index] !== '\n' && out[index] !== '\r') out[index] = ' ';
    }
  };
  let index = 0;
  let prevChar = '';
  let prevWord = '';
  while (index < length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      let end = index + 2;
      while (end < length && source[end] !== '\n') end += 1;
      blank(index, end);
      index = end;
      continue;
    }
    if (char === '/' && next === '*') {
      let end = index + 2;
      while (end < length && !(source[end] === '*' && source[end + 1] === '/')) end += 1;
      end = Math.min(length, end + 2);
      blank(index, end);
      index = end;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      let end = index + 1;
      while (end < length) {
        if (source[end] === '\\') {
          end += 2;
          continue;
        }
        if (source[end] === quote) {
          end += 1;
          break;
        }
        end += 1;
      }
      blank(index, end);
      index = end;
      prevChar = quote;
      prevWord = '';
      continue;
    }
    if (char === '/' && regexAllowed(prevChar, prevWord)) {
      let end = index + 1;
      let inClass = false;
      while (end < length) {
        const current = source[end];
        if (current === '\\') {
          end += 2;
          continue;
        }
        if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) {
          end += 1;
          break;
        } else if (current === '\n') {
          break;
        }
        end += 1;
      }
      while (end < length && /[a-z]/i.test(source[end])) end += 1;
      blank(index, end);
      index = end;
      prevChar = '/';
      prevWord = '';
      continue;
    }
    if (!/\s/.test(char)) {
      if (/[A-Za-z0-9_$]/.test(char)) {
        let end = index;
        while (end < length && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
        prevWord = source.slice(index, end);
        prevChar = source[end - 1];
        index = end;
        continue;
      }
      prevChar = char;
      prevWord = '';
    }
    index += 1;
  }
  return out.join('');
}

export function findMatching(text, openIndex, openChar, closeChar) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === openChar) depth += 1;
    else if (text[index] === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function callSites(source, mask, names) {
  const wanted = new Set(names);
  const sites = [];
  const pattern = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = pattern.exec(mask)) !== null) {
    if (!wanted.has(match[1])) continue;
    const open = match.index + match[0].lastIndexOf('(');
    const close = findMatching(mask, open, '(', ')');
    if (close < 0) continue;
    sites.push({
      name: match[1],
      index: match.index,
      open,
      close,
      args: source.slice(open + 1, close).trim(),
    });
  }
  return sites;
}

export function functionRanges(mask) {
  const ranges = [];
  const seen = new Set();
  const add = (name, bodyStart, bodyEnd, kind) => {
    const key = `${bodyStart}:${bodyEnd}`;
    if (seen.has(key)) return;
    seen.add(key);
    ranges.push({ name, start: bodyStart, end: bodyEnd, kind });
  };
  const declarations = /\bfunction\b\s*([A-Za-z_$][\w$]*)?\s*\(/g;
  let match;
  while ((match = declarations.exec(mask)) !== null) {
    const openParen = match.index + match[0].lastIndexOf('(');
    const closeParen = findMatching(mask, openParen, '(', ')');
    if (closeParen < 0) continue;
    let body = closeParen + 1;
    while (body < mask.length && /\s/.test(mask[body])) body += 1;
    if (mask[body] !== '{') continue;
    const end = findMatching(mask, body, '{', '}');
    if (end >= 0) add(match[1] ?? 'anonymous', body, end, 'function');
  }
  const methods = /(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  while ((match = methods.exec(mask)) !== null) {
    const name = match[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'with', 'function'].includes(name)) continue;
    const openParen = match.index + match[0].lastIndexOf('(');
    const closeParen = findMatching(mask, openParen, '(', ')');
    if (closeParen < 0) continue;
    let body = closeParen + 1;
    while (body < mask.length && /\s/.test(mask[body])) body += 1;
    if (mask[body] !== '{') continue;
    const end = findMatching(mask, body, '{', '}');
    if (end >= 0) add(name, body, end, 'method');
  }
  return ranges;
}

export function enclosingFunction(mask, ranges, index) {
  return ranges
    .filter((range) => index > range.start && index < range.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0] ?? null;
}

export function finallyRanges(mask) {
  const ranges = [];
  const pattern = /\bfinally\b/g;
  let match;
  while ((match = pattern.exec(mask)) !== null) {
    let open = -1;
    for (let index = match.index + match[0].length; index < mask.length; index += 1) {
      if (mask[index] === '{') {
        open = index;
        break;
      }
      if (mask[index] === ';') break;
    }
    if (open < 0) continue;
    const end = findMatching(mask, open, '{', '}');
    if (end >= 0) ranges.push({ start: open, end });
  }
  return ranges;
}

export function lineOf(source, index) {
  if (!Number.isInteger(index) || index < 0) return 0;
  return source.slice(0, index).split('\n').length;
}

export function absoluteUrls(source) {
  const result = [];
  const lines = source.split('\n');
  let inBlock = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      inBlock = !trimmed.includes('*/');
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    const code = line.includes(' // ') ? line.slice(0, line.indexOf(' // ')) : line;
    for (const match of code.matchAll(/https?:\/\/[^\s'"`)]+/g)) {
      result.push({ line: index + 1, text: line, value: match[0] });
    }
  }
  return result;
}
