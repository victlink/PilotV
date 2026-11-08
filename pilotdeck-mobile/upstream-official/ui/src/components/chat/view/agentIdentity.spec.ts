// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  collectSpeakers,
  isSpeakerUtterance,
  messageMatchesSpeaker,
  resolveAgentIdentity,
  speakerKeyOfMessage,
} from './agentIdentity';

describe('agentIdentity', () => {
  it('gives the unnamed default agent the stable main key', () => {
    const identity = resolveAgentIdentity({ name: '', role: '' });
    expect(identity.key).toBe('main');
    expect(identity.roleLabelKey).toBeNull();
  });

  it('keys named agents by their name so filtering matches what the user sees', () => {
    expect(resolveAgentIdentity({ name: '小林', role: 'engineer' }).key).toBe('name:小林');
    expect(speakerKeyOfMessage({ agentName: '小林' })).toBe('name:小林');
    expect(speakerKeyOfMessage({})).toBe('main');
  });

  it('is stable for the same agent and different across agents', () => {
    const a1 = resolveAgentIdentity({ name: '审查员', role: 'reviewer' });
    const a2 = resolveAgentIdentity({ name: '审查员', role: 'reviewer' });
    const b = resolveAgentIdentity({ name: '执行员', role: 'executor' });

    expect(a1.key).toBe(a2.key);
    expect(a1.Icon).toBe(a2.Icon);
    expect(a1.textClass).toBe(a2.textClass);
    // 不同角色 → 不同配色与图标，避免两个 agent 长得一样。
    expect(a1.textClass).not.toBe(b.textClass);
    expect(a1.Icon).not.toBe(b.Icon);
  });

  it('maps known roles to their i18n label keys', () => {
    expect(resolveAgentIdentity({ name: 'x', role: 'commander' }).roleLabelKey).toBe(
      'projectTeam:roles.commander',
    );
    expect(resolveAgentIdentity({ name: 'x', role: 'reviewer' }).roleLabelKey).toBe(
      'projectTeam:roles.reviewer',
    );
  });

  it('matches a message to its own speaker only', () => {
    const message = { agentName: '小林', agentRole: 'engineer' };
    expect(messageMatchesSpeaker(message, 'name:小林')).toBe(true);
    expect(messageMatchesSpeaker(message, 'name:别人')).toBe(false);
    expect(messageMatchesSpeaker(message, 'main')).toBe(false);
  });

  it('does not treat tool calls as a speaker turn', () => {
    expect(isSpeakerUtterance({ type: 'assistant', content: '你好' })).toBe(true);
    expect(isSpeakerUtterance({ type: 'assistant', content: '', isToolUse: true })).toBe(false);
    expect(isSpeakerUtterance({ type: 'assistant', content: '', isThinking: true })).toBe(false);
    expect(isSpeakerUtterance({ type: 'assistant', content: '', isAgentActivity: true })).toBe(false);
    expect(isSpeakerUtterance({ type: 'user', content: '你好' })).toBe(false);
  });

  it('collects distinct speakers from agents, participants and messages', () => {
    const speakers = collectSpeakers({
      agents: [{ id: 'a1', name: '小林', role: 'engineer' }],
      participants: [{ agentId: 'a2', name: '审查员', role: 'reviewer' }],
      messages: [
        { agentName: '小林', agentRole: 'engineer' },
        { agentName: '审查员', agentRole: 'reviewer' },
      ],
    });

    const keys = speakers.map((s) => s.identity.key);
    expect(keys).toContain('name:小林');
    expect(keys).toContain('name:审查员');
    expect(keys).toContain('main');
    // 同一个 agent 出现在多个来源里也只出现一次。
    expect(new Set(keys).size).toBe(keys.length);
  });
});
