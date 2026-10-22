import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { emptySyncState } from './store.mjs';
import { addRemote, commitPaths, git, initGitRepo } from './git.mjs';

const FILES = Object.freeze([
  '.gitattributes',
  '.gitignore',
  'README.ko.md',
  'cards/.gitkeep',
  'sync/state.json',
]);

const GITATTRIBUTES = '* text=auto eol=lf\n';

const GITIGNORE = [
  '# Local runtime leftovers; never part of the data repo.',
  '*.tmp',
  '*.log',
  'Thumbs.db',
  'desktop.ini',
  '.DS_Store',
  '',
].join('\n');

const README = [
  '# 메멘토 카드 저장소',
  '',
  '이 저장소는 메멘토 카드의 단일 원본입니다. 카드는 `cards/` 아래에 한 장씩',
  '마크다운 파일로 저장되고, `sync/state.json`은 동기화 상태를 기록합니다.',
  '',
  '- `sync/` 아래 파일은 직접 편집하지 마세요. 메멘토가 자동으로 관리합니다.',
  '- 카드 파일은 UTF-8(LF)이며, 본문의 `## 원문`은 소유자의 원문 그대로입니다.',
  '- 카드 변경은 메멘토가 자동으로 커밋하고 이 저장소의 비공개 원격으로 푸시합니다.',
  '',
].join('\n');

function failure(code, extra = {}) {
  return { ok: false, code, ...extra };
}

async function alreadyInitialized(directory, remote) {
  const statePath = join(directory, 'sync', 'state.json');
  if (!existsSync(statePath)) return null;
  let repoId = null;
  try {
    repoId = JSON.parse(await readFile(statePath, 'utf8')).repoId ?? null;
  } catch {
    repoId = null;
  }
  const origin = await git(directory, ['remote', 'get-url', 'origin']);
  const actualRemote = origin.ok && origin.stdout.trim().length > 0 ? origin.stdout.trim() : null;
  return {
    ok: true,
    created: false,
    alreadyInitialized: true,
    dir: directory,
    repoId,
    remote: actualRemote ?? remote ?? null,
  };
}

async function writeIfAbsent(path, contents) {
  await writeFile(path, contents, { encoding: 'utf8', flag: 'wx' });
}

export async function initRepo(options = {}) {
  if (typeof options.dir !== 'string' || options.dir.length === 0) return failure('BAD_REQUEST');
  const directory = resolve(options.dir);
  const remote = typeof options.remote === 'string' && options.remote.length > 0 ? options.remote : null;
  const repoId = options.repoId ?? randomUUID();

  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory);
  if (entries.length > 0) {
    const existing = await alreadyInitialized(directory, remote);
    if (existing) return existing;
    return failure('NOT_EMPTY', { dir: directory });
  }

  const initialized = await initGitRepo(directory);
  if (!initialized.ok) return failure('GIT_INIT_FAILED', { dir: directory, git: initialized });
  if (remote) {
    const added = await addRemote(directory, remote);
    if (!added.ok) return failure('REMOTE_FAILED', { dir: directory, git: added });
  }

  try {
    await writeIfAbsent(join(directory, '.gitattributes'), GITATTRIBUTES);
    await writeIfAbsent(join(directory, '.gitignore'), GITIGNORE);
    await writeIfAbsent(join(directory, 'README.ko.md'), README);
    await mkdir(join(directory, 'cards'), { recursive: true });
    await mkdir(join(directory, 'sync'), { recursive: true });
    await writeIfAbsent(join(directory, 'cards', '.gitkeep'), '');
    const state = emptySyncState(repoId);
    await writeIfAbsent(join(directory, 'sync', 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    if (error?.code === 'EEXIST') return failure('ALREADY_INITIALIZED', { dir: directory });
    throw error;
  }

  const commit = await commitPaths(directory, FILES, 'memento: init\n');
  if (!commit.ok) return failure(commit.code ?? 'COMMIT_FAILED', { dir: directory, commit });
  const head = await git(directory, ['rev-parse', 'HEAD']);
  return {
    ok: true,
    created: true,
    dir: directory,
    repoId,
    remote,
    commit: {
      hash: commit.hash ?? (head.ok ? head.stdout.trim() : null),
      short: commit.hash ? commit.hash.slice(0, 7) : null,
    },
    files: [...FILES],
  };
}

export { initRepo as init };
