#!/usr/bin/env node
/**
 * Moves the preserved Hermes Discord bot token into the dedicated memento secret
 * file without ever printing it. The token is read, checked with GET /users/@me
 * and only then written. The source .env is opened read-only and hashed before
 * and after.
 *
 * CLI:
 *   node src/probe/token-move.mjs --env <hermes.env> --token-file <secret> \
 *     [--base-url https://discord.com/api/v10] [--receipt <json>]
 *
 * stdout on success is exactly {"key","length","sha256First8"}.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const DEFAULT_BASE_URL = 'https://discord.com/api/v10';
export const TOKEN_KEY_PATTERN = /DISCORD.*TOKEN|BOT_TOKEN/i;
const USER_AGENT = 'DiscordBot (https://github.com/grim-susemi/piomo-memento-mod, 0.1.0)';
const REDACTED = '[redacted]';

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function redact(text, token) {
  const value = String(text ?? '');
  return token ? value.split(token).join(REDACTED) : value;
}

function stripValue(raw) {
  let value = String(raw ?? '').trim();
  if (value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1);
  }
  return value.replaceAll('\r', '').trim();
}

export function parseEnv(text) {
  const entries = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).replace(/^export\s+/i, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    entries.push({ key, value: stripValue(line.slice(separator + 1)) });
  }
  return entries;
}

export function selectTokenEntry(entries) {
  const matches = entries.filter(entry => TOKEN_KEY_PATTERN.test(entry.key));
  if (matches.length === 0) return { ok: false, reason: 'no-token-key' };
  if (matches.length > 1) return { ok: false, reason: 'multiple-token-keys' };
  if (!matches[0].value) return { ok: false, reason: 'empty-token' };
  return { ok: true, entry: matches[0] };
}

/** One GET /users/@me with an in-memory token; the token never enters a URL. */
export function checkBotToken({ token, baseUrl = DEFAULT_BASE_URL, timeoutMs = 10_000 }) {
  return new Promise(resolvePromise => {
    let target;
    try {
      target = new URL(`${baseUrl.replace(/\/+$/, '')}/users/@me`);
    } catch {
      resolvePromise({ ok: false, reason: 'bad-base-url' });
      return;
    }
    const secure = target.protocol === 'https:';
    const agent = secure
      ? new HttpsAgent({ keepAlive: true, maxSockets: 1 })
      : new HttpAgent({ keepAlive: true, maxSockets: 1 });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      agent.destroy();
      resolvePromise(result);
    };
    let request;
    try {
      request = (secure ? httpsRequest : httpRequest)(target, {
        method: 'GET',
        agent,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bot ${token}`,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            finish({ ok: true, status });
            return;
          }
          finish({
            ok: false,
            status,
            reason: status === 401 || status === 403 ? 'forbidden' : 'http',
            code: null,
          });
        });
        response.on('error', error => finish({
          ok: false, reason: 'unreachable', message: redact(error.message, token),
        }));
      });
    } catch (error) {
      finish({ ok: false, reason: 'unreachable', message: redact(error.message, token) });
      return;
    }
    request.on('error', error => finish({
      ok: false,
      reason: error?.name === 'AbortError' ? 'timeout' : 'unreachable',
      message: redact(error.message, token),
    }));
    request.end();
  });
}

function writeSecret(tokenFile, token) {
  const directory = dirname(tokenFile);
  mkdirSync(directory, { recursive: true });
  const temporary = `${tokenFile}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temporary, token, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, tokenFile);
}

/**
 * Reads the .env, selects exactly one bot token key, checks it, then writes it
 * to tokenFile with no BOM and no trailing newline. Returns safe fields only.
 */
export async function moveToken({
  envPath, tokenFile, baseUrl = DEFAULT_BASE_URL, timeoutMs = 10_000,
}) {
  let before;
  try {
    before = readFileSync(envPath);
  } catch (error) {
    return { ok: false, reason: 'env-missing', code: error?.code ?? 'io' };
  }
  const envSha256Before = sha256Bytes(before);
  const entries = parseEnv(before.toString('utf8'));
  const keyNames = entries.map(entry => entry.key);
  const selection = selectTokenEntry(entries);
  if (!selection.ok) return { ok: false, reason: selection.reason, keyNames };
  const { key, value } = selection.entry;

  const checked = await checkBotToken({ token: value, baseUrl, timeoutMs });
  if (!checked.ok) {
    return {
      ok: false, reason: checked.reason, status: checked.status ?? null,
      key, keyNames, envSha256Before,
      envSha256After: sha256Bytes(readFileSync(envPath)),
    };
  }

  const afterCheck = readFileSync(envPath);
  const envSha256After = sha256Bytes(afterCheck);
  if (envSha256After !== envSha256Before) {
    return { ok: false, reason: 'env-changed-during-check', key, keyNames,
      envSha256Before, envSha256After, envUnchanged: false };
  }

  let reused = false;
  if (existsSync(tokenFile)) {
    const current = readFileSync(tokenFile, 'utf8');
    if (current !== value) {
      return { ok: false, reason: 'token-file-differs', key, keyNames,
        envSha256Before, envSha256After, envUnchanged: true };
    }
    reused = true;
  } else {
    try {
      writeSecret(tokenFile, value);
    } catch (error) {
      return { ok: false, reason: 'token-write-failed', key, keyNames,
        code: error?.code ?? 'io', envSha256Before, envSha256After,
        envUnchanged: true };
    }
  }

  const finalBytes = readFileSync(envPath);
  const envFinal = sha256Bytes(finalBytes);
  return {
    ok: true,
    key,
    length: value.length,
    sha256First8: sha256Bytes(Buffer.from(value, 'utf8')).slice(0, 8),
    envSha256Before,
    envSha256After: envFinal,
    envUnchanged: envFinal === envSha256Before,
    tokenFile,
    wrote: !reused,
    reused,
  };
}

function writeReceipt(path, value) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, path);
}

function safeReceipt(result) {
  return {
    key: result.key,
    length: result.length,
    sha256First8: result.sha256First8,
    envSha256Before: result.envSha256Before,
    envSha256After: result.envSha256After,
    envUnchanged: result.envUnchanged,
    tokenFile: result.tokenFile,
    wrote: result.wrote,
    reused: result.reused,
  };
}

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        env: { type: 'string' },
        'token-file': { type: 'string' },
        'base-url': { type: 'string' },
        receipt: { type: 'string' },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (!values.env || !values['token-file']) {
    console.error('usage: token-move.mjs --env <file> --token-file <file> [--base-url <url>] [--receipt <file>]');
    return 2;
  }
  const result = await moveToken({
    envPath: resolve(values.env),
    tokenFile: resolve(values['token-file']),
    ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
  });
  if (!result.ok) {
    if (result.reason === 'forbidden') {
      console.log(`token: forbidden (${result.status})`);
    } else if (result.reason === 'no-token-key' || result.reason === 'multiple-token-keys') {
      console.log(JSON.stringify({ reason: result.reason, keyNames: result.keyNames }));
    } else {
      console.log(`token: ${result.reason}`);
    }
    return result.reason === 'forbidden' ? 1 : 2;
  }
  writeReceipt(values.receipt ? resolve(values.receipt) : null, safeReceipt(result));
  console.log(JSON.stringify({
    key: result.key,
    length: result.length,
    sha256First8: result.sha256First8,
  }));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
