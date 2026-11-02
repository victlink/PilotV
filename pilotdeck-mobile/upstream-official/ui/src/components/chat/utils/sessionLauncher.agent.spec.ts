import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../types/app';
import { regenerateLastSessionCommand, startSessionCommand } from './sessionLauncher';

const project = { name: 'demo', path: '/demo', fullPath: '/demo' } as Project;

describe('project agent propagation in session launch payloads', () => {
  it('forwards the selected project agent on the new-turn path', () => {
    const sendMessage = vi.fn();

    startSessionCommand({
      sendMessage,
      selectedProject: project,
      command: 'hello',
      agentId: 'agent-a',
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pilotdeck-command',
      options: expect.objectContaining({ agentId: 'agent-a' }),
    }));
  });

  it('forwards the selected project agent on the edit/resubmit path', () => {
    const sendMessage = vi.fn();

    regenerateLastSessionCommand({
      sendMessage,
      selectedProject: project,
      requestId: 'request-1',
      sessionId: 'web:session-1',
      expectedTurnId: 'turn-1',
      command: 'corrected request',
      agentId: 'agent-b',
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'regenerate-last-message',
      requestId: 'request-1',
      options: expect.objectContaining({ agentId: 'agent-b' }),
    }));
  });

  it('keeps the edit/resubmit path backward compatible without a project agent', () => {
    const sendMessage = vi.fn();

    regenerateLastSessionCommand({
      sendMessage,
      selectedProject: project,
      requestId: 'request-2',
      sessionId: 'web:session-1',
      expectedTurnId: 'turn-1',
      command: 'corrected request',
    });

    const [frame] = sendMessage.mock.calls[0] as [{ options: Record<string, unknown> }];
    expect(frame.options).not.toHaveProperty('agentId');
  });
});
