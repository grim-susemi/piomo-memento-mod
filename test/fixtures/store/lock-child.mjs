import { acquire, release } from '../../../src/store/lock.mjs';

const [mode, repo, name, waitMsRaw] = process.argv.slice(2);
const waitMs = Number(waitMsRaw);

function send(message) {
  return new Promise((resolve) => {
    if (!process.send) {
      resolve();
      return;
    }
    process.send(message, () => resolve());
  });
}

async function finish(message, code = 0) {
  await send(message);
  process.exit(code);
}

try {
  if (mode === 'hold') {
    const held = await acquire(repo, name, { waitMs, sessionId: 'child-holder' });
    await send({ type: 'acquired', ok: held.ok, busy: held.busy === true, pid: process.pid });
    if (!held.ok) process.exit(0);
    await new Promise((resolve) => {
      process.on('message', (message) => {
        if (message?.type === 'release') resolve();
      });
      process.on('disconnect', resolve);
    });
    const released = await release(held);
    await finish({ type: 'released', released });
  } else {
    const result = await acquire(repo, name, { waitMs, sessionId: 'child-probe' });
    await send({ type: 'result', ok: result.ok, busy: result.busy === true, pid: process.pid });
    if (result.ok) await release(result);
    process.exit(0);
  }
} catch (error) {
  await finish({ type: 'error', error: String(error?.stack ?? error) }, 1);
}
