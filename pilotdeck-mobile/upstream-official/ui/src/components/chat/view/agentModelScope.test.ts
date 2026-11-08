import { describe, expect, it } from 'vitest';
import type { ProjectTeamAgent } from '../../../lib/projectTeam';
import { resolveAgentModelScope, toAgentModel, withAgentModel } from './agentModelScope';

const AGENTS = [
  {
    id: 'agent-commander',
    name: 'Ada',
    role: 'commander',
    enabled: true,
    model: null,
  },
  {
    id: 'agent-reviewer',
    name: 'Rob',
    role: 'reviewer',
    enabled: true,
    model: { provider: 'anthropic', model: 'claude-review' },
  },
] as unknown as ProjectTeamAgent[];

describe('resolveAgentModelScope', () => {
  it('uses the session scope when no agent is picked', () => {
    const scope = resolveAgentModelScope(AGENTS, null);
    expect(scope.scope).toBe('session');
    expect(scope.agentId).toBeNull();
    expect(scope.followsSession).toBe(true);
  });

  it('uses the session scope when the picked agent is unknown', () => {
    // 换了项目或成员被删掉之后，选中的 id 可能已经不存在了。
    const scope = resolveAgentModelScope(AGENTS, 'agent-ghost');
    expect(scope.scope).toBe('session');
    expect(scope.agentId).toBeNull();
  });

  it('scopes to the picked agent and reports its own model', () => {
    const scope = resolveAgentModelScope(AGENTS, 'agent-reviewer');
    expect(scope.scope).toBe('agent');
    expect(scope.agentId).toBe('agent-reviewer');
    expect(scope.agentName).toBe('Rob');
    expect(scope.model).toEqual({ provider: 'anthropic', model: 'claude-review' });
    expect(scope.followsSession).toBe(false);
  });

  it('marks an agent without its own model as following the session', () => {
    const scope = resolveAgentModelScope(AGENTS, 'agent-commander');
    expect(scope.scope).toBe('agent');
    expect(scope.model).toBeNull();
    expect(scope.followsSession).toBe(true);
  });

  it('survives a missing agent list', () => {
    expect(resolveAgentModelScope(undefined, 'agent-reviewer').scope).toBe('session');
    expect(resolveAgentModelScope(null, null).scope).toBe('session');
  });
});

describe('toAgentModel', () => {
  it('keeps provider and model only', () => {
    expect(toAgentModel({ provider: 'anthropic', model: 'claude-x' })).toEqual({
      provider: 'anthropic',
      model: 'claude-x',
    });
  });

  it('rejects incomplete entries', () => {
    expect(toAgentModel(null)).toBeNull();
    expect(toAgentModel(undefined)).toBeNull();
    expect(toAgentModel({ provider: '', model: 'claude-x' })).toBeNull();
    expect(toAgentModel({ provider: 'anthropic', model: '   ' })).toBeNull();
  });
});

describe('withAgentModel', () => {
  it('only rewrites the target member', () => {
    const next = withAgentModel(AGENTS, 'agent-commander', {
      provider: 'openai',
      model: 'gpt-x',
    });
    expect(next[0].model).toEqual({ provider: 'openai', model: 'gpt-x' });
    // 其它成员原样保留，不会被串改。
    expect(next[1].model).toEqual({ provider: 'anthropic', model: 'claude-review' });
    expect(AGENTS[0].model).toBeNull();
  });

  it('clears the model so the member follows the session again', () => {
    const next = withAgentModel(AGENTS, 'agent-reviewer', null);
    expect(next[1].model).toBeNull();
    expect(next[0].model).toBeNull();
  });
});
