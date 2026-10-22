import { createHash } from 'node:crypto';
import { normalizeIntake } from '../card/codec.mjs';
import { findSecret } from '../card/secrets.mjs';

const TITLE_MAX = 100;
const DESCRIPTION_MAX = 120;

let syncNow = null;

/** TASK11 wires the bounded session sync here; until then this is a no-op. */
export function setSyncNow(fn) {
  syncNow = typeof fn === 'function' ? fn : null;
}

export function getSyncNow() {
  return syncNow;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codePoints(value) {
  return [...value].length;
}

function originalHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function itemRejection(index, code, error, extra = {}) {
  return { index, code, error, ...extra };
}

function wholeReject(code, error, receipts) {
  receipts?.append({ event: 'capture-rejected', code });
  return {
    schema: 'memento.capture.v1',
    ok: false,
    code,
    error,
    created: [],
    skipped: [],
    rejected: [],
    sync: 'skipped',
  };
}

function invalidItem(reason) {
  return { ok: false, ...reason };
}

function validateItem(item, verbatimTexts) {
  if (!isObject(item)) {
    return invalidItem({ code: 'ITEM_INVALID', error: 'item must be an object' });
  }
  if (typeof item.title !== 'string') {
    return invalidItem({ code: 'TITLE_INVALID', error: 'title invalid' });
  }
  const title = normalizeIntake(item.title);
  if (title.trim().length === 0 || title.includes('\n') || codePoints(title) > TITLE_MAX) {
    return invalidItem({ code: 'TITLE_INVALID', error: 'title invalid' });
  }
  if (typeof item.description !== 'string') {
    return invalidItem({ code: 'DESCRIPTION_INVALID', error: 'description invalid' });
  }
  const description = normalizeIntake(item.description);
  if (
    description.trim().length === 0 ||
    description.includes('\n') ||
    codePoints(description) > DESCRIPTION_MAX
  ) {
    return invalidItem({ code: 'DESCRIPTION_INVALID', error: 'description invalid' });
  }
  if (typeof item.original !== 'string' || item.original.length === 0) {
    return invalidItem({ code: 'ORIGINAL_INVALID', error: 'original invalid' });
  }
  const original = normalizeIntake(item.original);
  if (original.length === 0) {
    return invalidItem({ code: 'ORIGINAL_INVALID', error: 'original invalid' });
  }
  let project;
  if (item.project !== undefined && item.project !== null && item.project !== '') {
    if (typeof item.project !== 'string') {
      return invalidItem({ code: 'PROJECT_INVALID', error: 'project invalid' });
    }
    project = normalizeIntake(item.project);
    if (project.length === 0 || project.includes('\n')) {
      return invalidItem({ code: 'PROJECT_INVALID', error: 'project invalid' });
    }
  }
  const pattern = findSecret([title, description, original, project ?? ''].join('\n'));
  if (pattern) {
    return invalidItem({
      code: 'SECRET',
      error: `secret ${pattern}`,
      pattern,
    });
  }
  const verbatim = verbatimTexts.some((text) => text.includes(original));
  if (!verbatim) {
    return invalidItem({
      code: 'ORIGINAL_NOT_VERBATIM',
      error: 'original not verbatim',
    });
  }
  return {
    ok: true,
    value: {
      title,
      description,
      original,
      ...(project === undefined ? {} : { project }),
    },
  };
}

function storeError(result) {
  if (result?.code === 'INDEX_LOCK') return 'index-lock';
  if (result?.code === 'BUSY') return 'busy';
  if (typeof result?.reason === 'string' && result.reason.length > 0) {
    return `${result.code ?? 'store error'}: ${result.reason}`;
  }
  return String(result?.code ?? 'store error');
}

function startSync(config, receipts) {
  if (!config || config.state !== 'configured') return 'skipped';
  if (typeof syncNow !== 'function') return 'not-wired';
  try {
    const pending = syncNow();
    if (pending && typeof pending.then === 'function') {
      pending.catch((error) => {
        receipts?.append({
          event: 'sync-hook-failed',
          error: String(error?.name ?? 'error'),
        });
      });
    }
    return 'started';
  } catch (error) {
    receipts?.append({
      event: 'sync-hook-failed',
      error: String(error?.name ?? 'error'),
    });
    return 'failed';
  }
}

async function captureValidated({ store, items, verbatimTexts, sourceRef, receipts, config }) {
  const known = new Map();
  const listed = await store.list();
  for (const card of listed.cards) {
    known.set(originalHash(normalizeIntake(card.original)), card.id);
  }

  const created = [];
  const skipped = [];
  const rejected = [];
  for (let index = 0; index < items.length; index += 1) {
    const validated = validateItem(items[index], verbatimTexts);
    if (!validated.ok) {
      if (validated.code === 'SECRET') {
        receipts?.append({ event: 'capture-secret', pattern: validated.pattern });
      }
      rejected.push(itemRejection(
        index,
        validated.code,
        validated.error,
        validated.pattern ? { pattern: validated.pattern } : {},
      ));
      continue;
    }
    const value = validated.value;
    const hash = originalHash(value.original);
    if (known.has(hash)) {
      skipped.push({ index, id: known.get(hash), code: 'DUPLICATE' });
      continue;
    }
    const result = await store.create({
      title: value.title,
      description: value.description,
      original: value.original,
      ...(value.project === undefined ? {} : { project: value.project }),
      source: 'paste',
      sourceRef,
      via: 'paste',
      actor: 'owner',
    });
    if (!result.ok) {
      rejected.push(itemRejection(index, result.code ?? 'STORE_ERROR', storeError(result)));
      continue;
    }
    known.set(hash, result.id);
    created.push({
      index,
      id: result.id,
      rev: result.rev,
      file: result.file,
      discordState: result.card.discordState,
    });
  }

  const sync = created.length > 0 ? startSync(config, receipts) : 'skipped';
  receipts?.append({
    event: 'capture',
    created: created.length,
    skipped: skipped.length,
    rejected: rejected.length,
    ids: created.map((entry) => entry.id),
  });
  return {
    schema: 'memento.capture.v1',
    ok: true,
    complete: rejected.length === 0,
    created,
    skipped,
    rejected,
    sync,
  };
}

export async function capturePaste({ store, pasted, items, provenance, sessionId, receipts, config }) {
  if (typeof pasted !== 'string' || pasted.length === 0) {
    return wholeReject('BAD_REQUEST', 'pasted required', receipts);
  }
  const normalizedPaste = normalizeIntake(pasted);
  if (!provenance || typeof provenance.has !== 'function' || !provenance.has(normalizedPaste)) {
    return wholeReject('PASTED_NOT_FROM_OWNER', 'pasted not from owner input', receipts);
  }
  if (!Array.isArray(items) || items.length === 0) {
    return wholeReject('BAD_REQUEST', 'items must be a non-empty array', receipts);
  }
  return captureValidated({
    store,
    items,
    verbatimTexts: [normalizedPaste],
    sourceRef: `session:${sessionId || 'unknown'}`,
    receipts,
    config,
  });
}

export { captureValidated };
