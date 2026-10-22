import { createDiscordClient } from '../../../src/discord/client.mjs';
import { createReceipts } from '../../../src/receipts.mjs';
import { openStore } from '../../../src/store/store.mjs';
import { runSync } from '../../../src/sync/run.mjs';

const options = JSON.parse(process.argv[2] ?? '{}');
const repoPath = options.repoPath;
const now = Number.isFinite(options.nowMs) ? () => options.nowMs : Date.now;
const store = openStore(repoPath, { now });
const client = createDiscordClient({
  tokenFile: options.tokenFile,
  baseUrl: options.baseUrl,
});
const receipts = createReceipts({ agentDir: options.agentDir });

// The barrier reports over IPC, then parks forever. The parent kills this
// process at the barrier, so no timer, poll or cleanup path is needed.
const hooks = {
  barrier(name) {
    process.send?.({ type: 'barrier', name });
    if (!options.parkAt || name !== options.parkAt) return undefined;
    // Keep the IPC handle alive so the parked await does not exit with code 13.
    process.channel?.ref?.();
    return new Promise(() => {});
  },
};

try {
  const result = await runSync({
    reason: options.reason ?? 'startup',
    config: {
      state: 'configured',
      reason: '',
      agentDir: options.agentDir,
      repoPath,
      tokenFile: options.tokenFile,
      remote: options.remote,
    },
    store,
    client,
    receipts,
    hooks,
    now,
    budget: options.budget,
  });
  process.send?.({ type: 'result', result });
  process.exit(0);
} catch (error) {
  process.send?.({ type: 'error', error: String(error?.stack ?? error) });
  process.exit(1);
}
