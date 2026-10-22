// TASK13(b): bind each timer allocation to its own reachable cleanup.
//
// The checker is intentionally narrow. It recognizes the reviewed setTimeout
// and timers/promises shapes and fails closed on anything else; it is not a
// general JavaScript analyzer.
import {
  callSites,
  enclosingFunction,
  finallyRanges,
  functionRanges,
  lineOf,
  maskSource,
} from './source-text.mjs';

const FORBIDDEN_TOKENS = ['setInterval', 'schtasks', 'Register-ScheduledTask'];

function ifBlocks(mask) {
  const blocks = [];
  const pattern = /\bif\s*\(/g;
  let match;
  while ((match = pattern.exec(mask)) !== null) {
    const open = match.index + match[0].lastIndexOf('(');
    const close = (() => {
      let depth = 0;
      for (let index = open; index < mask.length; index += 1) {
        if (mask[index] === '(') depth += 1;
        else if (mask[index] === ')') {
          depth -= 1;
          if (depth === 0) return index;
        }
      }
      return -1;
    })();
    if (close < 0) continue;
    const condition = mask.slice(open + 1, close).trim();
    let start = close + 1;
    while (start < mask.length && /\s/.test(mask[start])) start += 1;
    let end = start;
    if (mask[start] === '{') {
      let depth = 0;
      for (; end < mask.length; end += 1) {
        if (mask[end] === '{') depth += 1;
        else if (mask[end] === '}') {
          depth -= 1;
          if (depth === 0) {
            end += 1;
            break;
          }
        }
      }
    } else {
      let depth = 0;
      for (; end < mask.length; end += 1) {
        const char = mask[end];
        if (char === '(' || char === '[' || char === '{') depth += 1;
        else if (char === ')' || char === ']' || char === '}') depth -= 1;
        else if (char === ';' && depth === 0) {
          end += 1;
          break;
        }
      }
    }
    if (end > start) blocks.push({ condition, start, end });
  }
  return blocks;
}

function promiseTimerBindings(source) {
  const names = new Set();
  const offenders = [];
  const pattern = /import\s+([^;]+?)\s+from\s+'node:timers\/promises'/gs;
  for (const match of source.matchAll(pattern)) {
    const clause = match[1].trim();
    if (clause.startsWith('* as ')) {
      offenders.push({ reason: 'unsupported namespace promise-timer import' });
      continue;
    }
    const braces = /\{([^}]*)\}/.exec(clause);
    if (!braces) {
      offenders.push({ reason: 'unsupported promise-timer import' });
      continue;
    }
    for (const part of braces[1].split(',')) {
      const token = part.trim();
      if (!token) continue;
      const aliased = /^setTimeout\s+as\s+([A-Za-z_$][\w$]*)$/.exec(token);
      if (aliased) names.add(aliased[1]);
      else if (token === 'setTimeout') names.add('setTimeout');
      else offenders.push({ reason: `unsupported promise-timer import ${token}` });
    }
  }
  return { names, offenders };
}

function promiseTimerOffenders(source, mask, names) {
  const offenders = [];
  const functions = functionRanges(mask);
  const finals = finallyRanges(mask);
  for (const name of names) {
    for (const site of callSites(source, mask, [name])) {
      const before = mask.slice(Math.max(0, site.index - 120), site.index);
      const line = lineOf(source, site.index);
      if (/\b(?:return|await)\s*$/.test(before)) continue;

      if (/=>\s*$/.test(before)) {
        const statementStart = Math.max(
          mask.lastIndexOf(';', site.index),
          mask.lastIndexOf('{', site.index),
          mask.lastIndexOf('}', site.index),
        ) + 1;
        const assignment = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(
          mask.slice(statementStart, site.index),
        );
        if (assignment) {
          const awaited = new RegExp(`\\bawait\\s+${assignment[1]}\\s*\\(`).test(mask);
          if (awaited) continue;
        }
        offenders.push({ reason: `promise timer ${name} arrow result is not awaited`, line });
        continue;
      }

      const assignment = /(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before);
      if (!assignment) {
        offenders.push({ reason: `promise timer ${name} result is not joined`, line });
        continue;
      }
      const variable = assignment[1];
      const owner = enclosingFunction(mask, functions, site.index);
      const race = new RegExp(
        `Promise\\.race\\(\\s*\\[[^\\]]*\\b${variable}\\b[^\\]]*\\]\\s*\\)`,
      ).test(mask);
      const signal = /signal\s*:\s*([A-Za-z_$][\w$]*)\.signal/.exec(
        source.slice(site.open, site.close),
      );
      const controller = signal?.[1] ?? null;
      const abortedInFinally = controller
        ? finals.some((range) => new RegExp(
          `\\b${controller}\\.abort\\s*\\(`,
        ).test(mask.slice(range.start, range.end)))
        : false;
      const joinedRace = /(?:return\s+await\s+|await\s+)Promise\.race/.test(mask);
      if (owner && race && abortedInFinally && joinedRace) continue;
      offenders.push({
        reason: `promise timer ${name} assignment ${variable} is not joined or finally-cancelled`,
        line,
      });
    }
  }
  return offenders;
}

function rawTimerOffenders(source, mask) {
  const offenders = [];
  const functions = functionRanges(mask);
  const finals = finallyRanges(mask);
  const conditionals = ifBlocks(mask);
  const clears = callSites(source, mask, ['clearTimeout']);
  for (const site of callSites(source, mask, ['setTimeout'])) {
    const before = source.slice(Math.max(0, site.index - 160), site.index);
    const assignment = /([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before);
    if (!assignment) {
      offenders.push({
        reason: 'setTimeout without a handle', line: lineOf(source, site.index),
      });
      continue;
    }
    const handle = assignment[1];
    const allocationOwner = enclosingFunction(mask, functions, site.index);
    const forHandle = clears.filter((clear) => clear.args.trim() === handle);
    const accepted = forHandle.some((clear) => {
      const clearOwner = enclosingFunction(mask, functions, clear.index);
      if (!allocationOwner || !clearOwner) return false;
      const nested = clearOwner.start >= allocationOwner.start && clearOwner.end <= allocationOwner.end;
      if (!nested) return false;
      const conditional = conditionals.filter(
        (range) => clear.index >= range.start && clear.index < range.end,
      );
      if (conditional.some((range) => range.condition !== handle)) return false;
      const sameOwner = clearOwner.start === allocationOwner.start
        && clearOwner.end === allocationOwner.end;
      if (sameOwner) {
        return finals.some((range) => clear.index > range.start && clear.index < range.end);
      }
      const allocationName = allocationOwner.name;
      const methodName = clearOwner.name;
      const assigned = new RegExp(
        `(?:const|let|var)?\\s*([A-Za-z_$][\\w$]*)\\s*=\\s*${allocationName}\\s*\\(`,
      ).exec(mask);
      if (!assigned) return false;
      const variable = assigned[1];
      const call = new RegExp(`\\b${variable}\\.${methodName}\\s*\\(`);
      return finals.some((range) => call.test(mask.slice(range.start, range.end)));
    });
    if (!accepted) {
      offenders.push({
        reason: `${handle} is not cleared in a finally owned by its allocation`,
        line: lineOf(source, forHandle[0]?.index ?? site.index),
      });
    }
  }
  return offenders;
}

export function timerOffenders(files) {
  const offenders = [];
  for (const { path, source } of files) {
    const mask = maskSource(source);
    for (const token of FORBIDDEN_TOKENS) {
      const pattern = new RegExp(`\\b${token}\\b`);
      if (pattern.test(mask)) {
        offenders.push({ path, line: lineOf(source, mask.search(pattern)), reason: token });
      }
    }
    if (/\bdetached\s*:\s*true\b/.test(mask)) {
      offenders.push({ path, reason: 'detached: true' });
    }
    const bindings = promiseTimerBindings(source);
    for (const entry of bindings.offenders) offenders.push({ path, ...entry });
    for (const entry of promiseTimerOffenders(source, mask, bindings.names)) {
      offenders.push({ path, ...entry });
    }
    for (const entry of rawTimerOffenders(source, mask)) {
      offenders.push({ path, ...entry });
    }
  }
  return offenders;
}
