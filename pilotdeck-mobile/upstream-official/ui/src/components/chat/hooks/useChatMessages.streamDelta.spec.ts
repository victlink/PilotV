import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { normalizedToChatMessages } from './useChatMessages';

describe('normalizedToChatMessages stream_delta metadata', () => {
  it('preserves agent name and role on streaming assistant messages', () => {
    const messages: NormalizedMessage[] = [{
      id: 'stream-1',
      sessionId: 'session-1',
      provider: 'pilotdeck',
      timestamp: '2026-08-07T00:00:00.000Z',
      kind: 'stream_delta',
      content: 'Hello',
      model: 'model-1',
      agentName: 'Ada',
      agentRole: 'reviewer',
    }];

    expect(normalizedToChatMessages(messages)[0]).toMatchObject({
      type: 'assistant',
      content: 'Hello',
      agentName: 'Ada',
      agentRole: 'reviewer',
    });
  });
});
