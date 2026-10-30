import { isStatus } from '../card/status.mjs';

const milliseconds = (at) => typeof at === 'number' ? at : Date.parse(at);

/**
 * Pure sync decision. Times are epoch milliseconds or ISO timestamps.
 * boardEvents retain the card log's append order (including local clock rollback);
 * audit delivery order is irrelevant. Only a caller-correlated operationKey can
 * identify an acknowledgement by exact "memento-board|sync <operationKey>" reason.
 * Callers supply coverage, uncertainty, and the unresolved-state conflictSince.
 */
export function reconcile({ card, remote, audit }) {
  const board = card.boardEvents.at(-1);
  const entries = audit.entries.map((entry) => ({ ...entry, time: milliseconds(entry.at) }))
    .sort((a, b) => a.time - b.time);
  const owners = entries.filter((entry) => entry.actor === 'owner');
  const owner = owners.at(-1);
  const bots = entries.filter((entry) => entry.actor === 'bot');
  const acknowledgement = board?.operationKey && bots.findLast((entry) => entry.to === board.to
    && (entry.reason === `memento-board ${board.operationKey}`
      || entry.reason === `memento-sync ${board.operationKey}`));
  const boardTime = board && milliseconds(board.at);
  const boardInterval = board
    ? acknowledgement
      ? [acknowledgement.time - 1000, acknowledgement.time + 1000]
      : [boardTime - board.uncertaintyMs, boardTime + board.uncertaintyMs]
    : null;
  const ownerInterval = owner ? [owner.time - 1000, owner.time + 1000] : null;
  const validRemote = remote.statusTags.length === 1 && isStatus(remote.statusTags[0]);
  const remoteStatus = validRemote ? remote.statusTags[0] : null;
  const troubled = card.discordState === 'conflict' || card.discordState === 'invalid';
  const resolving = troubled && board?.resolves === true;
  const since = card.conflictSince === undefined ? null : milliseconds(card.conflictSince);
  // A remote value that is neither the base, the board value, nor a value the open conflict already
  // showed, with no owner entry visible, is an owner change the audit cannot attribute yet: its order
  // is not provable.
  const hidden = !owner && remoteStatus !== null && remoteStatus !== card.discordBase
    && remoteStatus !== card.status && !(card.conflictDiscord ?? []).includes(remoteStatus)
    && bots.at(-1)?.to !== remoteStatus;
  const evidence = {
    cardStatus: card.status,
    baseStatus: card.discordBase,
    remoteExists: remote.exists,
    remoteStatusTags: [...remote.statusTags],
    coverage: audit.coverage,
    boardEventId: board?.eventId ?? null,
    boardInterval,
    boardAuditEntryId: acknowledgement?.entryId ?? null,
    ownerEntryId: owner?.entryId ?? null,
    ownerInterval,
    conflictSince: since,
  };
  const action = (kind, reason, status) => ({
    kind, ...(status === undefined ? {} : { status }), reason, evidence,
  });
  const takeOwner = () => owner.to === remoteStatus
    ? action('take', 'owner-remote', remoteStatus)
    : action('conflict', 'owner-value-mismatch');
  const chooseBoard = () => resolving
    ? action('push', 'owner-resolution', card.status)
    : card.status === remoteStatus
      ? action('setBase', 'board-already-remote', card.status)
      : action('push', 'owner-board', card.status);

  if (!remote.exists) return action('markDeleted', 'remote-deleted');
  if (!validRemote && !resolving) return action('invalidRemote', 'invalid-remote');
  if (entries.some((entry) => !Number.isFinite(entry.time))
    || (board && (!Number.isFinite(boardTime)
      || !Number.isFinite(board.uncertaintyMs) || board.uncertaintyMs < 0))
    || (since !== null && !Number.isFinite(since))) {
    return action('conflict', 'invalid-time-evidence');
  }
  // A new resolution acknowledges the old conflict, not unknown activity after it.
  const unknown = entries.filter((entry) => entry.actor !== 'owner' && entry.actor !== 'bot')
    .filter((entry) => !troubled || since === null || entry.time + 1000 > since);
  if (unknown.length > 0) return action('conflict', 'unknown-actor');
  if (owner && owners.some((entry) => entry.time === owner.time && entry.to !== owner.to)) {
    return action('conflict', 'ambiguous-owner-order');
  }

  if (troubled) {
    const freshOwner = owner && since !== null && ownerInterval[0] > since;
    if (!resolving) {
      if (freshOwner) return takeOwner();
      return card.discordState === 'invalid'
        ? action('invalidRemote', 'unresolved-invalid')
        : action('conflict', 'unresolved-conflict');
    }
    // Even an explicit board pick cannot silently erase a hidden phone roundtrip.
    if (audit.coverage !== 'complete') return action('conflict', 'partial-audit');
    if (hidden) return action('conflict', 'unexplained-remote');
    if (!owner || (since !== null && !freshOwner)) return chooseBoard();
  }

  if (!board && !owner) {
    if (remoteStatus === card.discordBase) return action('none', 'at-base');
    const lastBot = bots.at(-1);
    const ownWrite = lastBot && lastBot.to === remoteStatus
      && typeof lastBot.reason === 'string' && /^memento-(?:board|sync) \S+$/u.test(lastBot.reason);
    if (card.status === remoteStatus && ownWrite) {
      return action('setBase', 'recorded-own-write', card.status);
    }
    return audit.coverage === 'partial'
      ? action('take', 'unobserved-owner-remote', remoteStatus)
      : action('conflict', 'unexplained-remote');
  }
  if (!board) return takeOwner();
  if (audit.coverage !== 'complete') return action('conflict', 'partial-audit');
  if (hidden) return action('conflict', 'unexplained-remote');
  if (!owner) return chooseBoard();
  if (boardInterval[0] > ownerInterval[1]) return chooseBoard();
  if (ownerInterval[0] > boardInterval[1]) return takeOwner();
  return action('conflict', 'unproven-order');
}
