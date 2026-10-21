const SEGMENTER = new Intl.Segmenter('ko', { granularity: 'grapheme' });

function cutTo(text, maxChars) {
  let out = '';
  for (const { segment } of SEGMENTER.segment(text)) {
    if (out.length + segment.length > maxChars) break;
    out += segment;
  }
  return out;
}

export function cutGraphemes(text, maxChars, suffix = '') {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string');
  }
  if (!Number.isInteger(maxChars) || maxChars < 0) {
    throw new RangeError('maxChars must be a non-negative integer');
  }
  if (typeof suffix !== 'string') {
    throw new TypeError('suffix must be a string');
  }
  if (text.length <= maxChars) return text;

  const budget = maxChars - suffix.length;
  if (budget < 0) return cutTo(suffix, maxChars);
  return `${cutTo(text, budget)}${suffix}`;
}
