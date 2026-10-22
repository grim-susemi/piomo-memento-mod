import { FORUM_NAME, GUILD_NAME, OWNER_POST_TITLE, PROBE_TITLE, STATUS_LABELS } from './constants.mjs';
import { writeTextAtomic } from './io.mjs';
import { join } from 'node:path';

export async function writeOwnerAction({ outDir, forumId, probePostId, tagIds }) {
  const lines = [
    '# 메멘토 디스코드 시험 — 소유자 손 작업 (약 1분)',
    '',
    `대상: 디스코드 서버 \`${GUILD_NAME}\` → 포럼 채널 \`${FORUM_NAME}\` (id ${forumId}).`,
    `시험 글 id: ${probePostId} · 제목: \`${PROBE_TITLE}\``,
    '',
    '## 소유자가 디스코드 앱(PC 또는 폰)에서 할 일',
    '',
    `1. 서버 \`${GUILD_NAME}\`의 포럼 채널 \`${FORUM_NAME}\`을 엽니다.`,
    `2. 새 글을 하나 씁니다. 제목은 정확히 \`${OWNER_POST_TITLE}\`, 본문은 짧은 한국어 한 줄(예: \`소유자 시험 글 ㅋㅋㅋ 👍\`).`,
    `3. 그 글의 태그를 \`${STATUS_LABELS[0]}\`가 아닌 상태 태그(예: \`${STATUS_LABELS[2]}\`)로 바꿉니다.`,
    `4. 같은 포럼의 시험 글 \`${PROBE_TITLE}\`(id ${probePostId})의 태그를 다른 상태 태그(예: \`${STATUS_LABELS[4]}\`)로 바꿉니다.`,
    '5. 두 글은 지우지 마세요. 시험이 끝나면 봇이 태그를 한 번 더 바꾸고 두 글을 삭제합니다.',
    '',
    '## 루트/에이전트가 이어서 할 일',
    '',
    `소유자가 위 2-4를 마친 뒤 같은 출력 폴더로 다시 실행합니다:`,
    '',
    '```',
    `node bin/memento.mjs probe --out "${outDir}"`,
    '```',
    '',
    '감사 로그(THREAD_UPDATE=111)에서 소유자 항목을 최대 3회, 20초 간격으로 확인합니다.',
    '둘 다 보이면 봇이 `[시험] 소유자 글`의 태그를 한 번 더 바꾸고 두 글을 삭제한 뒤',
    '404/10003과 감사 로그 THREAD_DELETE=112를 확인하고 `probe.json`을 씁니다.',
    '',
    `태그 id: ${JSON.stringify(tagIds)}`,
    '',
  ];
  await writeTextAtomic(join(outDir, 'owner-action.md'), `${lines.join('\n')}\n`);
}

export async function writeOwnerCreateForum({ outDir }) {
  const tagList = STATUS_LABELS.map(label => `\`${label}\``).join(', ');
  const lines = [
    '# 메멘토 포럼 채널을 소유자가 직접 만들어야 합니다',
    '',
    '봇에 MANAGE_CHANNELS 권한이 없고 `메멘토` 포럼이 아직 없습니다.',
    '디스코드 앱에서 다음을 한 번 만들어 주세요.',
    '',
    `1. 서버 \`${GUILD_NAME}\` → 채널 만들기 → 포럼.`,
    `2. 이름: \`${FORUM_NAME}\`.`,
    '3. 비공개로 설정하고 @everyone의 채널 보기(View Channel)를 끕니다.',
    '4. 봇 `사서수세미`에 이 채널의 채널 보기(View Channel)를 허용합니다(또는 Administrator).',
    `5. 태그 7개를 정확한 이름으로 추가합니다: ${tagList}.`,
    '6. 자동 보관 기간은 1주일(10080분)로 둡니다.',
    '',
    '그다음 채널 id를 붙여 다시 실행합니다:',
    '',
    '```',
    `node bin/memento.mjs probe --out "${outDir}" --forum-id <채널 id>`,
    '```',
    '',
  ];
  await writeTextAtomic(join(outDir, 'owner-create-forum.md'), `${lines.join('\n')}\n`);
}

export async function writePreparedOwnerAction({
  outDir, forumId, tagIds, fields, resumeCommand,
}) {
  const cleanupThreads = fields?.cleanup?.threads ?? [];
  const remainingPosts = cleanupThreads.filter(thread => thread.gone !== true).length;
  const lines = [
    '# 메멘토 디스코드 시험 — 준비 완료, 소유자 손 작업 대기',
    '',
    '소유자가 자고 있으므로 지금 손 작업을 요청하지 않습니다. 봇이 할 수 있는 단계는 모두 끝냈고,',
    '임시 프로브 글은 남기지 않고 삭제했습니다. 소유자가 깨어나면 아래 순서로 이어갑니다.',
    '',
    '## 현재 준비 상태',
    '',
    `- 포럼: \`${FORUM_NAME}\` (id ${forumId}), 비공개, 태그 7개 (${STATUS_LABELS.join(', ')})`,
    `- 태그 id: ${JSON.stringify(tagIds)}`,
    `- 한글 왕복: ${fields?.koreanRoundTrip === true ? '통과' : '미확인'}`,
    `- THREAD_UPDATE(111) applied_tags: ${fields?.auditHasAppliedTags === true ? '확인' : '미확인'}`,
    `- 보관 목록: ${fields?.archivedListed === true ? '확인' : '미확인'}`,
    `- 보관 중 PATCH plain: ${fields?.archivedPatchPlain === false ? '400/50083 확인' : String(fields?.archivedPatchPlain)}`,
    `- 보관 해제 PATCH: ${fields?.archivedPatchUnarchive === true ? '성공' : '미확인'}`,
    `- 삭제한 임시 프로브 글: ${(fields?.deletedProbePostIds ?? []).join(', ') || '없음'}`,
    `- 남은 임시 글: ${remainingPosts}`,
    '',
    '## 소유자가 깨어나면 (루트가 진행)',
    '',
    '1. 루트가 같은 probe 명령을 다시 실행해 새 프로브 글을 만듭니다.',
    `   \`${resumeCommand}\``,
    '2. 그러면 \`owner-action.md\`가 새 프로브 글 id로 갱신됩니다.',
    `3. 소유자는 포럼 \`${FORUM_NAME}\`에서 제목 \`${OWNER_POST_TITLE}\`인 글을 하나 쓰고, 그 글의 태그를 \`${STATUS_LABELS[0]}\`가 아닌 상태 태그로 바꿉니다.`,
    `4. 같은 포럼의 새 \`${PROBE_TITLE}\` 글 태그도 다른 상태 태그로 바꿉니다.`,
    '5. 두 글은 지우지 않습니다. 루트가 다시 probe를 실행하면 봇이 소유자 글 태그를 한 번 더 바꾸고 두 글을 삭제한 뒤 최종 probe.json을 씁니다.',
    '',
    '지금은 소유자에게 묻지 말고, 소유자가 깨어난 뒤 이 파일을 그대로 안내에 사용하세요.',
    '',
  ];
  await writeTextAtomic(join(outDir, 'owner-action.md'), `${lines.join('\n')}\n`);
}
