import { createInputLog } from './inputs.mjs';
import { capturePaste, getSyncNow } from './capture.mjs';
import { handleMementoCommand } from './command.mjs';
import { openStore } from '../store/store.mjs';

export const TOOL_NAME = 'memento_capture';
export const COMMAND_NAME = 'memento';

const TOOL_DESCRIPTION = [
  '소유자가 방금 입력한 메모를 메멘토 카드로 저장한다.',
  'pasted에는 소유자가 입력한 메모 전문을 한 글자도 바꾸지 않고 넣는다.',
  '메모를 생각 단위로 나눠 items를 만들고, title과 description은 모델이 직접 쓴다.',
  'original은 pasted에서 그대로 복사한 부분 문자열이어야 한다. 요약하거나 고치면 거부된다.',
  '비밀값처럼 보이는 내용과 이미 저장된 원문은 카드로 만들지 않는다.',
].join(' ');

const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'original'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: 'string', minLength: 1, maxLength: 120 },
    original: { type: 'string', minLength: 1 },
    project: { type: 'string' },
  },
};

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['pasted', 'items'],
  properties: {
    pasted: {
      type: 'string',
      minLength: 1,
      description: 'The owner input text, exactly as typed in this session.',
    },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: ITEM_SCHEMA,
    },
  },
};

function toolResult(result) {
  if (!result.ok) {
    return {
      content: [{ type: 'text', text: `메멘토: ${result.error}` }],
      details: result,
    };
  }
  const parts = [`메멘토: 카드 ${result.created.length}장 생성`];
  if (result.skipped.length > 0) parts.push(`중복 ${result.skipped.length}장 건너뜀`);
  if (result.rejected.length > 0) {
    parts.push(`거부: ${result.rejected.map((entry) => entry.error).join(', ')}`);
  }
  return {
    content: [{ type: 'text', text: parts.join(' · ') }],
    details: result,
  };
}

function gateFailureResult(code, error) {
  return {
    schema: 'memento.capture.v1',
    ok: false,
    code,
    error,
    created: [],
    skipped: [],
    rejected: [],
    sync: 'skipped',
  };
}

function failureResult(receipts, code, error) {
  receipts?.append({ event: 'capture-rejected', code });
  return gateFailureResult(code, error);
}

export function createIntake({ getConfig, receipts, isActive }) {
  const inputLog = createInputLog();
  let registered = false;
  let sessionId = '';

  const intake = {
    inputLog,
    get registered() {
      return registered;
    },
    setSessionId(next) {
      sessionId = typeof next === 'string' ? next : '';
    },
    resetSession(next) {
      inputLog.clear();
      intake.setSessionId(next);
    },
    register(pi) {
      if (registered) return false;
      registered = true;
      pi.on('input', (event) => {
        if (event?.source === 'interactive') inputLog.record(event.text);
      });
      pi.registerTool({
        name: TOOL_NAME,
        label: 'Memento capture',
        description: TOOL_DESCRIPTION,
        promptSnippet: '소유자의 메모를 메멘토 카드로 저장',
        promptGuidelines: [
          'Use memento_capture only when the owner pasted a memo in this session and wants it kept; copy each original verbatim from that paste and never paraphrase it.',
        ],
        parameters: PARAMETERS,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          if (typeof isActive === 'function' && !isActive()) {
            return toolResult(gateFailureResult('INACTIVE', 'memento inactive'));
          }
          const config = getConfig();
          if (!config || config.state !== 'configured') {
            return toolResult(gateFailureResult('UNCONFIGURED', 'memento unconfigured'));
          }
          const current = sessionId || ctx?.sessionManager?.getSessionId?.() || 'unknown';
          let result;
          try {
            result = await capturePaste({
              store: openStore(config.repoPath),
              pasted: params?.pasted,
              items: params?.items,
              provenance: inputLog,
              sessionId: current,
              receipts,
              config,
            });
          } catch {
            result = failureResult(receipts, 'STORE_ERROR', 'store error');
          }
          return toolResult(result);
        },
      });
      pi.registerCommand(COMMAND_NAME, {
        description: '메멘토 상태 보기 | sync | push | doctor',
        argumentHint: '[sync|push|doctor]',
        handler: async (args, ctx) => {
          if (typeof isActive === 'function' && !isActive()) {
            ctx?.ui?.notify?.('메멘토: 이 세션에서는 사용할 수 없습니다', 'warning');
            return;
          }
          const config = getConfig();
          if (!config || config.state !== 'configured') {
            ctx?.ui?.notify?.(
              `메멘토: ${config?.state ?? 'unconfigured'} (${config?.reason ?? 'config'})`,
              'warning',
            );
            return;
          }
          await handleMementoCommand({
            args,
            config,
            store: openStore(config.repoPath),
            agentDir: config.agentDir,
            ctx,
            syncNow: getSyncNow(),
          });
        },
      });
      return true;
    },
  };
  return intake;
}
