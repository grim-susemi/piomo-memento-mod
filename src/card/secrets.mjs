const PATTERNS = Object.freeze([
  {
    name: 'discord-token',
    pattern: /(?<![\w-])[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}(?![\w-])/,
  },
  { name: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'github-token', pattern: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  // Scope guard is the literal BEGIN marker; it also covers PGP and certificate headers.
  { name: 'private-key', pattern: /-----BEGIN/ },
  {
    name: 'env-key',
    pattern: /(?:^|[\s"'`])[A-Z0-9_]*KEY=[^\s"'`]{20,}/i,
  },
]);

export function findSecret(text) {
  if (typeof text !== 'string') return null;
  for (const { name, pattern } of PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return null;
}
