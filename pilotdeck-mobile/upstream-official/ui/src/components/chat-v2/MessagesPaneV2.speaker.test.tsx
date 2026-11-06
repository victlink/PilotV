// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FindShortcutProvider } from '../../contexts/FindShortcutContext';
import type { ChatMessage } from '../chat/types/types';
import type { RenderableMessageItem } from './processGrouping';
import MessagesPaneV2, {
  collectFinalResultMessages,
  filterRenderableItemsBySpeaker,
  getTurnStartIndices,
  isReplyExpandedByDefault,
} from './MessagesPaneV2';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; name?: string; count?: number }) => {
      const template = options?.defaultValue || key;
      return template
        .replace(/\{\{name\}\}/g, String(options?.name ?? ''))
        .replace(/\{\{count\}\}/g, String(options?.count ?? ''));
    },
  }),
}));

vi.mock('./SubagentDetailModal', () => ({
  default: ({ isRunning }: { isRunning?: boolean }) => (
    <div data-testid="subagent-detail-modal" data-running={isRunning ? 'true' : 'false'} />
  ),
}));

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
  }

  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    return window.setTimeout(() => callback(performance.now()), 0);
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

const NOW = '2026-09-05T12:58:00.000Z';
const LATER = '2026-09-05T12:59:30.000Z';

function userMessage(id: string, content: string, timestamp = NOW): ChatMessage {
  return { id, type: 'user', content, timestamp };
}

function assistantMessage(
  id: string,
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, type: 'assistant', content, timestamp: LATER, ...extra };
}

function toolMessage(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    type: 'assistant',
    content: '',
    timestamp: LATER,
    isToolUse: true,
    toolName: 'Read',
    toolId: id,
    toolInput: '{"file_path":"src/ReadHidden.tsx"}',
    ...extra,
  };
}

/** 一轮完整对话：用户提问 → 两个 Agent 的过程发言 → 工具过程 → 最终结果。 */
function turnMessages(): ChatMessage[] {
  return [
    userMessage('u-1', '请帮我看看代码'),
    assistantMessage('a-lin-1', '小林：我先看看。', { agentName: '小林' }),
    toolMessage('tool-1'),
    assistantMessage('a-qiang', '阿强：我看看测试。', { agentName: '阿强' }),
    assistantMessage('a-lin-2', '小林：结论是这个。', { agentName: '小林' }),
  ];
}

function item(
  message: ChatMessage,
  originalIndex: number,
  extra: Partial<RenderableMessageItem> = {},
): RenderableMessageItem {
  return {
    message,
    originalIndex,
    beforeRunAttachment: null,
    afterRunAttachment: null,
    beforeProcessAttachments: [],
    afterProcessAttachments: [],
    ...extra,
  };
}

type PaneProps = {
  messages: ChatMessage[];
  speakerFilterKey?: string | null;
  speakerFilterLabel?: string | null;
  onSelectSpeaker?: (speakerKey: string | null) => void;
  isAssistantWorking?: boolean;
};

function Pane({
  messages,
  speakerFilterKey = null,
  speakerFilterLabel = null,
  onSelectSpeaker,
  isAssistantWorking = false,
  scrollContainerRef,
}: PaneProps & { scrollContainerRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <FindShortcutProvider activeScope="chat">
      <MessagesPaneV2
        scrollContainerRef={scrollContainerRef}
        isLoadingSessionMessages={false}
        chatMessages={messages}
        activityMessages={[]}
        sendingInputs={[]}
        visibleMessages={messages}
        visibleMessageCount={messages.length}
        isLoadingMoreMessages={false}
        hasMoreMessages={false}
        totalMessages={messages.length}
        loadEarlierMessages={() => {}}
        loadAllMessages={() => {}}
        allMessagesLoaded
        isLoadingAllMessages={false}
        provider="pilotdeck"
        selectedProject={null}
        selectedSession={null}
        createDiff={() => []}
        setInput={() => {}}
        isAssistantWorking={isAssistantWorking}
        sessionRuntimeState="synchronizing"
        activeRunId={null}
        runMode="agent"
        planModeActive={false}
        showThinking
        inlineThinking={false}
        speakerFilterKey={speakerFilterKey}
        speakerFilterLabel={speakerFilterLabel}
        onSelectSpeaker={onSelectSpeaker}
      />
    </FindShortcutProvider>
  );
}

function renderPane(props: PaneProps) {
  const scrollContainerRef = React.createRef<HTMLDivElement>();
  const view = render(<Pane {...props} scrollContainerRef={scrollContainerRef} />);
  return {
    ...view,
    rerenderPane: (next: PaneProps) =>
      view.rerender(<Pane {...next} scrollContainerRef={scrollContainerRef} />),
  };
}

describe('speaker filtering helpers', () => {
  it('keeps shared context and only the selected speaker utterances', () => {
    const question = userMessage('u-1', '请帮我看看代码');
    const tool = toolMessage('tool-1');
    const mine = assistantMessage('a-mine', '我来检查。', { agentName: '小林' });
    const other = assistantMessage('a-other', '我先看看测试。', { agentName: '阿强' });

    const filtered = filterRenderableItemsBySpeaker(
      [item(question, 0), item(tool, 1), item(mine, 2), item(other, 3)],
      'name:小林',
    );

    expect(filtered.map((entry) => entry.message.id)).toEqual(['u-1', 'tool-1', 'a-mine']);
  });

  it('returns the untouched list when no speaker is selected', () => {
    const question = userMessage('u-1', '问题');
    const other = assistantMessage('a-other', '回复', { agentName: '阿强' });
    const items = [item(question, 0), item(other, 1)];

    expect(filterRenderableItemsBySpeaker(items, null)).toBe(items);
  });

  it('filters trace children recursively', () => {
    const other = assistantMessage('a-other', '别人的过程发言', { agentName: '阿强' });
    const tool = toolMessage('tool-1');
    const trace = item(assistantMessage('trace-1', ''), 1, {
      turnTrace: { id: 'turn-trace-1', durationMs: 1000, items: [item(other, 1), item(tool, 2)] },
    });

    const filtered = filterRenderableItemsBySpeaker([trace], 'name:小林');

    expect(filtered).toHaveLength(1);
    expect(filtered[0].turnTrace?.items.map((entry) => entry.message.id)).toEqual(['tool-1']);
  });

  it('drops a trace whose children all belong to other speakers', () => {
    const other = assistantMessage('a-other', '别人的过程发言', { agentName: '阿强' });
    const trace = item(assistantMessage('trace-1', ''), 1, {
      turnTrace: { id: 'turn-trace-2', durationMs: 1000, items: [item(other, 1)] },
    });

    expect(filterRenderableItemsBySpeaker([trace], 'name:小林')).toHaveLength(0);
  });

  it('carries the shared process context of a filtered row to the surviving row', () => {
    const attachment = { id: 'process-1' } as RenderableMessageItem['beforeProcessAttachments'][number];
    const other = assistantMessage('a-other', '别人的过程发言', { agentName: '阿强' });
    const mine = assistantMessage('a-mine', '我的发言', { agentName: '小林' });

    const filtered = filterRenderableItemsBySpeaker(
      [
        item(other, 0, { afterProcessAttachments: [attachment] }),
        item(mine, 1),
      ],
      'name:小林',
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0].message.id).toBe('a-mine');
    expect(filtered[0].afterProcessAttachments).toEqual([attachment]);
  });
});

describe('final result detection helpers', () => {
  it('treats the reply right after a turn trace as the final result', () => {
    const question = userMessage('u-1', '检查代码');
    const final = assistantMessage('a-final', '结论。');
    const trace = item(assistantMessage('trace-1', ''), 0.01, {
      turnTrace: { id: 'turn-trace-1', durationMs: 1000, items: [] },
    });

    const finals = collectFinalResultMessages(
      [item(question, 0), trace, item(final, 1)],
      getTurnStartIndices([question, final]),
    );

    expect([...finals].map((message) => message.id)).toEqual(['a-final']);
  });

  it('treats the last reply of a turn without process as the final result', () => {
    const question = userMessage('u-1', '检查代码');
    const earlier = assistantMessage('a-1', '先说一句。');
    const last = assistantMessage('a-2', '结论。');

    const finals = collectFinalResultMessages(
      [item(question, 0), item(earlier, 1), item(last, 2)],
      getTurnStartIndices([question, earlier, last]),
    );

    expect(finals.has(last)).toBe(true);
    expect(finals.has(earlier)).toBe(false);
    expect(finals.has(question)).toBe(false);
  });

  it('splits turns on user messages', () => {
    expect(getTurnStartIndices([userMessage('u-1', 'a'), assistantMessage('x-1', 'b')])).toEqual([0]);
    expect(
      getTurnStartIndices([
        assistantMessage('x-0', 'first'),
        userMessage('u-1', 'a'),
        assistantMessage('x-1', 'b'),
      ]),
    ).toEqual([0, 1]);
  });

  it('only keeps the current task result expanded and folds earlier turns', () => {
    const firstQuestion = userMessage('u-1', '第一个问题');
    const firstAnswer = assistantMessage('a-1', '第一个结论。');
    const secondQuestion = userMessage('u-2', '第二个问题');
    const secondAnswer = assistantMessage('a-2', '第二个结论。');

    const finals = collectFinalResultMessages(
      [item(firstQuestion, 0), item(firstAnswer, 1), item(secondQuestion, 2), item(secondAnswer, 3)],
      getTurnStartIndices([firstQuestion, firstAnswer, secondQuestion, secondAnswer]),
    );

    expect(finals.has(secondAnswer)).toBe(true);
    expect(finals.has(firstAnswer)).toBe(false);
  });

  it('does not expand the result of an earlier turn that had a process trace', () => {
    const firstQuestion = userMessage('u-1', '第一个问题');
    const firstResult = assistantMessage('a-1', '第一个结论。');
    const secondQuestion = userMessage('u-2', '第二个问题');
    const secondResult = assistantMessage('a-2', '第二个结论。');
    const firstTrace = item(assistantMessage('trace-1', ''), 0.01, {
      turnTrace: { id: 'turn-trace-1', durationMs: 1000, items: [] },
    });

    const finals = collectFinalResultMessages(
      [
        item(firstQuestion, 0),
        firstTrace,
        item(firstResult, 1),
        item(secondQuestion, 2),
        item(secondResult, 3),
      ],
      getTurnStartIndices([firstQuestion, firstResult, secondQuestion, secondResult]),
    );

    expect(finals.has(secondResult)).toBe(true);
    expect(finals.has(firstResult)).toBe(false);
  });
});

describe('reply expansion defaults', () => {
  const plain = assistantMessage('a-1', '回复');

  it('expands streaming replies', () => {
    expect(
      isReplyExpandedByDefault(
        assistantMessage('a-stream', '回复', { isStreaming: true }),
        { isFinalResult: false, isNewestReply: false, isAssistantWorking: false },
      ),
    ).toBe(true);
  });

  it('expands the final result', () => {
    expect(
      isReplyExpandedByDefault(plain, {
        isFinalResult: true,
        isNewestReply: false,
        isAssistantWorking: false,
      }),
    ).toBe(true);
  });

  it('expands the newest reply while the assistant is working', () => {
    expect(
      isReplyExpandedByDefault(plain, {
        isFinalResult: false,
        isNewestReply: true,
        isAssistantWorking: true,
      }),
    ).toBe(true);
  });

  it('collapses finished replies', () => {
    expect(
      isReplyExpandedByDefault(plain, {
        isFinalResult: false,
        isNewestReply: false,
        isAssistantWorking: false,
      }),
    ).toBe(false);
    expect(
      isReplyExpandedByDefault(plain, {
        isFinalResult: false,
        isNewestReply: true,
        isAssistantWorking: false,
      }),
    ).toBe(false);
  });
});

describe('MessagesPaneV2 speaker filter and reply expansion', () => {
  it('shows only the selected speaker replies while keeping the shared context', () => {
    renderPane({
      messages: [
        userMessage('u-1', '请帮我看看代码'),
        assistantMessage('a-mine', '小林：我来检查。', { agentName: '小林' }),
        userMessage('u-2', '顺便看下测试'),
        assistantMessage('a-other', '阿强：我先看看测试。', { agentName: '阿强' }),
      ],
      speakerFilterKey: 'name:小林',
    });

    expect(screen.getByText('请帮我看看代码')).toBeTruthy();
    expect(screen.getByText('小林：我来检查。')).toBeTruthy();
    expect(screen.queryByText('阿强：我先看看测试。')).toBeNull();
  });

  it('filters trace children recursively and keeps the tool process visible', () => {
    renderPane({
      messages: turnMessages(),
      speakerFilterKey: 'name:小林',
    });

    // 这一轮折叠了：过程在 trace 里，最终结果单独一条。
    expect(screen.getByText('小林：结论是这个。')).toBeTruthy();
    expect(screen.queryByText('阿强：我看看测试。')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Processed / }));

    expect(screen.getByText('小林：我先看看。')).toBeTruthy();
    expect(screen.queryByText('阿强：我看看测试。')).toBeNull();
    // 工具过程挂在保留下来的那一行上，不会因为换视角消失。
    expect(screen.getByText('ReadHidden.tsx')).toBeTruthy();
  });

  it('keeps the final result expanded and collapses the finished replies', () => {
    renderPane({ messages: turnMessages() });

    // 最终结果默认展开：没有折叠按钮。
    expect(screen.queryByTestId('assistant-message-expand')).toBeNull();
    expect(screen.getByText('小林：结论是这个。')).toBeTruthy();

    // 展开过程后，过程中的已完成回复默认折叠。
    fireEvent.click(screen.getByRole('button', { name: /^Processed / }));
    const expandButtons = screen.getAllByTestId('assistant-message-expand');
    expect(expandButtons).toHaveLength(2);
    expect(expandButtons[0].textContent).toContain('小林：我先看看。');
    expect(expandButtons[1].textContent).toContain('阿强：我看看测试。');

    // 手动展开后，这一行不再折叠。
    fireEvent.click(expandButtons[0]);
    expect(screen.getAllByTestId('assistant-message-expand')).toHaveLength(1);
  });

  it('collapses the replies of earlier turns and keeps the current task result expanded', () => {
    renderPane({
      messages: [
        userMessage('u-1', '第一个问题'),
        assistantMessage('a-1', '第一个结论。'),
        userMessage('u-2', '第二个问题'),
        assistantMessage('a-2', '第二个结论。'),
      ],
    });

    // 上一轮的回复是「已完成的回复」，默认折叠。
    const expandButtons = screen.getAllByTestId('assistant-message-expand');
    expect(expandButtons).toHaveLength(1);
    expect(expandButtons[0].textContent).toContain('第一个结论。');
    // 当前任务的结果默认展开。
    expect(screen.getByText('第二个结论。')).toBeTruthy();
  });

  it('keeps the manual expansion override across a rerender', () => {
    const messages = turnMessages();
    const view = renderPane({ messages });

    fireEvent.click(screen.getByRole('button', { name: /^Processed / }));
    fireEvent.click(screen.getAllByTestId('assistant-message-expand')[0]);
    expect(screen.getAllByTestId('assistant-message-expand')).toHaveLength(1);

    view.rerenderPane({ messages });

    expect(screen.getAllByTestId('assistant-message-expand')).toHaveLength(1);
    expect(screen.getByText('小林：我先看看。')).toBeTruthy();
  });

  it('forwards the speaker selection to the rendered rows', () => {
    const onSelectSpeaker = vi.fn();
    renderPane({
      messages: [
        userMessage('u-1', '检查代码'),
        assistantMessage('a-mine', '小林：我来检查。', { agentName: '小林' }),
      ],
      onSelectSpeaker,
    });

    fireEvent.click(screen.getByTestId('assistant-message-speaker'));

    expect(onSelectSpeaker).toHaveBeenCalledWith('name:小林');
  });
});

describe('speaker filter banner', () => {
  afterEach(cleanup);

  it('says who is being shown and how many replies are hidden', () => {
    renderPane({
      messages: [
        userMessage('u-1', '请帮我看看代码'),
        assistantMessage('a-lin', '小林：我先看看。', { agentName: '小林' }),
        userMessage('u-2', '那测试呢'),
        assistantMessage('a-qiang', '阿强：我看看测试。', { agentName: '阿强' }),
        userMessage('u-3', '再补一句'),
        assistantMessage('a-qiang-2', '阿强：再补一句。', { agentName: '阿强' }),
      ],
      speakerFilterKey: 'name:阿强',
      speakerFilterLabel: '阿强',
      onSelectSpeaker: vi.fn(),
    });

    const banner = screen.getByTestId('speaker-filter-banner');
    expect(banner.textContent).toContain('阿强');
    // 小林那条被藏起来了，数量要说得出来。
    expect(banner.textContent).toContain('1');
    // 被筛掉的说话人不该再出现在正文里。
    expect(screen.queryByText('小林：我先看看。')).toBeNull();
    expect(screen.getByText('阿强：我看看测试。')).toBeTruthy();
    expect(screen.getByText('阿强：再补一句。')).toBeTruthy();
    // 发言人也还在，而且只剩阿强一个。
    const speakers = screen.getAllByTestId('assistant-message-speaker');
    expect(speakers.map((node) => node.textContent)).toEqual(['阿强', '阿强']);
  });

  it('shows a clear action that resets the filter', () => {
    const onSelectSpeaker = vi.fn();
    renderPane({
      messages: [
        userMessage('u-1', '请帮我看看代码'),
        assistantMessage('a-lin', '小林：我先看看。', { agentName: '小林' }),
      ],
      speakerFilterKey: 'name:小林',
      speakerFilterLabel: '小林',
      onSelectSpeaker,
    });

    fireEvent.click(screen.getByTestId('speaker-filter-clear'));

    expect(onSelectSpeaker).toHaveBeenCalledWith(null);
  });

  it('keeps the banner away when no filter is active', () => {
    renderPane({
      messages: [userMessage('u-1', '请帮我看看代码')],
      speakerFilterKey: null,
      onSelectSpeaker: vi.fn(),
    });

    expect(screen.queryByTestId('speaker-filter-banner')).toBeNull();
  });
});
