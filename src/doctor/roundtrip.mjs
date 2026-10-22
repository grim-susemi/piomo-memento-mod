// Doctor roundtrip: prove that an owner's UTF-8 text survives the real
// card write, git commit, clone, board API projection and fake Discord post.
//
// Every step is the production implementation: the store commits the card, git
// clones the repository, the board API reads the clone, and the Discord client
// posts to an in-process loopback fake. No stub stands in for a step.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createBoardApi } from '../api.mjs';
import { normalizeIntake, parse, serialize } from '../card/codec.mjs';
import { STATUS_KEYS, STATUS_LABELS } from '../card/status.mjs';
import { createDiscordClient } from '../discord/client.mjs';
import { startFakeDiscord } from '../discord/fake-server.mjs';
import { initRepo } from '../store/init.mjs';
import { openStore } from '../store/store.mjs';
import { git } from '../store/git.mjs';
import { composePostContent, extractPostOriginal, markerLine } from '../sync/threads.mjs';

const TOKEN = 'synthetic-roundtrip-token';
const NOW = Date.parse('2026-10-22T00:00:00.000Z');

function replacementCount(value) {
  let count = 0;
  for (const char of value) if (char === '\uFFFD') count += 1;
  return count;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function runRoundtrip({ workDir, inputFile } = {}) {
  if (typeof workDir !== 'string' || workDir.length === 0) {
    throw new TypeError('roundtrip needs a work directory');
  }
  if (typeof inputFile !== 'string' || inputFile.length === 0) {
    throw new TypeError('roundtrip needs an input file');
  }
  await mkdir(resolve(workDir), { recursive: true });
  const root = await mkdtemp(join(resolve(workDir), 'memento-roundtrip-'));
  let api = null;
  let fake = null;
  try {
    let inputBytes;
    try {
      inputBytes = await readFile(resolve(inputFile));
    } catch {
      return { ok: false, error: 'input-unreadable' };
    }
    let decoded;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(inputBytes);
    } catch {
      return { ok: false, error: 'input-not-utf8' };
    }
    const expected = normalizeIntake(decoded);
    const expectedBytes = Buffer.from(expected, 'utf8');
    if (replacementCount(expected) !== 0) {
      return { ok: false, error: 'input-replacement-char' };
    }

    const repo = join(root, 'repo');
    const clonePath = join(root, 'clone');
    const init = await initRepo({ dir: repo });
    if (!init.ok) return { ok: false, error: 'repo-init', code: init.code };
    const store = openStore(repo, { now: NOW, rand: () => Buffer.from([1, 2, 3]) });
    const created = await store.create({
      title: '왕복 시험',
      description: 'UTF-8 왕복 시험',
      original: expected,
      source: 'paste',
      sourceRef: 'doctor:roundtrip',
      via: 'paste',
      actor: 'owner',
    });
    if (!created.ok) return { ok: false, error: 'card-create', code: created.code };
    const cardPath = join(repo, created.file);
    const cardBytes = await readFile(cardPath);
    const cardParsed = parse(cardBytes);
    if (cardParsed.unreadable) {
      return { ok: false, error: 'card-parse', reason: cardParsed.reason };
    }
    const cardBytesEqual = cardBytes.equals(Buffer.from(serialize(cardParsed.card), 'utf8'));
    const cardOriginalEqual = cardParsed.card.original === expected;
    const commit = await git(repo, ['rev-parse', 'HEAD']);
    if (!commit.ok) return { ok: false, error: 'commit-missing' };

    const cloned = await git(root, ['clone', '--no-hardlinks', '--quiet', repo, clonePath]);
    if (!cloned.ok) return { ok: false, error: 'clone-failed', detail: cloned.stderr };
    const cloneBytes = await readFile(join(clonePath, created.file));
    const cloneBytesEqual = cloneBytes.equals(cardBytes);
    const cloneParsed = parse(cloneBytes);
    if (cloneParsed.unreadable) {
      return { ok: false, error: 'clone-parse', reason: cloneParsed.reason };
    }
    const cloneOriginalEqual = cloneParsed.card.original === expected;

    fake = await startFakeDiscord({ token: TOKEN });
    const tokenFile = join(root, 'discord-token');
    await writeFile(tokenFile, `${TOKEN}\n`, 'utf8');
    const client = createDiscordClient({ tokenFile, baseUrl: fake.baseUrl, clock: fake.clock });
    api = createBoardApi({
      config: { repoPath: clonePath, tokenFile, baseUrl: fake.baseUrl },
      client,
      now: fake.clock.now,
    });
    const state = api.state();
    const projected = state.cards.find((card) => card.id === created.id);
    if (!projected) return { ok: false, error: 'api-card-missing' };
    const apiBytesEqual = projected.original === expected;

    const forum = await client.createForumChannel({
      guildId: fake.ids.guildId,
      name: '메멘토',
      tags: STATUS_KEYS.map((key) => STATUS_LABELS[key]),
    });
    if (!forum.ok) return { ok: false, error: 'forum-create', status: forum.status };
    const ideaTag = forum.data.available_tags.find((tag) => tag.name === STATUS_LABELS.idea)?.id;
    const marker = markerLine(created.id, 'doctor-roundtrip', init.repoId);
    const post = composePostContent({ title: projected.title, original: projected.original, marker });
    const posted = await client.createForumPost({
      forumId: forum.data.id,
      name: projected.title,
      content: post.content,
      ...(ideaTag ? { appliedTags: [ideaTag] } : {}),
    });
    if (!posted.ok) return { ok: false, error: 'post-failed', status: posted.status };
    const starter = await client.getStarterMessage(posted.data.id);
    if (!starter.ok) return { ok: false, error: 'readback-failed', status: starter.status };
    const readback = extractPostOriginal(starter.data.content, projected.title, { line: marker });
    const readbackBytes = Buffer.from(readback, 'utf8');
    const bytesEqual = readbackBytes.equals(expectedBytes);
    const discordBytesEqual = readback === expected;
    const replacementChars = replacementCount(readback)
      + replacementCount(projected?.original ?? '')
      + replacementCount(cardParsed.card.original ?? '')
      + replacementCount(cloneParsed.card.original ?? '');

    return {
      ok: bytesEqual
        && replacementChars === 0
        && cardBytesEqual
        && cardOriginalEqual
        && cloneBytesEqual
        && cloneOriginalEqual
        && apiBytesEqual
        && discordBytesEqual,
      bytesEqual,
      replacementChars,
      cardBytesEqual,
      cardOriginalEqual,
      cloneBytesEqual,
      cloneOriginalEqual,
      apiBytesEqual,
      discordBytesEqual,
      cardId: created.id,
      commit: commit.stdout.trim(),
      inputBytes: inputBytes.length,
      normalizedBytes: expectedBytes.length,
      cardSha256: sha256(cardBytes),
      readbackSha256: sha256(readbackBytes),
      inputSha256: sha256(inputBytes),
      normalizedSha256: sha256(expectedBytes),
      postTruncated: post.truncated,
    };
  } finally {
    api?.abort();
    await api?.whenIdle?.().catch(() => {});
    if (fake) await fake.close().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
