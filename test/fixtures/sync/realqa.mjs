import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  killChild,
  makeSyncEnv,
  spawnSyncChild,
  waitForExit,
  waitForMessage,
} from './harness.mjs';

const summary = {
  schema: 'memento.task11.realqa.v1',
  startedAt: new Date().toISOString(),
  ok: false,
  scenarios: [],
  cleanup: {},
};

let env = null;
const children = [];
try {
  env = await makeSyncEnv();
  const baseOptions = {
    repoPath: env.repo,
    tokenFile: env.tokenFile,
    baseUrl: env.fake.baseUrl,
    remote: env.remote,
    agentDir: env.agentDir,
    nowMs: env.clock.now(),
  };

  // Scenario A: killed between the create response and the link save.
  const first = await env.newCard({ original: '실제 임시 저장소 크래시 원문 ㅋㅋㅋ 👍\n둘째 줄' });
  const a = spawnSyncChild({ ...baseOptions, parkAt: 'after-create-response' });
  children.push(a);
  await waitForMessage(a, (message) => message.type === 'barrier' && message.name === 'after-create-response');
  killChild(a);
  await waitForExit(a);
  const killedState = env.readState();
  const killedCard = await env.card(first.id);
  const a1 = await env.run();
  const a2 = await env.card(first.id);
  const scenarioA = {
    name: 'crash-between-create-response-and-link',
    postsAfterKill: env.posts().length,
    cardStateAfterKill: killedCard.discordState,
    pendingAfterKill: killedState.pending.length,
    rerunActions: a1.actions,
    postsAfterRerun: env.posts().length,
    linkedThread: a2.discordThread,
    cardStateAfterRerun: a2.discordState,
    originalByteEqual: a2.original === first.original.normalize('NFC'),
  };
  assert.equal(scenarioA.postsAfterKill, 1);
  assert.equal(scenarioA.cardStateAfterKill, 'posting');
  assert.equal(scenarioA.postsAfterRerun, 1);
  assert.equal(scenarioA.cardStateAfterRerun, 'linked');
  assert.equal(scenarioA.originalByteEqual, true);
  summary.scenarios.push(scenarioA);

  // Scenario B: killed after the link commit but before the final push, then restored.
  const second = await env.newCard({ original: '복원 시나리오 원문 😀\n둘째 줄' });
  const b = spawnSyncChild({ ...baseOptions, parkAt: 'before-final-push' });
  children.push(b);
  await waitForMessage(b, (message) => message.type === 'barrier' && message.name === 'before-final-push');
  killChild(b);
  await waitForExit(b);
  const restoredPath = env.cloneRestored('restored-real-qa');
  const { openStore } = await import('../../../src/store/store.mjs');
  const { runSync } = await import('../../../src/sync/run.mjs');
  const restored = openStore(restoredPath, { sleep: async () => {}, lockWaitMs: 500 });
  const b1 = await runSync({
    reason: 'startup',
    config: { ...env.config(), repoPath: restoredPath },
    store: restored,
    client: env.client,
    receipts: env.receipts,
    now: env.clock.now,
  });
  const restoredCard = await restored.get(second.id);
  const scenarioB = {
    name: 'crash-before-final-push-then-restore',
    postsAfterKill: env.posts().length,
    restoreActions: b1.actions,
    postsAfterRestore: env.posts().length,
    restored: restoredCard.ok,
    cardState: restoredCard.card?.discordState,
    linkedThread: restoredCard.card?.discordThread,
    originalByteEqual: restoredCard.card?.original === second.original.normalize('NFC'),
  };
  assert.equal(scenarioB.postsAfterRestore, 2);
  assert.equal(scenarioB.restored, true);
  assert.equal(scenarioB.cardState, 'linked');
  assert.equal(scenarioB.originalByteEqual, true);
  summary.scenarios.push(scenarioB);

  const receiptsPath = join(env.agentDir, 'logs', 'memento.jsonl');
  summary.ok = true;
  summary.finishedAt = new Date().toISOString();
  summary.receiptEvents = existsSync(receiptsPath)
    ? (await import('node:fs')).readFileSync(receiptsPath, 'utf8')
      .trim().split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line).event)
    : [];
} catch (error) {
  summary.ok = false;
  summary.error = String(error?.stack ?? error);
} finally {
  for (const child of children) {
    killChild(child);
    await waitForExit(child).catch(() => {});
  }
  if (env) {
    const parent = env.parent;
    await env.close();
    summary.cleanup = {
      tempRemoved: !existsSync(parent),
      openSockets: env.fake.openSockets.size,
      childProcesses: children.length,
      childExitCodes: children.map((child) => child.exitCode ?? child.signalCode ?? 'unknown'),
    };
  }
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
}
