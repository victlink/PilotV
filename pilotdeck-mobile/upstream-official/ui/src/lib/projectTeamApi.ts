/**
 * 项目团队配置的网络层。
 *
 * 后端路由（受 JWT 保护）：
 *   GET /api/project-team?projectRoot=<项目绝对路径>
 *   PUT /api/project-team?projectRoot=<项目绝对路径>
 *
 * PUT 必须回传当前 revision；后端用乐观锁判断，写入期间配置被别人改过
 * 会返回 409，调用方需要重新读取后再提交。
 */

import { authenticatedFetch } from '../utils/api';

import {
    PROJECT_TEAM_CONFIG_VERSION,
    ProjectTeamAgent,
    ProjectTeamCollaboration,
    normalizeProjectTeamConfig,
} from './projectTeam';

export const PROJECT_TEAM_API_BASE = '/api/project-team';
export type ExecutionMode = 'autoSplit' | 'solo';

export async function sessionExecutionMode(projectRoot: string, sessionKey: string, executionMode?: ExecutionMode): Promise<ExecutionMode> {
    const response = await authenticatedFetch(`${PROJECT_TEAM_API_BASE}/session-execution-mode?projectRoot=${encodeURIComponent(projectRoot)}&sessionKey=${encodeURIComponent(sessionKey)}`, {
        method: executionMode === undefined ? 'GET' : 'PUT',
        ...(executionMode !== undefined ? { body: JSON.stringify({ executionMode }) } : {}),
    });
    if (!response.ok) throw new ProjectTeamRequestError(await readErrorDetail(response) || 'Could not load or save execution mode.', response.status);
    const result = (await response.json()).executionMode;
    if (result !== 'autoSplit' && result !== 'solo') throw new Error('Invalid session execution mode.');
    return result;
}

// Missing agentId follows defaults; null explicitly disables team fallback.
export async function sessionAgentBinding(projectRoot: string, sessionKey: string, agentId?: string | null): Promise<string | null | undefined> {
    const response = await authenticatedFetch(`${PROJECT_TEAM_API_BASE}/session-agent?projectRoot=${encodeURIComponent(projectRoot)}&sessionKey=${encodeURIComponent(sessionKey)}`, {
        method: agentId === undefined ? 'GET' : 'PUT',
        ...(agentId !== undefined ? { body: JSON.stringify({ agentId }) } : {}),
    });
    if (!response.ok) throw new ProjectTeamRequestError(await readErrorDetail(response) || '会话角色加载或保存失败', response.status);
    return (await response.json()).agentId;
}

/** 后端返回 409 时抛出，调用方据此提示"配置已被他人修改"。 */
export class ProjectTeamConflictError extends Error {
    constructor(message = '项目团队配置已被其他窗口修改，请重新加载后再保存。') {
        super(message);
        this.name = 'ProjectTeamConflictError';
    }
}

export class ProjectTeamRequestError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'ProjectTeamRequestError';
        this.status = status;
    }
}

function teamUrl(projectRoot: string): string {
    return `${PROJECT_TEAM_API_BASE}?projectRoot=${encodeURIComponent(projectRoot)}`;
}

async function readErrorDetail(response: Response): Promise<string> {
    try {
        const body = await response.json() as { error?: string; message?: string } | null;
        return body?.error || body?.message || '';
    } catch {
        return '';
    }
}

/** 读取项目团队配置。 */
export async function fetchProjectTeam(
    projectRoot: string,
    options: { signal?: AbortSignal } = {},
): Promise<ReturnType<typeof normalizeProjectTeamConfig>> {
    const response = await authenticatedFetch(teamUrl(projectRoot), {
        method: 'GET',
        ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new ProjectTeamRequestError(
            `读取项目团队配置失败（HTTP ${response.status}${detail ? `：${detail}` : ''}）`,
            response.status,
        );
    }
    const data = await response.json();
    return normalizeProjectTeamConfig(data);
}

/**
 * 保存项目团队配置。
 *
 * @param revision 当前已知的 revision；为空时按后端初始 revision "0" 提交。
 */
export async function saveProjectTeam(input: {
    projectRoot: string;
    revision?: string;
    agents: ProjectTeamAgent[];
    collaboration?: ProjectTeamCollaboration;
}): Promise<ReturnType<typeof normalizeProjectTeamConfig>> {
    const response = await authenticatedFetch(teamUrl(input.projectRoot), {
        method: 'PUT',
        body: JSON.stringify({
            version: PROJECT_TEAM_CONFIG_VERSION,
            revision: input.revision || '0',
            collaboration: input.collaboration ?? { mode: 'manual' },
            agents: input.agents,
        }),
    });

    if (response.status === 409) {
        const detail = await readErrorDetail(response);
        throw new ProjectTeamConflictError(detail || undefined);
    }
    if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new ProjectTeamRequestError(
            `保存项目团队配置失败（HTTP ${response.status}${detail ? `：${detail}` : ''}）`,
            response.status,
        );
    }

    const data = await response.json();
    return normalizeProjectTeamConfig(data);
}
