const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function entryKey(entry) {
  return entry?.key ?? JSON.stringify(entry);
}

/**
 * Three-way merge of the runner's pass delta into the latest state document.
 * The caller runs this inside openStore.transactSyncState, under the write lock,
 * so concurrent additions and deletions are taken from `latest` while keys the
 * runner actually changed in this pass are applied from `ours`.
 */
export function mergeSyncState(snapshot, ours, latest) {
  const merged = structuredClone(latest);
  for (const key of ['guildId', 'forumId', 'tagIds', 'ownerUserId', 'botUserId']) {
    if (!same(ours[key], snapshot[key])) merged[key] = structuredClone(ours[key]);
  }
  for (const key of ['audit', 'clock', 'starterCursor', 'nameSeen', 'quarantine', 'skipped', 'restoreContract']) {
    if (!same(ours[key], snapshot[key])) merged[key] = structuredClone(ours[key]);
  }
  // The adoption marker is deliberately advertised even when the pass did not
  // change it: a latest document written before adoption must gain the marker.
  if (ours.restoreContract !== undefined) merged.restoreContract = ours.restoreContract;
  merged.bases = { ...(latest.bases ?? {}) };
  const snapshotBases = snapshot.bases ?? {};
  for (const [cardId, value] of Object.entries(ours.bases ?? {})) {
    if (snapshotBases[cardId] !== value) merged.bases[cardId] = value;
  }
  for (const key of ['pending', 'recentWrites']) {
    const base = new Map((snapshot[key] ?? []).map((entry) => [entryKey(entry), entry]));
    const mine = new Map((ours[key] ?? []).map((entry) => [entryKey(entry), entry]));
    const current = new Map((latest[key] ?? []).map((entry) => [entryKey(entry), entry]));
    for (const [id] of base) if (!mine.has(id)) current.delete(id);
    for (const [id, entry] of mine) {
      // A same-key operation absent from the latest document was completed and
      // deleted by another restorer; a stale attempts update must not resurrect it.
      if (!current.has(id) && base.has(id)) continue;
      if (!same(entry, base.get(id))) current.set(id, structuredClone(entry));
    }
    merged[key] = [...current.values()];
  }
  return merged;
}
