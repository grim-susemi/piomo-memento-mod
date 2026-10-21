export const STATUS_KEYS = Object.freeze([
  'idea',
  'researching',
  'planned',
  'building',
  'done',
  'held',
  'dropped',
]);

export const STATUS_LABELS = Object.freeze({
  idea: '메모',
  researching: '조사중',
  planned: '계획됨',
  building: '구현중',
  done: '완료',
  held: '보류',
  dropped: '폐기',
});

const LABEL_TO_STATUS = new Map(
  STATUS_KEYS.map((key) => [STATUS_LABELS[key], key]),
);

export function isStatus(value) {
  return typeof value === 'string' && Object.hasOwn(STATUS_LABELS, value);
}

export function statusLabel(value) {
  return isStatus(value) ? STATUS_LABELS[value] : null;
}

export function statusFromLabel(label) {
  return LABEL_TO_STATUS.get(label) ?? null;
}
