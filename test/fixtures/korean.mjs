// Synthetic Korean fixtures for the memento.card.v1 codec. No owner text is used.

const SEED =
  '완성형: 가나다라마바사아자차카타파하\n' +
  '자모: ㅋㅋㅋ\n' +
  '이모지: 👍\n' +
  '기호: | `backtick`\n';

export const NFD_INPUT = '한글 자모 ㅋㅋㅋ 이모지 👍'.normalize('NFD');
export const NFC_INPUT = NFD_INPUT.normalize('NFC');

// Exactly 2,000 code points, with full syllables, bare jamo, an emoji, a pipe and a backtick.
export const LONG_ORIGINAL = SEED + '한'.repeat(2000 - [...SEED].length);

export const koreanCard = {
  description: '한글 카드 - 완성형, 자모 ㅋㅋㅋ, 이모지 👍',
  id: '20261021-aaaa',
  status: 'researching',
  created: '2026-10-21T00:00:00.000Z',
  updated: '2026-10-21T01:00:00.000Z',
  source: 'paste',
  sourceRef: 'session:fixture',
  rev: 2,
  discordChannel: '',
  discordThread: '',
  discordBase: '',
  discordState: 'none',
  schema: 'memento.card.v1',
  title: '한글 제목 👍 ㅋㅋㅋ',
  original: LONG_ORIGINAL,
  notes: '첫 줄\n둘째 줄 | `코드` 👍',
  log: [
    {
      at: '2026-10-21T00:00:00.000Z',
      eventId: 'evt-create',
      actor: 'owner',
      via: 'paste',
      change: 'create',
      reason: '한글 생성',
    },
    {
      at: '2026-10-21T01:00:00.000Z',
      eventId: 'evt-status',
      actor: 'owner',
      via: 'board',
      change: 'status',
      from: 'idea',
      to: 'researching',
      reason: '조사 시작',
    },
  ],
};

// Legitimate provenance for original_incomplete: a cut post adopted from a Discord orphan.
export const adoptedOrphanCard = {
  ...koreanCard,
  source: 'discord',
  sourceRef: 'discord:123456789012345679',
  project: 'piomo',
  updated: '2026-10-21T02:00:00.000Z',
  discordChannel: '123456789012345678',
  discordThread: '123456789012345679',
  discordBase: 'researching',
  discordState: 'linked',
  discordPostingSince: '2026-10-21T02:00:00.000Z',
  discordEditSeen: '2026-10-21T03:00:00.000Z',
  originalIncomplete: true,
  original: `${LONG_ORIGINAL}…(잘림)`,
  log: [
    {
      at: '2026-10-21T02:00:00.000Z',
      eventId: 'evt-adopted-orphan',
      actor: 'memento',
      via: 'sync',
      change: 'adopted-orphan',
      reason: 'Discord orphan adopted',
    },
  ],
};
