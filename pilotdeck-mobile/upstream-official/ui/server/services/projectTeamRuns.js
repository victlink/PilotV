/**
 * 记录「哪一轮对话是谁在回」。
 *
 * 一轮对话会以用户选中的项目成员身份跑完（见 projectTeamRuntime.js），所以
 * 这一轮里的所有回复都属于该成员。bridge 在 submitTurn 时把映射记下来，
 * 消息路由再按 turnId 读回去，前端据此给回复标上发言人名字。
 *
 * 默认 Agent（没有选中任何成员）不写映射，前端自然就不显示名字。
 */

/** 记录条数上限：先挤掉最老的轮次，避免 sidecar 无限变大。 */
const MAX_TRACKED_RUNS = 200;

/**
 * 记下一轮对话的发言人。
 *
 * @param {object} state 会话状态，写入 state.projectAgentRuns。
 * @param {{agentId?: string, agent?: {name?: string, role?: string}}} runtime
 * @param {string} turnId 这一轮的 run/turn id。
 * @returns {{agentId: string, name: string, role: string} | null}
 */
export function recordProjectAgentRun(state, runtime, turnId) {
    if (!state || !runtime || !runtime.agent) return null;
    const name = typeof runtime.agent.name === 'string' ? runtime.agent.name : '';
    if (!name) return null;
    if (typeof turnId !== 'string' || !turnId) return null;

    if (!state.projectAgentRuns || typeof state.projectAgentRuns !== 'object') {
        state.projectAgentRuns = {};
    }
    const runs = state.projectAgentRuns;
    runs[turnId] = {
        agentId: typeof runtime.agentId === 'string' ? runtime.agentId : '',
        name,
        role: typeof runtime.agent.role === 'string' ? runtime.agent.role : '',
    };

    const keys = Object.keys(runs);
    if (keys.length > MAX_TRACKED_RUNS) {
        for (const key of keys.slice(0, keys.length - MAX_TRACKED_RUNS)) {
            delete runs[key];
        }
    }
    return runs[turnId];
}

/**
 * 查一轮对话的发言人。
 *
 * @param {Record<string, {agentId?: string, name?: string, role?: string}> | undefined} runs
 * @param {string | undefined} turnId
 * @returns {{agentId: string, name: string, role: string} | null}
 */
export function getProjectAgentRun(runs, turnId) {
    if (!runs || typeof runs !== 'object') return null;
    if (typeof turnId !== 'string' || !turnId) return null;
    const entry = runs[turnId];
    if (!entry || typeof entry.name !== 'string' || !entry.name) return null;
    return {
        agentId: typeof entry.agentId === 'string' ? entry.agentId : '',
        name: entry.name,
        role: typeof entry.role === 'string' ? entry.role : '',
    };
}

/**
 * 把 sidecar 里存下来的原始映射整理成干净的结构。
 *
 * @param {unknown} parsed
 * @returns {Record<string, {agentId: string, name: string, role: string}>}
 */
export function normalizeProjectAgentRuns(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const runs = {};
    for (const [turnId, entry] of Object.entries(parsed)) {
        if (typeof turnId !== 'string' || !turnId) continue;
        if (!entry || typeof entry !== 'object') continue;
        const name = typeof entry.name === 'string' ? entry.name : '';
        if (!name) continue;
        runs[turnId] = {
            agentId: typeof entry.agentId === 'string' ? entry.agentId : '',
            name,
            role: typeof entry.role === 'string' ? entry.role : '',
        };
    }
    return runs;
}
