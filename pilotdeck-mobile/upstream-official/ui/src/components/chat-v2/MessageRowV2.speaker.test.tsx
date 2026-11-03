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

  it('keeps the default agent reply unnamed but still timed', () => {
    render(
      <MessageRowV2
        message={{ id: 'default-reply', type: 'assistant', content: '好的。', timestamp: TIMESTAMP }}
        prevMessage={null}
        provider="pilotdeck"
        selectedProject={null}
        createDiff={() => []}
      />,
    );

    expect(screen.queryByTestId('assistant-message-speaker')).toBeNull();
    expect(screen.getByTestId('assistant-message-time').getAttribute('datetime')).toBe(TIMESTAMP);
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
