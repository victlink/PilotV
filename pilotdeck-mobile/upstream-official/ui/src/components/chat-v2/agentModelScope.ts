/**
 * 「这一轮由谁执行」与「这一轮用哪个模型」的作用域判定。
 *
 * 背景：输入框下方的 Agent 选择器决定这一轮由哪个项目成员执行，模型菜单决定
 * 这一轮用哪个模型。两者必须解耦——否则在选中某个 Agent 时改模型，会把会话
 * 默认模型一起改掉，于是其它「跟随会话模型」的 Agent 也跟着换成同一个模型，
 * 看起来就像「所有 Agent 的模型被串改了」。
 *
 * 规则：
 * - 未选中 Agent → 模型作用域是「会话」，改的是会话默认模型。
 * - 选中 Agent   → 模型作用域是「该 Agent」，改的是该 Agent 的专属模型
 *   （写回 `.pilotdeck/project-team.json`）；该 Agent 没配专属模型时它
 *   「跟随会话模型」，此时改模型仍然只改会话默认模型，不会波及其它 Agent。
 *
 * 本文件只做纯判定，不碰网络与状态，方便单测。
 */
import type { ProjectAgentModel, ProjectTeamAgent } from '../../lib/projectTeam';

export type AgentModelScope = {
  /** 模型菜单当前作用在哪个作用域上。 */
  scope: 'session' | 'agent';
  /** 作用域为 agent 时，被作用的项目成员 id。 */
  agentId: string | null;
  /** 作用域为 agent 时，被作用的项目成员名字。 */
  agentName: string | null;
  /** 该成员配置的专属模型；null 表示跟随会话模型。 */
  model: ProjectAgentModel | null;
  /** 该成员当前是否跟随会话默认模型。 */
  followsSession: boolean;
};

/**
 * 解析当前模型作用域。
 *
 * @param agents 当前项目的项目成员列表（未启用的成员不会传进来）。
 * @param selectedAgentId 输入框下方选中的成员 id；null 表示走默认 Agent。
 */
export function resolveAgentModelScope(
  agents: ProjectTeamAgent[] | null | undefined,
  selectedAgentId: string | null | undefined,
): AgentModelScope {
  const list = Array.isArray(agents) ? agents : [];
  const agent = selectedAgentId
    ? list.find((item) => item && item.id === selectedAgentId) ?? null
    : null;
  if (!agent) {
    return {
      scope: 'session',
      agentId: null,
      agentName: null,
      model: null,
      followsSession: true,
    };
  }
  const model = agent.model
    && typeof agent.model.provider === 'string'
    && typeof agent.model.model === 'string'
    ? { provider: agent.model.provider, model: agent.model.model }
    : null;
  return {
    scope: 'agent',
    agentId: agent.id,
    agentName: agent.name,
    model,
    followsSession: model === null,
  };
}

/**
 * 把模型目录里选中的条目转成项目团队配置里的成员模型。
 *
 * 项目团队配置里的模型只有 `{provider, model}` 两级（没有 reasoning / speed），
 * 因此这里只取这两项；调用方负责把它写回配置文件。
 */
export function toAgentModel(
  item: { provider: string; model: string } | null | undefined,
): ProjectAgentModel | null {
  if (!item) return null;
  const provider = typeof item.provider === 'string' ? item.provider.trim() : '';
  const model = typeof item.model === 'string' ? item.model.trim() : '';
  if (!provider || !model) return null;
  return { provider, model };
}

/**
 * 在成员列表里替换某个成员的专属模型。
 *
 * 纯函数，便于单测「只改一个成员、其它成员原样保留」。
 */
export function withAgentModel(
  agents: ProjectTeamAgent[],
  agentId: string,
  model: ProjectAgentModel | null,
): ProjectTeamAgent[] {
  return agents.map((agent) => (
    agent.id === agentId ? { ...agent, model } : agent
  ));
}
