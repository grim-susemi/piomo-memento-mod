#!/usr/bin/env node
/**
 * Leak scan: counts token and extra string occurrences in files, directories and
 * `git log -p --all` output. It prints counts per path only; the values and the
 * matching content never enter the output.
 */
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;

function occurrences(haystack, needle) {
  if (!needle || needle.length === 0) return 0;
  const source = Buffer.isBuffer(haystack) ? haystack : Buffer.from(haystack, 'utf8');
  const target = Buffer.isBuffer(needle) ? needle : Buffer.from(needle, 'utf8');
  let count = 0;
  let offset = 0;
  for (;;) {
    const index = source.indexOf(target, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + target.length;
  }
}

function safeSecrets(token, strings) {
  const values = [];
  if (typeof token === 'string' && token.length > 0) values.push(token);
  for (const value of strings ?? []) {
    if (typeof value === 'string' && value.length > 0) values.push(value);
  }
  return values;
}

function scanFile(path, secrets) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return { path, matches: 0, skipped: 'symlink' };
  if (!info.isFile()) return { path, matches: 0, skipped: 'not-file' };
  if (info.size > MAX_FILE_BYTES) return { path, matches: 0, skipped: 'too-large', bytes: info.size };
  const bytes = readFileSync(path);
  let matches = 0;
  for (const secret of secrets) matches += occurrences(bytes, secret);
  return { path, matches, bytes: bytes.length };
}

function scanPath(path, secrets, output, seen) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    output.push({ path, matches: 0, skipped: 'symlink' });
    return;
  }
  if (info.isDirectory()) {
    const entries = readdirSync(path, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      scanPath(join(path, entry.name), secrets, output, seen);
    }
    return;
  }
  if (seen.has(path)) return;
  seen.add(path);
  output.push(scanFile(path, secrets));
}

async function scanGit(repository, secrets, options) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repository, 'log', '-p', '--all', '--no-color'],
      {
        encoding: 'buffer',
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
        },
      },
    );
    let matches = 0;
    for (const secret of secrets) matches += occurrences(stdout, secret);
    return { repository, matches };
  } catch (error) {
    return {
      repository,
      matches: 0,
      error: error?.code === 'ENOENT' ? 'git-missing' : 'git-failed',
    };
  }
}

/**
 * @returns {{matches:number, perPath:Array, perRepo:Array, secretsChecked:number}}
 */
export async function leakScan({
  token, paths = [], gitRepos = [], strings = [], maxBuffer,
}) {
  const secrets = safeSecrets(token, strings);
  const perPath = [];
  const seen = new Set();
  const pathErrors = [];
  for (const path of paths) {
    try {
      scanPath(path, secrets, perPath, seen);
    } catch (error) {
      pathErrors.push({ path, error: error?.code ?? 'io' });
    }
  }
  const perRepo = [];
  for (const repository of gitRepos) {
    perRepo.push(await scanGit(repository, secrets, { maxBuffer }));
  }
  const matches = perPath.reduce((total, entry) => total + entry.matches, 0)
    + perRepo.reduce((total, entry) => total + entry.matches, 0);
  return { matches, perPath, perRepo, pathErrors, secretsChecked: secrets.length };
}
