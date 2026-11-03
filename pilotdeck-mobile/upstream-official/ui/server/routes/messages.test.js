import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('message routes', () => {
  it('retains block IDs in the HTTP history returned to the browser', async () => {
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(),
      getProjectAgentRunForTurn: vi.fn(() => null),
      isGatewayUnavailableError: () => false,
      withPilotDeckGatewayReadRetry: vi.fn(async () => ({ messages: [
        { id: 'history-1', kind: 'thinking', text: 'same', turnId: 'turn-1', blockId: 'response-1:thinking:0' },
        { id: 'history-2', kind: 'text', role: 'assistant', text: 'same', turnId: 'turn-1', blockId: 'response-1:text:0' },
      ] })),
    }));
    const { default: routes } = await import('./messages.js');
    const app = express();
    app.use('/api/sessions', routes);
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const response = await nativeFetch(`http://127.0.0.1:${port}/api/sessions/session/messages`);
      expect((await response.json()).messages.map(message => message.blockId))
        .toEqual(['response-1:thinking:0', 'response-1:text:0']);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('labels member replies with the speaker of that turn', async () => {
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(),
      getProjectAgentRunForTurn: vi.fn((sessionId, turnId) => (
        turnId === 'turn-1' ? { agentId: 'agent-1', name: '小林', role: 'engineer' } : null
      )),
      isGatewayUnavailableError: () => false,
      withPilotDeckGatewayReadRetry: vi.fn(async () => ({ messages: [
        { id: 'history-1', kind: 'text', role: 'assistant', text: '好的', turnId: 'turn-1' },
        { id: 'history-2', kind: 'text', role: 'user', text: '在吗', turnId: 'turn-2' },
      ] })),
    }));
    const { default: routes } = await import('./messages.js');
    const app = express();
    app.use('/api/sessions', routes);
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const response = await nativeFetch(`http://127.0.0.1:${port}/api/sessions/session/messages`);
      const { messages } = await response.json();
      expect(messages[0].agentName).toBe('小林');
      expect(messages[0].agentRole).toBe('engineer');
      // 默认 Agent 的回复（查不到发言人）不带名字。
      expect(messages[1].agentName).toBeUndefined();
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
  it.each([['Gateway WebSocket is not connected.', 503, 'gateway_unavailable'], ['Transcript read failed', 500, 'session_messages_read_failed']])('reports read failure %s instead of a successful empty transcript', async (message, status, code) => {
    vi.doMock('../pilotdeck-bridge.js', () => ({
      getPilotDeckGateway: vi.fn(),
      isGatewayUnavailableError: (error) => /Gateway WebSocket/i.test(error?.message || ''),
      withPilotDeckGatewayReadRetry: vi.fn(async () => {
        throw new Error(message);
      }),
    }));
    const { default: routes } = await import('./messages.js');
    const app = express();
    app.use('/api/sessions', routes);
    const server = app.listen(0);

    try {
      const { port } = server.address();
      const response = await nativeFetch(
        `http://127.0.0.1:${port}/api/sessions/session-1/messages?projectPath=/workspace/project`,
      );
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
