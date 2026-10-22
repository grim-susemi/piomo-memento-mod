import { normalizeIntake } from '../card/codec.mjs';

export const INPUT_LIMIT = 50;

/**
 * The last interactive inputs of this session. Only a live `input` event with
 * source "interactive" may enter; prior transcript and session-file content
 * are never loaded here.
 */
export function createInputLog({ limit = INPUT_LIMIT } = {}) {
  const entries = [];
  return {
    record(text) {
      if (typeof text !== 'string' || text.length === 0) return false;
      entries.push(normalizeIntake(text));
      while (entries.length > limit) entries.shift();
      return true;
    },
    has(text) {
      if (typeof text !== 'string' || text.length === 0) return false;
      const wanted = normalizeIntake(text);
      return entries.some((entry) => entry.includes(wanted));
    },
    clear() {
      entries.length = 0;
    },
    get size() {
      return entries.length;
    },
  };
}
