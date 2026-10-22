// TASK13(f): prove the actual target consumed by each request, reject
// unaccounted intervening writes and unknown request sites, and keep the
// board's presentation URL as an explicitly pending owner decision.
import {
  absoluteUrls,
  callSites,
  enclosingFunction,
  findMatching,
  functionRanges,
  lineOf,
  maskSource,
} from './source-text.mjs';

const BASE = 'https://discord.com/api/v10';
const PROJECT = 'https://github.com/grim-susemi/piomo-memento-mod';
const LOOPBACK = 'http://127.0.0.1';
const PRESENTATION = 'https://discord.com/channels/';
const PRESENTATION_TEMPLATE = 'https://discord.com/channels/${guildId}/${card.discordThread}';

function add(offenders, path, reason, line = 0) {
  offenders.push({ path, reason, ...(line > 0 ? { line } : {}) });
}

function rangeByName(mask, name) {
  return functionRanges(mask).find((range) => range.name === name) ?? null;
}

function targetFlowOffenders(source, mask, path) {
  const offenders = [];
  if (path === 'src/discord/client.mjs') {
    const requestOnce = rangeByName(mask, 'requestOnce');
    const call = rangeByName(mask, 'call');
    if (!requestOnce || !call) {
      add(offenders, path, 'missing requestOnce/call target-flow functions');
      return offenders;
    }
    const body = source.slice(requestOnce.start, requestOnce.end);
    const constructions = [...body.matchAll(/target\s*=\s*new URL\(url\)\s*;/g)];
    const requests = [...body.matchAll(
      /\(\s*secure\s*\?\s*httpsRequest\s*:\s*httpRequest\s*\)\s*\(\s*target\s*,/g,
    )];
    if (constructions.length !== 1 || requests.length !== 1) {
      add(offenders, path, 'unsupported request target construction/invocation count');
      return offenders;
    }
    const constructionAt = requestOnce.start + constructions[0].index;
    const requestAt = requestOnce.start + requests[0].index;
    if (constructionAt >= requestAt) {
      add(offenders, path, 'request target is consumed before construction');
    }
    const beforeConstruction = source.slice(requestOnce.start, constructionAt);
    if (/\burl\s*=/.test(beforeConstruction)) {
      add(offenders, path, 'url is reassigned before the target construction');
    }
    const between = source.slice(constructionAt + constructions[0][0].length, requestAt);
    const unsupportedTarget = [...between.matchAll(/\btarget\b(?!\s*\.\s*protocol\b)/g)];
    if (unsupportedTarget.length > 0) {
      add(offenders, path, 'target is written or read in an unapproved way between construction and request');
    }
    const callBody = source.slice(call.start, call.end);
    const urlAssignments = [...callBody.matchAll(/\burl\s*=\s*joinUrl\(baseUrl,\s*path\)\s*\+\s*querySuffix\(spec\.query\)\s*;/g)];
    if (urlAssignments.length !== 1) {
      add(offenders, path, 'url is not assigned exactly once from joinUrl(baseUrl, path)');
    }
    const urlWrites = [...callBody.matchAll(/\burl\s*=/g)];
    if (urlWrites.length !== 1) {
      add(offenders, path, 'call has unaccounted url writes');
    }
    const requestCalls = callSites(source, mask, ['requestOnce']).filter((site) => {
      const before = source.slice(Math.max(0, site.index - 20), site.index);
      return site.index > call.start && site.index < call.end && /\bawait\s+$/.test(before);
    });
    if (requestCalls.length !== 1) {
      add(offenders, path, 'call does not await exactly one requestOnce invocation');
    } else if (!/(?:^|[,{]\s*)url\s*(?:,|})/.test(requestCalls[0].args)) {
      add(offenders, path, 'requestOnce does not receive the constructed url');
    }
    const baseAssignments = [...source.matchAll(/\bbaseUrl\s*=\s*options\.baseUrl\s*\?\?\s*DEFAULT_BASE_URL\s*;/g)];
    if (baseAssignments.length !== 1) {
      add(offenders, path, 'baseUrl is not assigned exactly once from options.baseUrl ?? DEFAULT_BASE_URL');
    }
  }

  if (path === 'src/probe/token-move.mjs') {
    const checkBotToken = rangeByName(mask, 'checkBotToken');
    if (!checkBotToken) {
      add(offenders, path, 'missing checkBotToken target-flow function');
      return offenders;
    }
    const body = source.slice(checkBotToken.start, checkBotToken.end);
    const constructions = [...body.matchAll(
      /target\s*=\s*new URL\(\s*`\$\{baseUrl\.replace\([^`]+\)\}\/users\/@me`\s*\)\s*;/g,
    )];
    const requests = [...body.matchAll(
      /\(\s*secure\s*\?\s*httpsRequest\s*:\s*httpRequest\s*\)\s*\(\s*target\s*,/g,
    )];
    if (constructions.length !== 1 || requests.length !== 1) {
      add(offenders, path, 'unsupported request target construction/invocation count');
      return offenders;
    }
    const constructionAt = checkBotToken.start + constructions[0].index;
    const requestAt = checkBotToken.start + requests[0].index;
    if (constructionAt >= requestAt) {
      add(offenders, path, 'request target is consumed before construction');
    }
    const between = source.slice(constructionAt + constructions[0][0].length, requestAt);
    const unsupportedTarget = [...between.matchAll(/\btarget\b(?!\s*\.\s*protocol\b)/g)];
    if (unsupportedTarget.length > 0) {
      add(offenders, path, 'target is written or read in an unapproved way between construction and request');
    }
    if (/\bbaseUrl\s*=/.test(body)) {
      add(offenders, path, 'baseUrl is reassigned in checkBotToken');
    }
  }
  return offenders;
}

export function requestOffenders(files) {
  const offenders = [];
  const presentation = [];
  const byPath = new Map(files.map((file) => [file.path, file.source]));
  for (const { path, source } of files) {
    const mask = maskSource(source);
    const functions = functionRanges(mask);

    for (const token of ['completion', 'openai', 'anthropic', 'ollama']) {
      const pattern = token === 'completion'
        ? /\bcompletion\s*\(/
        : new RegExp(`\\b${token}\\b`, 'i');
      if (pattern.test(source)) {
        add(offenders, path, `forbidden model source string ${token}`, lineOf(source, source.search(pattern)));
      }
    }

    for (const name of ['httpsRequest', 'httpRequest', 'fetch']) {
      for (const site of callSites(source, mask, [name])) {
        add(offenders, path, `unapproved request call ${name}`, lineOf(source, site.index));
      }
    }
    if (/https?\.request\s*\(/.test(mask)) {
      add(offenders, path, 'unapproved https/http.request call');
    }

    const approvedPattern = /\(\s*secure\s*\?\s*httpsRequest\s*:\s*httpRequest\s*\)\s*\(/g;
    const approved = [...source.matchAll(approvedPattern)];
    const expected = path === 'src/discord/client.mjs' ? 1
      : path === 'src/probe/token-move.mjs' ? 1 : 0;
    if (approved.length !== expected) {
      add(offenders, path, `approved request call count ${approved.length}, expected ${expected}`);
    }
    for (const match of approved) {
      const open = match.index + match[0].lastIndexOf('(');
      const close = findMatching(mask, open, '(', ')');
      const args = close < 0 ? '' : source.slice(open + 1, close).trim();
      if (!args.startsWith('target,')) {
        add(offenders, path, 'request first argument is not target', lineOf(source, match.index));
      }
      const owner = enclosingFunction(mask, functions, match.index);
      const expectedOwner = path === 'src/discord/client.mjs' ? 'requestOnce' : 'checkBotToken';
      if (owner?.name !== expectedOwner) {
        add(offenders, path, `request call outside ${expectedOwner}`, lineOf(source, match.index));
      }
    }

    for (const token of ['httpsRequest', 'httpRequest']) {
      const count = (mask.match(new RegExp(`\\b${token}\\b`, 'g')) ?? []).length;
      const maximum = (path === 'src/discord/client.mjs' || path === 'src/probe/token-move.mjs') ? 2 : 0;
      if (count > maximum) add(offenders, path, `extra ${token} reference`);
    }

    for (const site of callSites(source, mask, ['URL'])) {
      const before = mask.slice(Math.max(0, site.index - 8), site.index);
      if (!/\bnew\s+$/.test(before)) continue;
      const owner = enclosingFunction(mask, functions, site.index);
      const args = site.args;
      let allowed = false;
      if (path === 'bin/memento.mjs') {
        allowed = /^'\.\.\/[^']+'\s*,\s*import\.meta\.url$/.test(args);
      } else if (path === 'src/discord/client.mjs') {
        allowed = args === 'url' && owner?.name === 'requestOnce';
      } else if (path === 'src/probe/token-move.mjs') {
        allowed = /^`\$\{baseUrl\.replace\([^`]+\)\}\/users\/@me`$/.test(args)
          && owner?.name === 'checkBotToken';
      } else if (path === 'src/discord/fake-server.mjs') {
        allowed = /^request\.url\s*,\s*'http:\/\/127\.0\.0\.1'$/.test(args);
      }
      if (!allowed) {
        add(offenders, path, `unapproved new URL target: ${args.slice(0, 60)}`, lineOf(source, site.index));
      }
    }

    for (const literal of absoluteUrls(source)) {
      const value = literal.value.replace(/[),.;]+$/, '');
      const approvedPresentation = path === 'src/api.mjs'
        && value === PRESENTATION_TEMPLATE
        && /^\s*discord\.url\s*=\s*`/.test(literal.text);
      if (approvedPresentation) {
        presentation.push({
          status: 'approved-423A',
          path,
          line: literal.line,
          value,
          scope: 'existing card discord.url presentation template only; no other display or request literal',
        });
        continue;
      }
      const allowed = value.startsWith(BASE)
        || value.startsWith(PROJECT)
        || value.startsWith(LOOPBACK);
      if (!allowed) {
        add(offenders, path, `unapproved URL literal ${value}`, literal.line);
      }
    }

    if (/\b(hostname|host)\s*:/.test(mask)) add(offenders, path, 'request host option');
    if ((path === 'src/discord/client.mjs' || path === 'src/probe/token-move.mjs')
      && !source.includes(`DEFAULT_BASE_URL = '${BASE}'`)) {
      add(offenders, path, 'DEFAULT_BASE_URL is not the approved Discord API base');
    }
  }

  for (const file of files) {
    for (const entry of targetFlowOffenders(file.source, maskSource(file.source), file.path)) {
      offenders.push(entry);
    }
  }

  const client = byPath.get('src/discord/client.mjs') ?? '';
  for (const needle of [
    'options.baseUrl ?? DEFAULT_BASE_URL',
    'joinUrl(baseUrl, path)',
    'target = new URL(url);',
    '(secure ? httpsRequest : httpRequest)(target,',
  ]) {
    if (!client.includes(needle)) {
      add(offenders, 'src/discord/client.mjs', `missing target flow: ${needle}`);
    }
  }
  const tokenMove = byPath.get('src/probe/token-move.mjs') ?? '';
  for (const needle of [
    'baseUrl = DEFAULT_BASE_URL',
    'target = new URL(`',
    '(secure ? httpsRequest : httpRequest)(target,',
  ]) {
    if (!tokenMove.includes(needle)) {
      add(offenders, 'src/probe/token-move.mjs', `missing target flow: ${needle}`);
    }
  }
  const api = byPath.get('src/api.mjs') ?? '';
  const presentationLines = api.split('\n').filter((line) => line.includes(PRESENTATION));
  if (presentationLines.length !== 1
    || !presentationLines[0].trim().startsWith('discord.url = `')) {
    add(offenders, 'src/api.mjs', 'channels URL is not the single discord.url presentation link');
  }
  if (presentation.length !== 1) {
    add(offenders, 'src/api.mjs', 'expected exactly one 423A discord.url presentation literal');
  }
  return { offenders, presentationLiteral: presentation[0] ?? null };
}
