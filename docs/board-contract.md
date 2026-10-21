# Board contract v1

This is the only surface the board uses to read and change memento cards. The board never opens card files, and card text never enters the board view model.

## Discovery

The extension publishes one object in interactive lead sessions, after its config loads:

```js
globalThis[Symbol.for('omo.memento.api.v1')] = {
  version: 1,
  features: ['cards.read', 'cards.setStatus'],
  state(),      // -> memento.board-state.v1
  handle(body), // -> Promise<{status, body}>
};
```

It's removed on `session_shutdown`, but only while the slot still holds this instance's own object. A missing slot means `501 MEMENTO_UNAVAILABLE`. Any `version` other than 1 means `501 API_VERSION_UNSUPPORTED`.

## GET /memento/state

Returns `memento.board-state.v1`. Every object below has exactly the listed keys; a key marked `?` may be absent. Anything else is an `unknown key`.

```
{schema: 'memento.board-state.v1', ok: boolean, lastSync: ISO | null, unpushedCommits: integer >= 0,
 statuses: [{key, label}] x7, cards: [card...]}
```

`statuses` is always these 7 objects, in this array order. Property order inside each object doesn't matter:

| key | label |
|-----|-------|
| idea | 메모 |
| researching | 조사중 |
| planned | 계획됨 |
| building | 구현중 |
| done | 완료 |
| held | 보류 |
| dropped | 폐기 |

Cards are sorted by `updated`, newest first. A readable card:

```
{id, rev, title, description, status, created, updated, source, sourceRef, project?,
 original, notes, originalTruncated, notesTruncated,
 discord: {state, url?}, conflict?: {card, discord: [status...], since}, log}
```

- `id` matches `YYYYMMDD-xxxx` with `xxxx` from `[a-z2-7]`.
- `rev` is a positive integer. It goes up by one on every card write, and every write must name the rev it saw.
- `status` and every status inside `conflict` and `log` use the keys above, never labels.
- `description` is one line of at most 120 characters. `created`, `updated` and `since` are ISO times with an offset.
- `source` is `paste`, `discord` or `old-wiki`.
- `original` and `notes` are each cut to at most 4096 UTF-8 bytes on a character boundary. When cut, `originalTruncated` or `notesTruncated` is `true`.
- `discord.state` is `none`, `posting` (create pending), `linked`, `deleted`, `conflict` or `invalid` (the thread has 0 or 2+ status tags). `url` is https when present.
- `conflict` is present exactly when `discord.state` is `conflict`. It holds the card value, the candidate Discord values and when the conflict began.
- `log` is the card's newest 10 change-log entries, newest first, each `{at, actor, via, change, from?, to?, reason}`. `actor` is `owner` or `memento`; `via` is `board`, `discord`, `paste`, `old-wiki` or `sync`; `change` is `create`, `status`, `original`, `link`, `conflict`, `remote-deleted`, `adopted-orphan`, `invalid-remote` or `skipped-secret`. These are the card-format values, unchanged. The card file's `event_id`, `evidence` and `remote_at` are never sent.

A card file that can't be parsed shows up as `{id, unreadable: reason, log: []}` and nothing else.

## POST /memento

The body has exactly these keys:

```
{action: 'setStatus', id, status, rev, requestId}
```

`requestId` is a non-empty string the board picks per click. Sending a handled `requestId` again returns the first reply unchanged, so retries are safe. `rev` is the card rev the board last saw.

| status | body | when |
|--------|------|------|
| 200 | `{ok: true, rev, discord}` | written; `rev` is the new rev; `discord` is `pushed`, `pending`, `off` or `conflict` |
| 409 | `{ok: false, code: 'STALE', rev}` | `rev` differs from the card; `rev` is the current one |
| 409 | `{ok: false, code: 'BUSY'}` | the write lock stayed taken for 0.5 s |
| 400 | `{ok: false, code: 'BAD_REQUEST'}` | not an object, missing or extra key, wrong action, bad rev or requestId |
| 400 | `{ok: false, code: 'UNKNOWN_CARD'}` | no card with that id, or the card is unreadable |
| 400 | `{ok: false, code: 'BAD_STATUS'}` | status isn't one of the 7 keys |
| 501 | `{ok: false, code: 'MEMENTO_UNAVAILABLE'}` | no API object published |
| 501 | `{ok: false, code: 'API_VERSION_UNSUPPORTED'}` | published `version` isn't 1 |

Checks run in that order: body shape, status, card lookup, rev. A pick on a `conflict` or `invalid` card is a normal write and resolves it.

## Checker: src/contract.mjs

Plain JS, Node built-ins only. The board keeps copies of the fixtures, never imports.

- `validateBoardState(state) -> {ok: boolean, errors: string[]}`
- `validateCard(card, path?, errors?) -> string[]`
- `validateLogEntry(entry, path?, errors?) -> string[]`
- `checkSetStatusBody(body) -> null | 'BAD_REQUEST' | 'BAD_STATUS'`
- `expectedSetStatusVerdict(state, body) -> {status: 200} | {status: 400 | 409, code}` (no locks or Discord)
- `validateReply({status, body}) -> boolean`
- Constants: `LOG_ACTORS`, `LOG_VIAS`, `LOG_CHANGES`, `BOARD_STATE_SCHEMA`, `API_KEY`, `TEXT_CAP_BYTES`, `LOG_LIMIT`, `DISCORD_STATES`, `WRITE_DISCORD`, `SET_STATUS_KEYS`, `REPLY_CODES`

Fixtures: `test/fixtures/board-state.v1.json` (12 cards) and `test/fixtures/setStatus-cases.json` (`{cases: [{name, body, expect}]}`). `test/fixtures/board-source-card.json` is the synthetic card-file source of card `20261012-d456`: 14 log entries in file order and the full 2000-character original.
