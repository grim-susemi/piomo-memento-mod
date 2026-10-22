#!/usr/bin/env node
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, resolveAgentDir } from '../src/config.mjs';

const CODEC = new URL('../src/card/codec.mjs', import.meta.url);
const DISCORD_CLIENT = new URL('../src/discord/client.mjs', import.meta.url);
const WIKI_SCANNER = new URL('../src/wiki/scan.mjs', import.meta.url);
const PROBE = new URL('../src/probe/probe.mjs', import.meta.url);
const LEAK_SCAN = new URL('../src/probe/leak-scan.mjs', import.meta.url);
const STORE_INIT = new URL('../src/store/init.mjs', import.meta.url);
const OUTPUT_FILES = [
  'wiki-hash-before.json',
  'wiki-hash-after.json',
  'wiki-candidates.json',
  'wiki-candidates.md',
  'wiki-counts.json',
];

const USAGE = `Usage: memento <command> [options]

Commands:
  doctor [--parse <file>] [--discord]  Print the config state, parse one card file,
                                       or check the Discord bot with GET /users/@me.
  wiki-scan --root <dir> --out <dir>   Scan the old wiki read-only: hash every file,
                                       list at most 50 ranked candidates and the
                                       broken-Korean exclusions outside the wiki.
  probe --out <dir> [--forum-id <id>]  Run or resume the approved live Discord probe.
                                       Setup stops at the owner app-action boundary.
                                       --prepare-only runs all bot-only stages and
                                       deletes the disposable probe post before stopping.
  leak-scan --token-file <file> --paths <file-or-dir>...
                                       Count token and extra-string occurrences in
                                       files, directories and git history; prints
                                       counts only, never a match.
  init <dir> [--remote <url>]          Create the card data repository and its
                                       initial commit locally; never pushes.

Options:
  --parse <file>            Parse a card file with src/card/codec.mjs.
  --discord                 Check the Discord bot token (reads the configured tokenFile).
  --base-url <url>          Discord API base URL for --discord (default https://discord.com/api/v10).
  --root <dir>              Wiki root for wiki-scan (read-only).
  --out <dir>               Output directory for wiki-scan or probe; wiki-scan refuses an
                            existing output set, probe resumes from its own state file.
  --remote <url>            Initial remote URL for init (git remote add origin; no push).
  --forum-id <id>           Existing forum channel for probe (after owner creation).
  --phase <mode>            Probe phase: auto, setup or owner (default auto).
  --prepare-only            Probe: after setup, delete the disposable probe post and
                            leave a prepared state for the owner ceremony.
  --agent-dir <dir>         Agent dir for the probe secret/config (default from the environment).
  --repo-path <dir>         Data repo path written to config.json when probe completes.
  --audit-reads <n>         Probe audit reads at the owner boundary (default 3, max 10).
  --audit-interval-ms <n>   Delay between those reads (default 20000).
  --token-file <file>       Token file for leak-scan.
  --paths <path>            leak-scan path (repeatable).
  --git <repo>              leak-scan git repository (repeatable).
  --also <file>             leak-scan extra strings file, one string per line.
  --help                    Show this help.

Exit codes: 0 ok, 1 check or output failed, 2 unreadable or bad usage, 3 parse/client/scanner unavailable.
`;

function printConfigState() {
  const config = loadConfig();
  if (config.state === 'configured') {
    console.log(`memento: configured (repo ${config.repoPath}, remote ${config.remote ?? 'none'})`);
    return 0;
  }
  console.log(`memento: ${config.state} (${config.reason})`);
  return 0;
}

async function printParse(file) {
  const target = resolve(file);
  let bytes;
  try {
    bytes = await readFile(target);
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'missing' : 'io';
    console.log(`unreadable: ${reason}`);
    return 2;
  }
  if (!existsSync(CODEC)) {
    console.log('parse unavailable: src/card/codec.mjs is not installed yet');
    return 3;
  }
  const { parse } = await import(pathToFileURL(fileURLToPath(CODEC)).href);
  const result = parse(bytes);
  if (result?.unreadable) {
    console.log(`unreadable: ${result.reason}`);
    return 2;
  }
  const card = result?.card ?? {};
  console.log(`card: ${card.id ?? 'unknown'} (${card.status ?? 'unknown'})`);
  return 0;
}

async function printDiscordCheck(baseUrl) {
  const config = loadConfig();
  if (config.state !== 'configured') {
    console.log(`discord: unconfigured (${config.reason})`);
    return 2;
  }
  if (!existsSync(DISCORD_CLIENT)) {
    console.log('discord: unavailable (src/discord/client.mjs is not installed yet)');
    return 3;
  }
  const { createDiscordClient } = await import(pathToFileURL(fileURLToPath(DISCORD_CLIENT)).href);
  const client = createDiscordClient({
    tokenFile: config.tokenFile,
    ...(baseUrl ? { baseUrl } : {}),
  });
  const result = await client.getMe();
  if (result.ok) {
    console.log(`discord: ok (${result.data?.username ?? 'unknown'} ${result.data?.id ?? 'unknown'})`);
    return 0;
  }
  if (result.forbidden) {
    console.log(`discord: forbidden (${result.status})`);
    return 1;
  }
  if (result.gone) {
    console.log(`discord: gone (${result.status})`);
    return 1;
  }
  if (result.status === 429) {
    console.log('discord: rate-limited (429)');
    return 1;
  }
  if (result.error === 'token-missing') {
    console.log('discord: token-missing');
    return 2;
  }
  console.log(`discord: unreachable (${result.error ?? result.status ?? 'unknown'})`);
  return 1;
}

function markdownCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function candidatesMarkdown(candidates) {
  const lines = [
    '| n | folder | status | updated_at | title | path |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of candidates.rows) {
    lines.push(`| ${row.n} | ${markdownCell(row.folder)} | ${markdownCell(row.status)} | ${markdownCell(row.updated_at)} | ${markdownCell(row.title)} | ${markdownCell(row.path)} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function writeJson(target, value) {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function existingOutputs(outPath) {
  const found = [];
  for (const name of OUTPUT_FILES) {
    const target = join(outPath, name);
    try {
      lstatSync(target);
      found.push(target);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
  }
  return found;
}

async function runWikiScan(root, out) {
  const rootPath = resolve(root);
  const outPath = resolve(out);
  if (!existsSync(WIKI_SCANNER)) {
    console.log('wiki-scan unavailable: src/wiki/scan.mjs is not installed yet');
    return 3;
  }
  let rootStat;
  try {
    rootStat = await stat(rootPath);
  } catch (error) {
    console.log(`wiki-scan: root missing (${error?.code ?? 'io'}): ${rootPath}`);
    return 2;
  }
  if (!rootStat.isDirectory()) {
    console.log(`wiki-scan: root is not a directory: ${rootPath}`);
    return 2;
  }

  const { assertOutOutsideRoot, hashTree, manifestsEqual, scanWiki } = await import(
    pathToFileURL(fileURLToPath(WIKI_SCANNER)).href,
  );
  try {
    assertOutOutsideRoot(rootPath, outPath);
  } catch (error) {
    console.log(`wiki-scan: ${error.message}`);
    return 2;
  }

  const existing = existingOutputs(outPath);
  if (existing.length > 0) {
    console.log(`wiki-scan: refusing to overwrite existing output files: ${existing.join(', ')}`);
    return 2;
  }
  try {
    await mkdir(outPath, { recursive: true });
  } catch (error) {
    console.error(`wiki-scan failed: ${error?.code ?? error?.message ?? 'unknown'}`);
    return 1;
  }

  try {
    const before = hashTree(rootPath);
    await writeJson(join(outPath, 'wiki-hash-before.json'), before);
    const scan = scanWiki(rootPath);
    const candidates = {
      schema: 'memento.wiki-candidates.v1',
      root: rootPath,
      counts: scan.counts,
      rows: scan.rows,
      excludedBroken: scan.excludedBroken,
    };
    await writeJson(join(outPath, 'wiki-candidates.json'), candidates);
    await writeFile(join(outPath, 'wiki-candidates.md'), candidatesMarkdown(candidates), { flag: 'wx' });
    await writeJson(join(outPath, 'wiki-counts.json'), scan.counts);
    const after = hashTree(rootPath);
    await writeJson(join(outPath, 'wiki-hash-after.json'), after);

    const stable = manifestsEqual(before, after);
    console.log(`wiki-scan: root ${rootPath}`);
    console.log(`wiki-scan: out ${outPath}`);
    console.log(`wiki-scan: files ${before.coverage.total} (hashed ${before.coverage.hashed}, unreadable ${before.coverage.unreadable.length}, symlinks ${before.coverage.symlinksSkipped.length})`);
    for (const entry of before.coverage.unreadable) {
      console.log(`wiki-scan: unreadable ${entry.path} (${entry.code})`);
    }
    console.log(`wiki-scan: scanned ${scan.counts.scanned} pool ${scan.counts.pool} excludedBroken ${scan.counts.excludedBroken} rows ${scan.counts.rows}`);
    for (const entry of scan.excludedBroken) {
      console.log(`wiki-scan: excluded ${entry.path} [${entry.reasons.join(',')}]`);
    }
    console.log(`wiki-scan: stable ${stable}`);
    console.log('wiki-scan: wrote wiki-hash-before.json wiki-hash-after.json wiki-candidates.json wiki-candidates.md wiki-counts.json');
    return stable ? 0 : 1;
  } catch (error) {
    console.error(`wiki-scan failed: ${error?.code ?? error?.message ?? 'unknown'}`);
    return 1;
  }
}

async function runProbeCommand(values) {
  if (values.out === undefined || values.out.length === 0) {
    console.error('probe needs --out <dir>');
    return 2;
  }
  const phase = values.phase ?? 'auto';
  if (!['auto', 'setup', 'owner'].includes(phase)) {
    console.error('--phase must be auto, setup or owner');
    return 2;
  }
  const auditReads = values['audit-reads'] === undefined ? 3 : Number(values['audit-reads']);
  if (!Number.isInteger(auditReads) || auditReads < 1 || auditReads > 10) {
    console.error('--audit-reads must be an integer from 1 to 10');
    return 2;
  }
  const auditIntervalMs = values['audit-interval-ms'] === undefined
    ? 20_000
    : Number(values['audit-interval-ms']);
  if (!Number.isFinite(auditIntervalMs) || auditIntervalMs < 0) {
    console.error('--audit-interval-ms must be a non-negative number');
    return 2;
  }
  const agentDir = values['agent-dir'] ? resolve(values['agent-dir']) : resolveAgentDir(process.env);
  if (!agentDir) {
    console.log('probe: agent-dir-unknown');
    return 2;
  }
  const config = loadConfig({ agentDir });
  const tokenFile = config.state === 'configured'
    ? config.tokenFile
    : join(agentDir, 'memento', 'secrets', 'discord-bot-token');
  const repoPath = values['repo-path']
    ? resolve(values['repo-path'])
    : (config.state === 'configured' ? config.repoPath : null);
  if (!existsSync(tokenFile)) {
    console.log('discord: token-missing');
    return 2;
  }
  if (!existsSync(PROBE)) {
    console.log('probe: unavailable');
    return 3;
  }
  const { runProbe } = await import(pathToFileURL(fileURLToPath(PROBE)).href);
  const { createDiscordClient } = await import(pathToFileURL(fileURLToPath(DISCORD_CLIENT)).href);
  const client = createDiscordClient({
    tokenFile,
    ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
  });
  const outDir = resolve(values.out);
  const result = await runProbe({
    client,
    outDir,
    tokenFile,
    agentDir,
    repoPath,
    ...(values['forum-id'] ? { forumId: values['forum-id'] } : {}),
    phase,
    auditReads,
    auditIntervalMs,
    prepareOnly: Boolean(values['prepare-only']),
  });
  if (result.code === 0) {
    console.log(`probe: complete${result.alreadyComplete ? ' (already complete)' : ''}`);
    console.log(`probe: probe.json ${join(outDir, 'probe.json')}`);
    return 0;
  }
  if (result.reason === 'discord-forbidden') {
    console.log(`discord: forbidden (${result.status})`);
    return 1;
  }
  if (result.reason === 'discord-unavailable') {
    console.log(`discord: unreachable (${result.status ?? result.error ?? 'unknown'})`);
    return 1;
  }
  if (result.phase === 'prepared-awaiting-owner') {
    console.log('probe: prepared; disposable posts deleted; owner ceremony pending');
    console.log(`probe: forum ${result.fields?.forumId ?? 'unknown'} tags ${Object.keys(result.fields?.tagIds ?? {}).length}`);
    console.log(`probe: see ${join(outDir, 'owner-action.md')}`);
    return 4;
  }
  if (result.code === 4) {
    console.log(`probe: ${result.reason ?? result.phase}`);
    if (result.reason === 'forum-create-requires-manage-channels') {
      console.log(`probe: see ${join(outDir, 'owner-create-forum.md')}`);
    } else {
      console.log(`probe: see ${join(outDir, 'owner-action.md')}`);
    }
    if (result.fields?.probePostId) console.log(`probe: probe post ${result.fields.probePostId}`);
    if (result.fields?.forumId) console.log(`probe: forum ${result.fields.forumId}`);
    return 4;
  }
  if (result.code === 5) {
    console.log(`probe: owner action not visible yet (${result.reason ?? 'waiting'})`);
    console.log(`probe: see ${join(outDir, 'owner-action.md')}`);
    return 5;
  }
  console.log(`probe: stopped (${result.reason ?? 'unknown'})`);
  return 1;
}

async function runLeakScanCommand(values) {
  if (!values['token-file']) {
    console.error('leak-scan needs --token-file <file>');
    return 2;
  }
  const paths = values.paths ?? [];
  if (paths.length === 0) {
    console.error('leak-scan needs at least one --paths <file-or-dir>');
    return 2;
  }
  let token;
  try {
    token = (await readFile(resolve(values['token-file']), 'utf8')).trim();
  } catch {
    console.log('token-missing');
    return 2;
  }
  if (token.length === 0) {
    console.log('token-missing');
    return 2;
  }
  let strings = [];
  if (values.also) {
    try {
      strings = (await readFile(resolve(values.also), 'utf8'))
        .split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    } catch {
      console.log('strings-missing');
      return 2;
    }
  }
  if (!existsSync(LEAK_SCAN)) {
    console.log('leak-scan: unavailable');
    return 3;
  }
  const { leakScan } = await import(pathToFileURL(fileURLToPath(LEAK_SCAN)).href);
  const result = await leakScan({
    token,
    paths: paths.map(path => resolve(path)),
    gitRepos: (values.git ?? []).map(path => resolve(path)),
    strings,
  });
  for (const entry of result.perPath) {
    console.log(`${entry.path}: matches ${entry.matches}${entry.skipped ? ` (${entry.skipped})` : ''}`);
  }
  for (const entry of result.pathErrors) {
    console.log(`${entry.path}: error ${entry.error}`);
  }
  for (const entry of result.perRepo) {
    console.log(`git ${entry.repository}: matches ${entry.matches}${entry.error ? ` (${entry.error})` : ''}`);
  }
  console.log(`matches ${result.matches}`);
  return result.matches === 0 && result.pathErrors.length === 0 ? 0 : 1;
}

async function runInitCommand(values, positionals) {
  const dir = positionals[1];
  if (!dir || positionals.length > 2) {
    console.error('init needs exactly one <dir>');
    return 2;
  }
  if (!existsSync(STORE_INIT)) {
    console.log('init: unavailable (src/store/init.mjs is not installed yet)');
    return 3;
  }
  const { initRepo } = await import(pathToFileURL(fileURLToPath(STORE_INIT)).href);
  let result;
  try {
    result = await initRepo({ dir, remote: values.remote ?? null });
  } catch (error) {
    console.error(`init failed: ${error?.code ?? error?.message ?? 'unknown'}`);
    return 1;
  }
  if (!result.ok) {
    console.error(`init: ${result.code}${result.dir ? ` (${result.dir})` : ''}`);
    return 2;
  }
  console.log(`memento: ${result.alreadyInitialized ? 'already initialized' : 'initialized'} ${result.dir}`);
  if (result.commit?.short) console.log(`memento: initial commit ${result.commit.short}`);
  if (result.remote) console.log(`memento: remote ${result.remote}`);
  return 0;
}

async function main(argv) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean' },
        parse: { type: 'string' },
        discord: { type: 'boolean' },
        'base-url': { type: 'string' },
        root: { type: 'string' },
        out: { type: 'string' },
        'forum-id': { type: 'string' },
        phase: { type: 'string' },
        'agent-dir': { type: 'string' },
        'repo-path': { type: 'string' },
        'audit-reads': { type: 'string' },
        'audit-interval-ms': { type: 'string' },
        'prepare-only': { type: 'boolean' },
        'token-file': { type: 'string' },
        paths: { type: 'string', multiple: true },
        git: { type: 'string', multiple: true },
        also: { type: 'string' },
        remote: { type: 'string' },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const command = positionals[0];
  const baseUrl = values['base-url'];
  if (values.root !== undefined && command !== 'wiki-scan') {
    console.error('--root needs wiki-scan');
    return 2;
  }
  if (values.out !== undefined && command !== 'wiki-scan' && command !== 'probe') {
    console.error('--out needs wiki-scan or probe');
    return 2;
  }
  if (values.remote !== undefined && command !== 'init') {
    console.error('--remote needs init');
    return 2;
  }
  if (values['prepare-only'] && command !== 'probe') {
    console.error('--prepare-only needs probe');
    return 2;
  }
  if (command === 'init') return runInitCommand(values, positionals);
  if (command === 'probe') return runProbeCommand(values);
  if (command === 'leak-scan') return runLeakScanCommand(values);
  if (command === 'wiki-scan') {
    if (values.root === undefined || values.root.length === 0) {
      console.error('wiki-scan needs --root <dir>');
      return 2;
    }
    if (values.out === undefined || values.out.length === 0) {
      console.error('wiki-scan needs --out <dir>');
      return 2;
    }
    return runWikiScan(values.root, values.out);
  }
  if (command === 'doctor') {
    if (values.parse !== undefined) {
      if (values.parse.length === 0) {
        console.error('--parse needs a file path');
        return 2;
      }
      return printParse(values.parse);
    }
    if (values.discord) {
      if (baseUrl !== undefined && baseUrl.length === 0) {
        console.error('--base-url needs a URL');
        return 2;
      }
      return printDiscordCheck(baseUrl);
    }
    if (baseUrl !== undefined) {
      console.error('--base-url needs --discord');
      return 2;
    }
    return printConfigState();
  }
  if (command === undefined) {
    console.error(USAGE);
    return 2;
  }
  console.error(`unknown command: ${command}`);
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
