import { createHash, randomBytes } from 'node:crypto';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const DISCORD_EPOCH_MS = 1420070400000n;

const SEOUL_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function seoulDate(ms) {
  const parts = Object.fromEntries(
    SEOUL_DATE.formatToParts(new Date(ms))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}${parts.month}${parts.day}`;
}

function encode20(bits) {
  let out = '';
  for (let shift = 15; shift >= 0; shift -= 5) {
    out += BASE32[(bits >>> shift) & 31];
  }
  return out;
}

function randomBits(rand) {
  const value = rand(3);
  const bytes = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : null;
  if (bytes === null || bytes.length < 3) {
    throw new TypeError('rand(3) must return at least three bytes');
  }
  return ((bytes[0] << 16) | (bytes[1] << 8) | bytes[2]) >>> 4;
}

export function newId(now = Date.now(), rand = randomBytes) {
  if (!Number.isFinite(now)) {
    throw new TypeError('now must be a finite millisecond timestamp');
  }
  return `${seoulDate(now)}-${encode20(randomBits(rand))}`;
}

export function idForThread(guildId, threadId) {
  const thread = BigInt(threadId);
  if (thread < 0n) {
    throw new RangeError('threadId must be a non-negative snowflake');
  }
  const digest = createHash('sha256')
    .update(`${guildId}:${threadId}`, 'utf8')
    .digest();
  const bits = ((digest[0] << 16) | (digest[1] << 8) | digest[2]) >>> 4;
  const ms = Number((thread >> 22n) + DISCORD_EPOCH_MS);
  return `${seoulDate(ms)}-${encode20(bits)}`;
}
