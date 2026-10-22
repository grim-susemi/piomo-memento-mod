import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { normalizeIntake } from '../card/codec.mjs';
import { captureValidated } from './capture.mjs';

function readTextFile(file, missingReason) {
  try {
    return { ok: true, text: readFileSync(resolve(file), 'utf8') };
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === 'ENOENT' ? missingReason : `${missingReason}-read`,
    };
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Session-file seeding reads only rows whose record type is `message` and whose
 * message role is `user`; assistant text, tool results, custom messages and a
 * previous session's transcript are not owner input.
 */
export function readSessionUserTexts(file) {
  const loaded = readTextFile(file, 'session-missing');
  if (!loaded.ok) return loaded;
  const texts = [];
  let sessionId = '';
  let malformed = 0;
  for (const line of stripBom(loaded.text).split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    if (
      sessionId.length === 0 &&
      record.type === 'session' &&
      typeof record.id === 'string' &&
      record.id.length > 0
    ) {
      sessionId = record.id;
    }
    if (record.type !== 'message' || record.message?.role !== 'user') continue;
    const content = record.message.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    }
    if (text.length > 0) texts.push(normalizeIntake(text));
  }
  return {
    ok: true,
    sessionId: sessionId || basename(resolve(file)).replace(/\.jsonl$/i, ''),
    texts,
    userRows: texts.length,
    malformed,
  };
}

export function readItemsFile(file) {
  const loaded = readTextFile(file, 'items-missing');
  if (!loaded.ok) return loaded;
  let parsed;
  try {
    parsed = JSON.parse(stripBom(loaded.text));
  } catch {
    return { ok: false, reason: 'items-invalid' };
  }
  const items = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.items) ? parsed.items : null);
  if (!items || items.length === 0) return { ok: false, reason: 'items-invalid' };
  return { ok: true, items };
}

export async function captureFromSessionFile({ store, sessionFile, itemsFile, receipts, config }) {
  const session = readSessionUserTexts(sessionFile);
  if (!session.ok) {
    return {
      schema: 'memento.capture.v1',
      ok: false,
      code: 'SESSION_UNREADABLE',
      error: session.reason,
      created: [],
      skipped: [],
      rejected: [],
      sync: 'skipped',
    };
  }
  const items = readItemsFile(itemsFile);
  if (!items.ok) {
    return {
      schema: 'memento.capture.v1',
      ok: false,
      code: 'ITEMS_INVALID',
      error: items.reason,
      created: [],
      skipped: [],
      rejected: [],
      sync: 'skipped',
    };
  }
  const state = await store.readSyncState();
  if (!state.ok) {
    return {
      schema: 'memento.capture.v1',
      ok: false,
      code: 'REPO_UNINITIALIZED',
      error: state.reason ?? state.code,
      created: [],
      skipped: [],
      rejected: [],
      sync: 'skipped',
    };
  }
  const result = await captureValidated({
    store,
    items: items.items,
    verbatimTexts: session.texts,
    sourceRef: `session:${session.sessionId}`,
    receipts,
    config,
  });
  return { ...result, session: { userRows: session.userRows, malformed: session.malformed } };
}
