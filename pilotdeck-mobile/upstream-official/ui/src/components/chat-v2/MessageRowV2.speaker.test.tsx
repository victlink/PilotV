// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MessageRowV2 from './MessageRowV2';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

afterEach(cleanup);

const TIMESTAMP = '2026-09-05T12:58:00.000Z';

describe('MessageRowV2 speaker labels', () => {
  it('labels a project member reply with the speaker name', () => {
    render(
      <MessageRowV2
        message={{
          id: 'member-reply',
          type: 'assistant',
          content: '我来处理这件事。',
          agentName: '小林',
          agentRole: 'engineer',
          timestamp: TIMESTAMP,
        }}
        prevMessage={null}
        provider="pilotdeck"
        selectedProject={null}
        createDiff={() => []}
      />,
    );

    expect(screen.getByTestId('assistant-message-speaker').textContent).toBe('小林');
    expect(screen.getByTestId('assistant-message-time').getAttribute('datetime')).toBe(TIMESTAMP);
  });

  it('labels the default agent reply with the main agent identity', () => {
    render(
      <MessageRowV2
        message={{ id: 'default-reply', type: 'assistant', content: '好的。', timestamp: TIMESTAMP }}
        prevMessage={null}
        provider="pilotdeck"
        selectedProject={null}
        createDiff={() => []}
      />,
    );

    // 主 agent 没有名字，但回复照样要带身份标签、图标和颜色。
    const speaker = screen.getByTestId('assistant-message-speaker');
    expect(speaker.textContent).toBe('主agent');
    expect(speaker.getAttribute('data-speaker-key')).toBe('main');
    expect(speaker.className).toContain('text-zinc');
    expect(screen.getByTestId('assistant-message-time').getAttribute('datetime')).toBe(TIMESTAMP);
  });

  it('gives the default agent reply a different color than a project member', () => {
    const { unmount } = render(
      <MessageRowV2
        message={{ id: 'default-reply', type: 'assistant', content: '好的。', timestamp: TIMESTAMP }}
        prevMessage={null}
        provider="pilotdeck"
        selectedProject={null}
        createDiff={() => []}
      />,
    );
    const mainClass = screen.getByTestId('assistant-message-speaker').className;
    unmount();

    render(
      <MessageRowV2
        message={{
          id: 'member-reply',
          type: 'assistant',
          content: '我来处理这件事。',
          agentName: '审查员',
          agentRole: 'reviewer',
          timestamp: TIMESTAMP,
        }}
        prevMessage={null}
        provider="pilotdeck"
        selectedProject={null}
        createDiff={() => []}
      />,
    );
    const memberClass = screen.getByTestId('assistant-message-speaker').className;

    expect(memberClass).not.toBe(mainClass);
  });

  it('gives every message a visible time, user messages included', () => {
    render(
      <MessageRowV2
        message={{ id: 'user-1', type: 'user', content: '在吗', timestamp: TIMESTAMP }}
        prevMessage={null}
        provider="pilotdeck"
        selectedProject={null}
        createDiff={() => []}
      />,
    );

    const time = screen.getByTestId('user-message-time');
    expect(time.getAttribute('datetime')).toBe(TIMESTAMP);
    expect(time.textContent).not.toBe('');
  });
});
