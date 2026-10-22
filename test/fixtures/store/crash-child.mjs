import { openStore } from '../../../src/store/store.mjs';

const [kind, repo, id] = process.argv.slice(2);

function barrier(info) {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error('crash child needs IPC'));
      return;
    }
    process.send({ type: 'before-rename', ...info }, () => {});
    process.on('message', (message) => {
      if (message?.type === 'continue') resolve();
    });
    process.on('disconnect', () => reject(new Error('parent disconnected')));
  });
}

const store = openStore(repo, {
  hooks: {
    beforeRename: barrier,
  },
});

try {
  if (kind === 'card') {
    await store.create({
      id,
      title: '중단 테스트',
      description: '중단 테스트 카드',
      original: '원문 그대로',
      source: 'paste',
      sourceRef: 'test:crash',
      via: 'paste',
      actor: 'owner',
    });
  } else {
    const read = await store.readSyncState();
    if (!read.ok) throw new Error(`state unreadable: ${read.code}`);
    read.state.pending.push({ key: 'crash-barrier' });
    await store.writeSyncState(read.state);
  }
  process.exit(0);
} catch (error) {
  if (process.send) process.send({ type: 'error', error: String(error?.stack ?? error) });
  process.exit(1);
}
