#!/usr/bin/env node
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.mjs';

const CODEC = new URL('../src/card/codec.mjs', import.meta.url);
const DISCORD_CLIENT = new URL('../src/discord/client.mjs', import.meta.url);
const WIKI_SCANNER = new URL('../src/wiki/scan.mjs', import.meta.url);
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

Options:
  --parse <file>            Parse a card file with src/card/codec.mjs.
  --discord                 Check the Discord bot token (reads the configured tokenFile).
  --base-url <url>          Discord API base URL for --discord (default https://discord.com/api/v10).
  --root <dir>              Wiki root for wiki-scan (read-only).
  --out <dir>               Output directory for wiki-scan; it must be outside --root and
                            must not already contain any wiki-scan output (never overwritten).
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
  if ((values.root !== undefined || values.out !== undefined) && command !== 'wiki-scan') {
    console.error('--root and --out need wiki-scan');
    return 2;
  }
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
