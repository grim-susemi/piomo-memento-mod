import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function probeStatePath(outDir) {
  return join(outDir, 'probe-state.json');
}

export function probePartialPath(outDir) {
  return join(outDir, 'probe-partial.json');
}

export function probeJsonPath(outDir) {
  return join(outDir, 'probe.json');
}

export async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeTextAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, path);
}

export async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function nowIso(now) {
  return new Date(now()).toISOString();
}
