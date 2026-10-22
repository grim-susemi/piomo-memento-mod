export const PROBE_SCHEMA = 'memento.probe.v1';
export const PROBE_STATE_SCHEMA = 'memento.probe-state.v1';
export const GUILD_NAME = '수세미 서버';
export const FORUM_NAME = '메멘토';
export const PROBE_TITLE = '[probe] 한글 왕복 확인 ㅋㅋㅋ 👍';
export const PROBE_TEXT = '한글 왕복 확인 ㅋㅋㅋ 👍';
export const PROBE_MARKER_PREFIX = 'memento:v1:probe:';
export const OWNER_POST_TITLE = '[시험] 소유자 글';

export const STATUS_KEYS = Object.freeze([
  'idea', 'researching', 'planned', 'building', 'done', 'held', 'dropped',
]);
export const STATUS_LABELS = Object.freeze([
  '메모', '조사중', '계획됨', '구현중', '완료', '보류', '폐기',
]);

export const PERMISSION_BITS = Object.freeze({
  manageChannels: 1n << 4n,
  viewAuditLog: 1n << 7n,
  viewChannel: 1n << 10n,
  sendMessages: 1n << 11n,
  readMessageHistory: 1n << 16n,
  manageThreads: 1n << 34n,
  sendMessagesInThreads: 1n << 38n,
});
export const ADMINISTRATOR_BIT = 1n << 3n;
export const VIEW_CHANNEL_BIT = PERMISSION_BITS.viewChannel;
export const RUNTIME_PERMISSION_NAMES = Object.freeze([
  'viewChannel', 'readMessageHistory', 'sendMessages',
  'sendMessagesInThreads', 'manageThreads', 'viewAuditLog',
]);
export const ALL_PERMISSION_NAMES = Object.freeze([
  ...RUNTIME_PERMISSION_NAMES, 'manageChannels',
]);
export const RUNTIME_PERMISSION_BITS = RUNTIME_PERMISSION_NAMES
  .reduce((bits, name) => bits | PERMISSION_BITS[name], 0n);
export const MESSAGE_CONTENT_FLAGS = (1n << 18n) | (1n << 19n);

export function permissionsFromBits(bits) {
  const value = typeof bits === 'bigint' ? bits : BigInt(bits ?? 0);
  const admin = (value & ADMINISTRATOR_BIT) === ADMINISTRATOR_BIT;
  const result = {};
  for (const name of ALL_PERMISSION_NAMES) {
    result[name] = admin || (value & PERMISSION_BITS[name]) === PERMISSION_BITS[name];
  }
  return result;
}

export function hasRuntimePermissions(permissionMap) {
  return RUNTIME_PERMISSION_NAMES.every(name => permissionMap[name] === true);
}

export function tagIdsByLabel(availableTags) {
  const result = {};
  for (const [index, key] of STATUS_KEYS.entries()) {
    const label = STATUS_LABELS[index];
    const tag = (availableTags ?? []).find(item => item?.name === label);
    if (!tag) return null;
    result[key] = tag.id;
  }
  return result;
}

export function tagNamesMatch(availableTags) {
  const names = (availableTags ?? []).map(tag => tag?.name);
  if (names.length !== STATUS_LABELS.length) return false;
  const expected = new Set(STATUS_LABELS);
  return names.every(name => expected.has(name)) && new Set(names).size === names.length;
}

export function statusTagIds(tagIds) {
  return STATUS_KEYS.map(key => tagIds?.[key]).filter(Boolean);
}

export function nextStatusKey(currentTags, tagIds) {
  const ids = new Set(statusTagIds(tagIds));
  const current = STATUS_KEYS.find(key => ids.has(tagIds?.[key])
    && (currentTags ?? []).includes(tagIds[key]));
  const index = current === undefined ? -1 : STATUS_KEYS.indexOf(current);
  return STATUS_KEYS[(index + 1) % STATUS_KEYS.length] === current
    ? STATUS_KEYS[(index + 2) % STATUS_KEYS.length]
    : STATUS_KEYS[(index + 1) % STATUS_KEYS.length];
}
