# Memento product rules

Independent, removable PiOMO extension for the Memento idea ledger. Node >= 24,
ESM `.mjs`, Node built-ins only, zero npm dependencies. Runtime code uses only the
supplied `pi` ExtensionAPI and the host context; it never imports an SDK.

## Required behavior

- Interactive lead sessions only: `extension(pi)` returns immediately unless
  `pi.sessionKind === 'interactive'`; on `session_start` the runtime stays inert,
  publishes nothing and releases its own registration when `ctx.hasUI === false`
  or the session file lives under `senpi-task/children/` (case-insensitive on
  Windows, lexical and canonical path). The factory's only registrations are the
  `session_start` and `session_shutdown` lifecycle hooks needed to read `ctx`.
- One registration per process through
  `globalThis[Symbol.for('omo.memento.v1')]`; a later factory call returns the same
  runtime object without adding hooks, and a stale instance's `session_shutdown`
  releases the slot only while it still holds that instance's own runtime.
- `OMO_MEMENTO=0` registers no hooks, tools or commands and writes exactly one
  `disabled-by-env` receipt per process.
- No timers, intervals, polling, scheduled work, detached processes, network calls
  or model calls from this wave. Any later background work is a bounded promise
  started from a documented event and aborted on `session_shutdown`.
- Agent dir: `SENPI_CODING_AGENT_DIR ?? OMO_CODING_AGENT_DIR`, else the directory
  derived from an installed generation path; with none, config state is
  `unconfigured` and nothing is written. Config lives at
  `<agentDir>/memento/config.json`; a missing or invalid file is `unconfigured`
  and never throws.
- Receipts append JSONL to `<agentDir>/logs/memento.jsonl`, one object per line
  with `at` and `event`. Any string carrying the Discord token is written as
  `[redacted]`; a receipt write failure is reported once with `console.error` and
  never thrown to the caller.
- LF only in generated files; no Hangul in any file path memento creates.
- The bot token is never printed, logged, committed, passed on a command line or
  stored in this repo.

## Installer

- The installer copies `src/`, `bin/`, `package.json` and `dist/manifest.json`
  into `<agentDir>/memento/integration/generation-<NNNNNN>/`, writes
  `<agentDir>/memento/current.json` and the shim `<agentDir>/extensions/omo-memento.js`.
- `--agent-dir` is required. Without `--live` it refuses, before writing anything,
  an agent dir that contains `settings.json` or equals the agent dir resolved from
  the environment. No live path is hard-coded here.
- `--uninstall` removes only the shim. A shim without the `// managed by omo-memento`
  first line is foreign and is never overwritten or removed.
- No live install, commit or push without the owner's separate approval.

## Verification

`npm run check` = `npm test && npm run build`. Tests use a fake `pi` host and temp
agent dirs only; they are deterministic, subscribe before triggering events and use
bounded waits, never sleeps or timing luck. The build manifest must carry a sha256
for every file under `src/` and `bin/`. Success is judged by receipts and exit
codes, not stdout alone. Keep failed evidence.
