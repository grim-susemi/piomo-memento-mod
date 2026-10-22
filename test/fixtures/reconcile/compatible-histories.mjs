// Independent oracle: enumerate feasible total orders, then replay owner choices.
// It imports no production code and does not reimplement reconcile's decision rows.
// Board events are an append-only causal lane. Audit events have snowflake order.
// A partial gap may hide owner changes; a final hidden roundtrip represents the
// alternative latest-phone outcome even when the remote equals its old base.
const statuses = ['idea', 'researching', 'planned', 'building', 'done', 'held', 'dropped'];
export const HISTORY_SEED = 0x6d656d31;

export function* generatedHistories(count = 2000, seed = HISTORY_SEED) {
  let state = seed >>> 0;
  const pick = (n) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % n;
  };
  for (let index = 0; index < count; index += 1) {
    const base = statuses[pick(statuses.length)];
    const coverage = index % 3 === 0 ? 'partial' : 'complete';
    const boardEvents = [];
    let cardStatus = base;
    let boardAt = 6000 + pick(7) * 2000;
    const boardCount = pick(3);
    for (let n = 0; n < boardCount; n += 1) {
      const to = statuses[pick(statuses.length)];
      boardEvents.push({
        eventId: `b-${index}-${n}`, at: boardAt,
        uncertaintyMs: [0, 1000, 2000, 5000][pick(4)],
        from: cardStatus, to, resolves: false,
      });
      cardStatus = to;
      boardAt += 3000 + pick(4) * 2000;
    }
    const entries = [];
    let remoteStatus = base;
    let phoneAt = 4000 + pick(7) * 2000;
    const phoneCount = pick(4);
    for (let n = 0; n < phoneCount; n += 1) {
      const to = phoneCount === 2 && n === 1 && index % 2 === 0
        ? base : statuses[pick(statuses.length)];
      entries.push({
        entryId: `p-${index}-${n}`, at: phoneAt, actor: 'owner', reason: null,
        from: remoteStatus, to,
      });
      remoteStatus = to;
      phoneAt += 3000;
    }
    if (coverage === 'complete' && pick(4) === 0) {
      const to = statuses[pick(statuses.length)];
      entries.push({
        entryId: `bot-${index}`, at: phoneAt + 3000, actor: 'bot',
        reason: 'another-bot', from: remoteStatus, to,
      });
      remoteStatus = to;
    } else if (coverage === 'partial' && phoneCount === 0) {
      remoteStatus = statuses[pick(statuses.length)];
    }
    yield {
      card: { status: cardStatus, discordBase: base, discordState: 'linked', boardEvents },
      remote: { exists: true, statusTags: [remoteStatus] },
      audit: { coverage, entries: index % 2 === 0 ? entries.toReversed() : entries },
    };
  }
}

// Feasibility of a proposed total order is independent of any winner heuristic:
// assign each event the earliest time allowed by its interval and its predecessor.
// Ties allow both causal orders, so touching intervals cannot prove a winner.
function replayOrders(board, remote, base) {
  const histories = [];
  const visit = (b, r, order) => {
    if (b < board.length) visit(b + 1, r, [...order, board[b]]);
    if (r < remote.length) visit(b, r + 1, [...order, remote[r]]);
    if (b !== board.length || r !== remote.length) return;
    let time = -Infinity;
    let finalStatus = base;
    const times = [];
    for (const event of order) {
      time = Math.max(time, event.lower);
      if (time > event.upper) return;
      times.push(time);
      if (event.actor === 'owner') finalStatus = event.to;
    }
    histories.push({ order: order.map((event) => event.id), times, finalStatus });
  };
  visit(0, 0, []);
  return histories;
}

export function compatibleHistories(given) {
  const base = given.card.discordBase;
  const target = given.remote.statusTags[0];
  const board = given.card.boardEvents.map((event) => ({
    id: event.eventId, actor: 'owner', to: event.to,
    lower: event.at - event.uncertaintyMs, upper: event.at + event.uncertaintyMs,
  }));
  const remote = given.audit.entries.toSorted((a, b) => a.at - b.at).map((event) => ({
    id: event.entryId, actor: event.actor, from: event.from, to: event.to,
    lower: event.at - 1000, upper: event.at + 1000,
  }));
  let remoteValue = base;
  for (const event of remote) {
    if (event.from !== remoteValue) throw new Error('inconsistent generated remote chain');
    remoteValue = event.to;
  }
  if (remoteValue !== target) {
    if (given.audit.coverage !== 'partial' || remote.length !== 0) {
      throw new Error('unexplained generated snapshot');
    }
    // The plan explicitly treats this unexplained partial snapshot as an owner pick.
    remote.push({
      id: 'missing-pick', actor: 'owner', to: target, lower: 0, upper: 100000,
    });
  }
  const histories = replayOrders(board, remote, base);
  if (given.audit.coverage === 'partial') {
    const alternate = statuses.find((status) => status !== target);
    const hidden = [
      { id: 'hidden-out', actor: 'owner', to: alternate, lower: 0, upper: 100000 },
      { id: 'hidden-back', actor: 'owner', to: target, lower: 0, upper: 100000 },
    ];
    histories.push(...replayOrders(board, [...remote, ...hidden], base));
  }
  return histories;
}
