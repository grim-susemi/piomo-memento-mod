#!/usr/bin/env node
import { appendFileSync, existsSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, resolveAgentDir } from '../src/config.mjs';

const CODEC = new URL('../src/card/codec.mjs', import.meta.url);
const DISCORD_CLIENT = new URL('../src/discord/client.mjs', import.meta.url);
const WIKI_SCANNER = new URL('../src/wiki/scan.mjs', import.meta.url);
const WIKI_IMPORT = new URL('../src/wiki/import.mjs', import.meta.url);
const PROBE = new URL('../src/probe/probe.mjs', import.meta.url);
const LEAK_SCAN = new URL('../src/probe/leak-scan.mjs', import.meta.url);
const STORE_INIT = new URL('../src/store/init.mjs', import.meta.url);
const STORE = new URL('../src/store/store.mjs', import.meta.url);
const INTAKE_SESSION = new URL('../src/intake/session.mjs', import.meta.url);
const RECEIPTS = new URL('../src/receipts.mjs', import.meta.url);
const SYNC = new URL('../src/sync/run.mjs', import.meta.url);
const STORE_GIT = new URL('../src/store/git.mjs', import.meta.url);
const ROUNDTRIP = new URL('../src/doctor/roundtrip.mjs', import.meta.url);
const OUTPUT_FILES = [
  'wiki-hash-before.json',
  'wiki-hash-after.json',
  'wiki-candidates.json',
  'wiki-candidates.md',
  'wiki-counts.json',
];

const USAGE = `Usage: memento <command> [options]

Commands:
  doctor [--parse <file>] [--discord] [--roundtrip --work <dir> --input <file>]
                                       Print the config state, parse one card file,
                                       check the Discord bot, or prove the UTF-8
                                       card round trip through a real write, commit,
                                       clone, API read and fake Discord post.
  sync [--repo <dir>] [--discord-base <url>] [--pid-log <file>]
                                       Run one session-start sync. Without --repo the
                                       configured repo is used; the loopback fake URL
                                       and child PID log are QA-only options.
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
  capture-from-session --session <jsonl> --items <json>
                                       Create cards for seeding from one session:
                                       every original must copy text from one
                                       user row verbatim. No push or Discord call.
  wiki-import --candidates <file> --pick <rows> [--root <dir>]
                                       Import picked old-wiki candidate rows as
                                       idea cards; never writes under the wiki.

Options:
  --parse <file>            Parse a card file with src/card/codec.mjs.
  --discord                 Check the Discord bot token (reads the configured tokenFile).
  --roundtrip               Doctor: run the UTF-8 card round trip.
  --work <dir>              Doctor roundtrip: work directory for the temporary repo.
  --input <file>            Doctor roundtrip: UTF-8 input file (never passed as an argument).
  --repo <dir>              sync: data repository to use instead of the configured one.
  --discord-base <url>      sync: Discord API base URL (loopback fake for QA).
  --pid-log <file>          sync: write each child spawn/exit event as JSONL.
  --base-url <url>          Discord API base URL for --discord (default https://discord.com/api/v10).
  --root <dir>              Wiki root for wiki-scan (read-only).
  --out <dir>               Output directory for wiki-scan or probe; wiki-scan refuses an
                            existing output set, probe resumes from its own state file.
  --remote <url>            Initial remote URL for init (git remote add origin; no push).
  --session <file>          Session JSONL for capture-from-session.
  --candidates <file>       wiki-candidates.json for wiki-import.
  --pick <rows>             Comma-separated candidate row numbers for wiki-import.
  --items <file>            UTF-8 JSON items for capture-from-session (array or {items}).
  --forum-id <id>           Existing forum channel for probe (after owner creation).
  --phase <mode>            Probe phase: auto, setup or owner (default auto).
  --prepare-only            Probe: after setup, delete the disposable probe post and
                            leave a prepared state for the owner ceremony.
  --agent-dir <dir>         Agent dir for the probe secret/config (default from the environment).
  --repo-path <dir>         Data repo path written to config.json when probe completes.
  --audit-reads <n>         Probe audit reads at the owner boundary (default 3, max 10).
  --audit-interval-ms <n>   Delay between those reads (default 20000).
  --token-file <file>       Token file for leak-scan or sync.
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

async function runRoundtripCommand(values) {
  if (values.work === undefined || values.work.length === 0
    || values.input === undefined || values.input.length === 0) {
    console.error('doctor --roundtrip needs --work <dir> --input <utf8 file>');
    return 2;
  }
  if (!existsSync(ROUNDTRIP)) {
    console.log('roundtrip: unavailable (src/doctor/roundtrip.mjs is not installed yet)');
    return 3;
  }
  const { runRoundtrip } = await import(pathToFileURL(fileURLToPath(ROUNDTRIP)).href);
  let result;
  try {
    result = await runRoundtrip({ workDir: values.work, inputFile: values.input });
  } catch (error) {
    console.error(`roundtrip failed: ${error?.code ?? error?.message ?? 'unknown'}`);
    return 1;
  }
  if (!result.ok) {
    console.log(`roundtrip: failed (${result.error ?? 'mismatch'}${result.status ? ` ${result.status}` : ''})`);
  }
  console.log(`bytesEqual ${result.bytesEqual === true}, replacementChars ${result.replacementChars ?? -1}`);
  return result.ok ? 0 : 1;
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

async function runCaptureFromSessionCommand(values) {
  if (!values.session || !values.items) {
    console.error('capture-from-session needs --session <file> --items <file>');
    return 2;
  }
  const config = loadConfig();
  if (config.state !== 'configured') {
    console.log(`memento: ${config.state} (${config.reason})`);
    return 2;
  }
  if (!existsSync(INTAKE_SESSION) || !existsSync(STORE) || !existsSync(RECEIPTS)) {
    console.log('capture-from-session: unavailable');
    return 3;
  }
  const { captureFromSessionFile } = await import(pathToFileURL(fileURLToPath(INTAKE_SESSION)).href);
  const { openStore } = await import(pathToFileURL(fileURLToPath(STORE)).href);
  const { createReceipts } = await import(pathToFileURL(fileURLToPath(RECEIPTS)).href);
  let result;
  try {
    result = await captureFromSessionFile({
      store: openStore(config.repoPath),
      sessionFile: values.session,
      itemsFile: values.items,
      receipts: createReceipts({ agentDir: config.agentDir }),
      config,
    });
  } catch (error) {
    console.error(`capture-from-session failed: ${error?.code ?? error?.name ?? 'error'}`);
    return 1;
  }
  if (!result.ok) {
    console.log(`capture-from-session: ${result.error}`);
    return result.code === 'SESSION_UNREADABLE' || result.code === 'ITEMS_INVALID' || result.code === 'REPO_UNINITIALIZED'
      ? 2
      : 1;
  }
  for (const entry of result.created) console.log(`card: ${entry.id} (${entry.discordState})`);
  for (const entry of result.skipped) console.log(`skipped: duplicate ${entry.id}`);
  for (const entry of result.rejected) console.log(`rejected: ${entry.error}`);
  console.log(`memento: created ${result.created.length} skipped ${result.skipped.length} rejected ${result.rejected.length}`);
  return result.rejected.length === 0 ? 0 : 1;
}

async function runWikiImportCommand(values) {
  if (!values.candidates || !values.pick) {
    console.error('wiki-import needs --candidates <file> --pick <rows>');
    return 2;
  }
  if (!existsSync(WIKI_IMPORT)) {
    console.log('wiki-import: unavailable (src/wiki/import.mjs is not installed yet)');
    return 3;
  }
  let candidates;
  try {
    candidates = JSON.parse(await readFile(resolve(values.candidates), 'utf8'));
  } catch (error) {
    console.log(`wiki-import: candidates unreadable (${error?.code ?? 'invalid'})`);
    return 2;
  }
  if (!candidates || !Array.isArray(candidates.rows)) {
    console.log('wiki-import: candidates file has no rows array');
    return 2;
  }
  const config = loadConfig();
  if (config.state !== 'configured') {
    console.log(`memento: ${config.state} (${config.reason})`);
    return 2;
  }
  if (!existsSync(STORE)) {
    console.log('wiki-import: unavailable');
    return 3;
  }
  const root = values.root ?? candidates.root;
  if (!root) {
    console.error('wiki-import needs --root <dir>');
    return 2;
  }
  const beforeFile = join(dirname(resolve(values.candidates)), 'wiki-hash-before.json');
  let beforeHashes = null;
  try {
    const parsed = JSON.parse(await readFile(beforeFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
      beforeHashes = parsed;
    }
  } catch {
    beforeHashes = null;
  }
  if (!beforeHashes) {
    console.log(`wiki-import: scan before-manifest missing or unreadable (${beforeFile}); run wiki-scan first`);
    return 2;
  }
  const { openStore } = await import(pathToFileURL(fileURLToPath(STORE)).href);
  const { importPickedRows, WikiImportError } = await import(
    pathToFileURL(fileURLToPath(WIKI_IMPORT)).href,
  );
  let result;
  try {
    result = await importPickedRows({
      store: openStore(config.repoPath),
      root,
      rows: candidates.rows,
      pick: values.pick,
      beforeHashes,
      repoDir: config.repoPath,
    });
  } catch (error) {
    if (error instanceof WikiImportError
      && (error.code === 'BAD_PICK' || error.code === 'REPO_INSIDE_WIKI')) {
      console.log(`wiki-import: ${error.message}`);
      return 2;
    }
    console.error(`wiki-import failed: ${error?.code ?? error?.message ?? 'unknown'}`);
    return 1;
  }
  for (const entry of result.created) console.log(`card: ${entry.id} (row ${entry.n})`);
  for (const entry of result.skipped) {
    console.log(`skipped: row ${entry.n} ${entry.reason}${entry.id ? ` ${entry.id}` : ''}${entry.pattern ? ` (${entry.pattern})` : ''}`);
  }
  for (const entry of result.failed) console.log(`failed: row ${entry.n} ${entry.code}`);
  console.log(`memento: created ${result.created.length} skipped ${result.skipped.length} failed ${result.failed.length}`);
  console.log(`wiki-import: hashes ${result.hashesEqual ? 'equal' : 'CHANGED'}`);
  return result.failed.length === 0 && result.hashesEqual ? 0 : 1;
}

async function runSyncCommand(values) {
  if (values.repo !== undefined && values.repo.length === 0) {
    console.error('sync: --repo needs a directory');
    return 2;
  }
  if (values['discord-base'] !== undefined && values['discord-base'].length === 0) {
    console.error('sync: --discord-base needs a URL');
    return 2;
  }
  if (values['pid-log'] !== undefined && values['pid-log'].length === 0) {
    console.error('sync: --pid-log needs a file');
    return 2;
  }
  if (!existsSync(SYNC)) {
    console.log('sync: unavailable (src/sync/run.mjs is not installed yet)');
    return 3;
  }
  const repoArg = values.repo ? resolve(values.repo) : null;
  const discordBase = values['discord-base'];
  const pidLog = values['pid-log'] ? resolve(values['pid-log']) : null;
  let config;
  let tempRoot = null;
  let stopObserver = null;
  let pidError = null;
  try {
    if (repoArg) {
      if (discordBase !== undefined
        && !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v10$/.test(discordBase)
        && !values['token-file']) {
        console.error('sync: --token-file is required when --discord-base is not a loopback fake');
        return 2;
      }
      tempRoot = await mkdtemp(join(tmpdir(), 'memento-sync-cli-'));
      const tokenFile = values['token-file']
        ? resolve(values['token-file'])
        : join(tempRoot, 'discord-token');
      if (!values['token-file']) {
        await writeFile(tokenFile, 'synthetic-discord-token\n', 'utf8');
      }
      const agentDir = values['agent-dir'] ? resolve(values['agent-dir']) : join(tempRoot, 'agent');
      config = {
        state: 'configured',
        reason: '',
        agentDir,
        configPath: join(agentDir, 'memento', 'config.json'),
        repoPath: repoArg,
        tokenFile,
        remote: null,
      };
    } else {
      config = loadConfig();
      if (config.state !== 'configured') {
        console.log(`memento: ${config.state} (${config.reason})`);
        return 2;
      }
    }
    if (pidLog) {
      await mkdir(dirname(pidLog), { recursive: true });
      await writeFile(pidLog, '', 'utf8');
      const { observeChildProcesses } = await import(pathToFileURL(fileURLToPath(STORE_GIT)).href);
      observeChildProcesses((event) => {
        if (!event || typeof event !== 'object') return;
        try {
          appendFileSync(pidLog, `${JSON.stringify(event)}\n`, 'utf8');
        } catch (error) {
          pidError = String(error?.code ?? error?.message ?? error);
        }
      });
      stopObserver = () => observeChildProcesses(null);
    }
    const { runSync } = await import(pathToFileURL(fileURLToPath(SYNC)).href);
    const { createDiscordClient } = await import(pathToFileURL(fileURLToPath(DISCORD_CLIENT)).href);
    const { createReceipts } = await import(pathToFileURL(fileURLToPath(RECEIPTS)).href);
    const client = createDiscordClient({
      tokenFile: config.tokenFile,
      ...(discordBase ? { baseUrl: discordBase } : {}),
    });
    const result = await runSync({
      reason: 'command',
      config,
      client,
      receipts: createReceipts({ agentDir: config.agentDir }),
    });
    if (pidError) {
      console.error(`sync: pid-log write failed (${pidError})`);
      return 1;
    }
    if (result.ok) {
      console.log(`sync: ok runs ${result.runs ?? 0} discord ${result.discord ?? 'unknown'} push ${result.push ?? 'unknown'}`);
      return 0;
    }
    console.log(`sync: ${result.skipped ?? result.reason ?? 'failed'} runs ${result.runs ?? 0}`);
    return 1;
  } catch (error) {
    console.error(`sync failed: ${error?.code ?? error?.message ?? 'unknown'}`);
    return 1;
  } finally {
    stopObserver?.();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
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
        roundtrip: { type: 'boolean' },
        work: { type: 'string' },
        input: { type: 'string' },
        repo: { type: 'string' },
        'discord-base': { type: 'string' },
        'pid-log': { type: 'string' },
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
        session: { type: 'string' },
        items: { type: 'string' },
        candidates: { type: 'string' },
        pick: { type: 'string' },
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
  if (values.root !== undefined && command !== 'wiki-scan' && command !== 'wiki-import') {
    console.error('--root needs wiki-scan or wiki-import');
    return 2;
  }
  if (values.candidates !== undefined && command !== 'wiki-import') {
    console.error('--candidates needs wiki-import');
    return 2;
  }
  if (values.pick !== undefined && command !== 'wiki-import') {
    console.error('--pick needs wiki-import');
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
  if (values.session !== undefined && command !== 'capture-from-session') {
    console.error('--session needs capture-from-session');
    return 2;
  }
  if (values.items !== undefined && command !== 'capture-from-session') {
    console.error('--items needs capture-from-session');
    return 2;
  }
  if (values['prepare-only'] && command !== 'probe') {
    console.error('--prepare-only needs probe');
    return 2;
  }
  if (values.roundtrip && command !== 'doctor') {
    console.error('--roundtrip needs doctor');
    return 2;
  }
  if ((values.work !== undefined || values.input !== undefined)
    && !(command === 'doctor' && values.roundtrip)) {
    console.error('--work and --input need doctor --roundtrip');
    return 2;
  }
  if (values.repo !== undefined && command !== 'sync') {
    console.error('--repo needs sync');
    return 2;
  }
  if (values['discord-base'] !== undefined && command !== 'sync') {
    console.error('--discord-base needs sync');
    return 2;
  }
  if (values['pid-log'] !== undefined && command !== 'sync') {
    console.error('--pid-log needs sync');
    return 2;
  }
  if (values['token-file'] !== undefined && command !== 'leak-scan' && command !== 'sync') {
    console.error('--token-file needs leak-scan or sync');
    return 2;
  }
  if (command === 'init') return runInitCommand(values, positionals);
  if (command === 'capture-from-session') return runCaptureFromSessionCommand(values);
  if (command === 'wiki-import') return runWikiImportCommand(values);
  if (command === 'probe') return runProbeCommand(values);
  if (command === 'leak-scan') return runLeakScanCommand(values);
  if (command === 'sync') return runSyncCommand(values);
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
    if (values.roundtrip) {
      if (values.parse !== undefined || values.discord) {
        console.error('--roundtrip cannot be combined with --parse or --discord');
        return 2;
      }
      return runRoundtripCommand(values);
    }
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
