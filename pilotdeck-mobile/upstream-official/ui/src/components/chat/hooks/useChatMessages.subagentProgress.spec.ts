import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { buildRenderableMessageItems } from '../utils/processGrouping';
import { normalizedToChatMessages } from './useChatMessages';

const progressMessage = (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id: 'subagent_progress_s_child_tool_call-1',
  sessionId: 's',
  provider: 'pilotdeck',
  timestamp: '2026-08-07T00:00:00.000Z',
  kind: 'subagent_progress',
  subagentId: 'child',
  subagentType: 'explore',
  phase: 'tool',
  toolId: 'call-1',
  text: '正在调用 Read：src/app.ts',
  at: '2026-08-07T00:00:00.000Z',
  ...overrides,
});

describe('subagent progress rendering', () => {
  it('converts a progress frame into a narratable system row', () => {
    expect(normalizedToChatMessages([progressMessage()])[0]).toMatchObject({
      type: 'system',
      content: '正在调用 Read：src/app.ts',
      isSubagentProgress: true,
      subagentId: 'child',
      subagentType: 'explore',
      subagentProgressPhase: 'tool',
    });
  });

  it('keeps progress rows in the main timeline instead of folding them into a tool group', () => {
    const messages = normalizedToChatMessages([
      progressMessage(),
      progressMessage({ id: 'subagent_progress_s_child_text', phase: 'text', toolId: undefined, text: '入口文件在 src/main.ts' }),
    ]);
    const items = buildRenderableMessageItems(messages, { isAssistantWorking: true });
    expect(items.map((item) => item.message.content)).toEqual([
      '正在调用 Read：src/app.ts',
      '入口文件在 src/main.ts',
    ]);
  });
});
