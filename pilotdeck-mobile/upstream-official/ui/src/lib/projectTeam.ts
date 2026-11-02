/**
 * 项目团队（Project Team）的前端数据契约。
 *
 * 与后端 `ui/server/services/projectTeamConfig.js` 保持一一对应：
 *   GET /api/project-team?projectRoot=<绝对路径>
 *   PUT /api/project-team?projectRoot=<绝对路径>
 *
 * 落盘位置是 `<项目根>/.pilotdeck/project-team.json`，形状：
 *   {
 *     version: 1,
 *     revision: "<不透明字符串>",       // 乐观锁，写入时必须回传当前 revision
 *     collaboration: { mode: 'manual' | 'commander' | 'automated' },
 *     agents: [{
 *       id, name, description, role, roleDefinition,
 *       model: { provider, model } | null,   // null = 跟随会话默认模型
 *       enabled,
 *       permissions: { toolAccess, allowedTools, deniedTools, network, writeScope, requireApproval },
 *       reportsTo: string | null,            // 协作：上级 agent 的 id
 *     }]
 *   }
 *
 * 这里只放纯函数与类型，不做任何网络请求；网络层见 `projectTeamApi.ts`。
 */

/**
 * 配置版本。后端只接受 `version === 1`（`validateProjectTeamPayload`），
 * 所以这里固定成字面量类型，前端不会把别的版本号发出去。
 */
export const PROJECT_TEAM_CONFIG_VERSION = 1 as const;
export type ProjectTeamConfigVersion = typeof PROJECT_TEAM_CONFIG_VERSION;

/**
 * 容量与长度上限，与后端 `ui/server/services/projectTeamConfig.js` 保持一致。
 * 前端提前拦截，避免用户白跑一次必然 400 的请求。
 */
export const PROJECT_TEAM_MAX_AGENTS = 32;
/**
 * **单个列表**的条目上限。后端 `validateToolEntries` 对白名单与黑名单分别判断，
 * 两个列表各自最多 200 条（合计最多 400 条），没有跨列表的总量上限。
 */
export const PROJECT_TEAM_MAX_TOOL_ENTRIES = 200;
export const PROJECT_TEAM_MAX_NAME_LENGTH = 120;
export const PROJECT_TEAM_MAX_DESCRIPTION_LENGTH = 1000;
export const PROJECT_TEAM_MAX_ROLE_DEFINITION_LENGTH = 4000;

/** 与后端 `MODEL_PROVIDER_PATTERN` / `MODEL_ID_PATTERN` 完全一致。 */
export const PROJECT_TEAM_MODEL_PROVIDER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const PROJECT_TEAM_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;

export type ProjectAgentRole = 'commander' | 'executor' | 'reviewer' | 'supervisor';
export type ProjectToolAccessMode = 'allow-list' | 'all';
/** 工具条目的两个列表；后端对它们分别限制条目数量。 */
export type ProjectToolListName = 'allowedTools' | 'deniedTools';
export type ProjectNetworkMode = 'none' | 'ask' | 'allow';
export type ProjectWriteScope = 'read-only' | 'project' | 'ask';
export type ProjectCollaborationMode = 'manual' | 'commander' | 'automated';

export const PROJECT_TEAM_ROLES: ProjectAgentRole[] = [
    'commander',
    'executor',
    'reviewer',
    'supervisor',
];

export const PROJECT_TEAM_TOOL_ACCESS_MODES: ProjectToolAccessMode[] = ['allow-list', 'all'];
export const PROJECT_TEAM_NETWORK_MODES: ProjectNetworkMode[] = ['none', 'ask', 'allow'];
export const PROJECT_TEAM_WRITE_SCOPES: ProjectWriteScope[] = ['read-only', 'project', 'ask'];
export const PROJECT_TEAM_COLLABORATION_MODES: ProjectCollaborationMode[] = [
    'manual',
    'commander',
    'automated',
];

export type ProjectAgentPermissions = {
    /** allow-list = 只用白名单里的工具；all = 沿用会话的全部工具。 */
    toolAccess: ProjectToolAccessMode;
    /** 允许使用的工具条目（read_file / mcp:github / bash:git log:*）。 */
    allowedTools: string[];
    /** 禁止使用的工具条目。 */
    deniedTools: string[];
    /** 联网策略：none 不联网，ask 每次询问，allow 直接放行。 */
    network: ProjectNetworkMode;
    /** 写入范围：read-only 只读，project 项目内可写，ask 每次询问。 */
    writeScope: ProjectWriteScope;
    /** 是否需要人工确认高风险操作。 */
    requireApproval: boolean;
};

export type ProjectAgentModel = {
    provider: string;
    model: string;
};

export type ProjectTeamAgent = {
    id: string;
    name: string;
    description: string;
    role: ProjectAgentRole;
    roleDefinition: string;
    /** null 表示跟随会话默认模型。 */
    model: ProjectAgentModel | null;
    enabled: boolean;
    permissions: ProjectAgentPermissions;
    /** 协作：向谁汇报（同一团队内的 agent id）。 */
    reportsTo: string | null;
};

export type ProjectTeamCollaboration = {
    mode: ProjectCollaborationMode;
};

export type ProjectTeamConfig = {
    /** 后端只接受 `version === 1`。 */
    version: ProjectTeamConfigVersion;
    revision: string;
    collaboration: ProjectTeamCollaboration;
    agents: ProjectTeamAgent[];
};

export const DEFAULT_PROJECT_AGENT_PERMISSIONS: ProjectAgentPermissions = {
    toolAccess: 'all',
    allowedTools: [],
    deniedTools: [],
    network: 'ask',
    writeScope: 'project',
    requireApproval: true,
};

export const DEFAULT_PROJECT_TEAM_COLLABORATION: ProjectTeamCollaboration = {
    mode: 'manual',
};

/** 各角色的默认说明，新建 Agent 时直接带出来。 */
export const PROJECT_AGENT_ROLE_TEMPLATES: Record<
    ProjectAgentRole,
    { labelKey: string; description: string; roleDefinition: string }
> = {
    commander: {
        labelKey: 'projectTeam.roles.commander',
        description: '拆解任务、分派工作、汇总结论',
        roleDefinition: '负责拆解需求与分派任务，只做协调，不直接改代码。',
    },
    executor: {
        labelKey: 'projectTeam.roles.executor',
        description: '按分工实现并自测',
        roleDefinition: '负责具体实现，完成后自测并汇报改动范围与风险。',
    },
    reviewer: {
        labelKey: 'projectTeam.roles.reviewer',
        description: '审查实现与回归风险',
        roleDefinition: '只做审查与验证，不修改代码；给出可复现的问题清单。',
    },
    supervisor: {
        labelKey: 'projectTeam.roles.supervisor',
        description: '盯进度、兜底与合规检查',
        roleDefinition: '负责流程监督与兜底：进度、阻塞项与合规性检查。',
    },
};

/** 工具授权面板的候选条目，语法与权限系统一致。 */
export const PROJECT_TEAM_TOOL_CATALOG: string[] = [
    'read_file',
    'write_file',
    'edit_file',
    'glob',
    'grep',
    'bash:git status:*',
    'bash:git log:*',
    'bash:git diff:*',
    'bash:rm:*',
    'bash:sudo:*',
    'web_fetch',
    'web_search',
    'agent',
    'task_create',
];

const TOOL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const TOOL_SCOPE_PATTERN = /^[A-Za-z0-9_.\-/* ]*(:\*)?$/;

/**
 * 工具条目语法与后端保持一致：工具名（read_file）、工具组（mcp:github）
 * 或命令范围（bash:git log:*）。这里只做形状校验，不会执行任何命令。
 */
export function isValidToolEntry(entry: string): boolean {
    if (typeof entry !== 'string') return false;
    const value = entry.trim();
    if (!value || value.length > 200) return false;
    const separator = value.indexOf(':');
    if (separator === -1) return TOOL_NAME_PATTERN.test(value);
    return TOOL_NAME_PATTERN.test(value.slice(0, separator))
        && TOOL_SCOPE_PATTERN.test(value.slice(separator + 1));
}

/** 去掉空白与重复项，保留原有顺序。 */
export function normalizeToolEntries(entries: unknown): string[] {
    if (!Array.isArray(entries)) return [];
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const entry of entries) {
        if (typeof entry !== 'string') continue;
        const trimmed = entry.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        normalized.push(trimmed);
    }
    return normalized;
}

export function normalizeProjectAgentPermissions(value: unknown): ProjectAgentPermissions {
    const raw = (value && typeof value === 'object' ? value : {}) as Partial<ProjectAgentPermissions>;
    return {
        toolAccess: PROJECT_TEAM_TOOL_ACCESS_MODES.includes(raw.toolAccess as ProjectToolAccessMode)
            ? (raw.toolAccess as ProjectToolAccessMode)
            : DEFAULT_PROJECT_AGENT_PERMISSIONS.toolAccess,
        allowedTools: normalizeToolEntries(raw.allowedTools),
        deniedTools: normalizeToolEntries(raw.deniedTools),
        network: PROJECT_TEAM_NETWORK_MODES.includes(raw.network as ProjectNetworkMode)
            ? (raw.network as ProjectNetworkMode)
            : DEFAULT_PROJECT_AGENT_PERMISSIONS.network,
        writeScope: PROJECT_TEAM_WRITE_SCOPES.includes(raw.writeScope as ProjectWriteScope)
            ? (raw.writeScope as ProjectWriteScope)
            : DEFAULT_PROJECT_AGENT_PERMISSIONS.writeScope,
        requireApproval: typeof raw.requireApproval === 'boolean'
            ? raw.requireApproval
            : DEFAULT_PROJECT_AGENT_PERMISSIONS.requireApproval,
    };
}

export function normalizeProjectAgent(value: unknown): ProjectTeamAgent | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Partial<ProjectTeamAgent>;
    if (typeof raw.id !== 'string' || !raw.id) return null;

    const role: ProjectAgentRole = PROJECT_TEAM_ROLES.includes(raw.role as ProjectAgentRole)
        ? (raw.role as ProjectAgentRole)
        : 'executor';

    const model = raw.model && typeof raw.model === 'object'
        && typeof (raw.model as ProjectAgentModel).provider === 'string'
        && typeof (raw.model as ProjectAgentModel).model === 'string'
        ? { provider: raw.model.provider, model: raw.model.model }
        : null;

    return {
        id: raw.id,
        name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
        description: typeof raw.description === 'string' ? raw.description : '',
        role,
        roleDefinition: typeof raw.roleDefinition === 'string' ? raw.roleDefinition : '',
        model,
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
        permissions: normalizeProjectAgentPermissions(raw.permissions),
        reportsTo: typeof raw.reportsTo === 'string' && raw.reportsTo ? raw.reportsTo : null,
    };
}

export function normalizeProjectTeamConfig(value: unknown): ProjectTeamConfig {
    const raw = (value && typeof value === 'object' ? value : {}) as Partial<ProjectTeamConfig>;
    const collaborationMode = raw.collaboration?.mode;
    return {
        // 后端只接受 version === 1；前端也只会说 1，其它值一律归一化成 1。
        version: PROJECT_TEAM_CONFIG_VERSION,
        revision: typeof raw.revision === 'string' ? raw.revision : '0',
        collaboration: {
            mode: PROJECT_TEAM_COLLABORATION_MODES.includes(collaborationMode as ProjectCollaborationMode)
                ? (collaborationMode as ProjectCollaborationMode)
                : DEFAULT_PROJECT_TEAM_COLLABORATION.mode,
        },
        agents: Array.isArray(raw.agents)
            ? raw.agents
                .map(normalizeProjectAgent)
                .filter((agent): agent is ProjectTeamAgent => agent !== null)
            : [],
    };
}

/** 由名字生成一个稳定的 agent id（后端只允许 A-Za-z0-9._-）。 */
export function createProjectAgentId(name: string): string {
    const base = String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return base || `agent-${Math.random().toString(36).slice(2, 8)}`;
}

export function createProjectTeamAgent(
    role: ProjectAgentRole,
    overrides: Partial<ProjectTeamAgent> = {},
): ProjectTeamAgent {
    const template = PROJECT_AGENT_ROLE_TEMPLATES[role] ?? PROJECT_AGENT_ROLE_TEMPLATES.executor;
    const name = overrides.name ?? role;
    return {
        id: overrides.id ?? createProjectAgentId(name),
        name,
        description: overrides.description ?? template.description,
        role,
        roleDefinition: overrides.roleDefinition ?? template.roleDefinition,
        model: overrides.model ?? null,
        enabled: overrides.enabled ?? true,
        permissions: normalizeProjectAgentPermissions(
            overrides.permissions ?? DEFAULT_PROJECT_AGENT_PERMISSIONS,
        ),
        reportsTo: overrides.reportsTo ?? null,
    };
}

/**
 * 回合里要注入给模型的角色说明。纯文本，模型自己看得懂即可。
 * `roleLabel` 由界面传入（走 i18n），避免这里硬编码语言。
 */
export function buildAgentBriefing(
    agent: ProjectTeamAgent,
    options: { roleLabel?: string; toolLabels?: { allowed?: string; denied?: string } } = {},
): string {
    const lines: string[] = [];
    lines.push(`你现在是本项目的 Agent「${agent.name}」。`);
    if (options.roleLabel) lines.push(`角色：${options.roleLabel}`);
    if (agent.description) lines.push(`职责：${agent.description}`);
    if (agent.roleDefinition) lines.push(`角色定义：${agent.roleDefinition}`);

    const permissions = agent.permissions;
    if (permissions.toolAccess === 'allow-list') {
        const allowed = permissions.allowedTools.join(', ') || '（空）';
        lines.push(`可用工具（白名单）：${allowed}`);
    }
    if (permissions.deniedTools.length > 0) {
        const denied = permissions.deniedTools.join(', ');
        lines.push(`禁止使用：${denied}`);
    }
    if (permissions.network !== 'allow') {
        lines.push(`联网策略：${permissions.network}`);
    }
    if (permissions.writeScope !== 'project') {
        lines.push(`写入范围：${permissions.writeScope}`);
    }
    if (permissions.requireApproval) {
        lines.push('高风险操作需要先向我确认。');
    }

    return lines.join('\n');
}

/**
 * 前端侧的草稿问题种类。与后端的 400 校验一一对应：
 * 只描述"哪一条不合法"，具体文案由 view 层的 `describeDraftIssue` 负责。
 */
export type ProjectTeamDraftIssue =
    | { kind: 'agentNameEmpty'; index: number }
    | { kind: 'agentNameTooLong'; index: number; max: number }
    | { kind: 'descriptionTooLong'; index: number; max: number }
    | { kind: 'roleDefinitionTooLong'; index: number; max: number }
    | { kind: 'modelProviderInvalid'; index: number }
    | { kind: 'modelIdInvalid'; index: number }
    /** `list` 指明超限的是白名单还是黑名单（后端分别限制这两个列表）。 */
    | { kind: 'tooManyToolEntries'; index: number; max: number; list: ProjectToolListName };

export type ProjectTeamDraftValidationResult =
    | { ok: true }
    | {
        ok: false;
        issue: ProjectTeamDraftIssue;
        /** 稳定的机器可读错误键，即使缺少 i18n 资源也能定位问题。 */
        errorKey: string;
        params?: Record<string, string>;
    };

const DRAFT_ISSUE_ERROR_KEYS: Record<ProjectTeamDraftIssue['kind'], string> = {
    agentNameEmpty: 'projectTeam.validation.agentNameEmpty',
    agentNameTooLong: 'projectTeam.validation.agentNameTooLong',
    descriptionTooLong: 'projectTeam.validation.descriptionTooLong',
    roleDefinitionTooLong: 'projectTeam.validation.roleDefinitionTooLong',
    modelProviderInvalid: 'projectTeam.validation.modelProviderInvalid',
    modelIdInvalid: 'projectTeam.validation.modelIdInvalid',
    tooManyToolEntries: 'projectTeam.validation.tooManyToolEntries',
};

function draftIssueParams(issue: ProjectTeamDraftIssue): Record<string, string> {
    const params: Record<string, string> = { index: String(issue.index + 1) };
    if ('max' in issue) params.max = String(issue.max);
    return params;
}

/**
 * 保存前的纯函数校验：把后端一定会拒绝的草稿挡在请求之前。
 *
 * 覆盖后端 `validateAgent` 中的长度上限、自定义模型正则与工具条目数量上限；
 * 工具条目"语法"由 `isValidToolEntry` 单独校验，两者都要过。
 */
export function validateProjectTeamDraft(
    agents: ProjectTeamAgent[],
): ProjectTeamDraftValidationResult {
    for (let index = 0; index < agents.length; index += 1) {
        const agent = agents[index];
        const name = typeof agent.name === 'string' ? agent.name : '';
        if (name.trim() === '') {
            return {
                ok: false,
                issue: { kind: 'agentNameEmpty', index },
                errorKey: DRAFT_ISSUE_ERROR_KEYS.agentNameEmpty,
                params: draftIssueParams({ kind: 'agentNameEmpty', index }),
            };
        }
        if (name.length > PROJECT_TEAM_MAX_NAME_LENGTH) {
            const issue: ProjectTeamDraftIssue = {
                kind: 'agentNameTooLong',
                index,
                max: PROJECT_TEAM_MAX_NAME_LENGTH,
            };
            return {
                ok: false,
                issue,
                errorKey: DRAFT_ISSUE_ERROR_KEYS.agentNameTooLong,
                params: draftIssueParams(issue),
            };
        }

        const description = typeof agent.description === 'string' ? agent.description : '';
        if (description.length > PROJECT_TEAM_MAX_DESCRIPTION_LENGTH) {
            const issue: ProjectTeamDraftIssue = {
                kind: 'descriptionTooLong',
                index,
                max: PROJECT_TEAM_MAX_DESCRIPTION_LENGTH,
            };
            return {
                ok: false,
                issue,
                errorKey: DRAFT_ISSUE_ERROR_KEYS.descriptionTooLong,
                params: draftIssueParams(issue),
            };
        }

        const roleDefinition = typeof agent.roleDefinition === 'string'
            ? agent.roleDefinition
            : '';
        if (roleDefinition.length > PROJECT_TEAM_MAX_ROLE_DEFINITION_LENGTH) {
            const issue: ProjectTeamDraftIssue = {
                kind: 'roleDefinitionTooLong',
                index,
                max: PROJECT_TEAM_MAX_ROLE_DEFINITION_LENGTH,
            };
            return {
                ok: false,
                issue,
                errorKey: DRAFT_ISSUE_ERROR_KEYS.roleDefinitionTooLong,
                params: draftIssueParams(issue),
            };
        }

        if (agent.model !== null && agent.model !== undefined) {
            const provider = typeof agent.model.provider === 'string' ? agent.model.provider : '';
            if (!PROJECT_TEAM_MODEL_PROVIDER_PATTERN.test(provider)) {
                const issue: ProjectTeamDraftIssue = { kind: 'modelProviderInvalid', index };
                return {
                    ok: false,
                    issue,
                    errorKey: DRAFT_ISSUE_ERROR_KEYS.modelProviderInvalid,
                    params: draftIssueParams(issue),
                };
            }
            const modelId = typeof agent.model.model === 'string' ? agent.model.model : '';
            if (!PROJECT_TEAM_MODEL_ID_PATTERN.test(modelId)) {
                const issue: ProjectTeamDraftIssue = { kind: 'modelIdInvalid', index };
                return {
                    ok: false,
                    issue,
                    errorKey: DRAFT_ISSUE_ERROR_KEYS.modelIdInvalid,
                    params: draftIssueParams(issue),
                };
            }
        }

        const permissions = agent.permissions;
        // 后端 `validateToolEntries` 对白名单与黑名单**分别**限制 200 条，
        // 前端必须用同样的口径，否则会拦掉后端其实接受的草稿。
        const toolLists: Array<{ list: ProjectToolListName; entries: string[] }> = [
            { list: 'allowedTools', entries: permissions ? permissions.allowedTools : [] },
            { list: 'deniedTools', entries: permissions ? permissions.deniedTools : [] },
        ];
        for (const { list, entries } of toolLists) {
            if (entries.length > PROJECT_TEAM_MAX_TOOL_ENTRIES) {
                const issue: ProjectTeamDraftIssue = {
                    kind: 'tooManyToolEntries',
                    index,
                    max: PROJECT_TEAM_MAX_TOOL_ENTRIES,
                    list,
                };
                return {
                    ok: false,
                    issue,
                    errorKey: DRAFT_ISSUE_ERROR_KEYS.tooManyToolEntries,
                    params: draftIssueParams(issue),
                };
            }
        }
    }

    return { ok: true };
}

function agentSignature(agent: ProjectTeamAgent): string {
    const permissions = agent.permissions;
    return [
        agent.id,
        agent.name,
        agent.description,
        agent.role,
        agent.roleDefinition,
        agent.model ? `${agent.model.provider}\u0000${agent.model.model}` : '',
        agent.enabled ? '1' : '0',
        permissions.toolAccess,
        permissions.allowedTools.join(','),
        permissions.deniedTools.join(','),
        permissions.network,
        permissions.writeScope,
        permissions.requireApproval ? '1' : '0',
        agent.reportsTo ?? '',
    ].join('\u0001');
}

/**
 * 草稿与已保存配置的稳定指纹，用来判断"是否有未保存的修改"。
 * 只覆盖会被 PUT 提交的字段，顺序敏感（Agent 的顺序本身有意义）。
 */
export function projectTeamDraftSignature(
    agents: ProjectTeamAgent[],
    collaboration: ProjectTeamCollaboration,
): string {
    return [
        agents.map(agentSignature).join('\u0002'),
        collaboration.mode,
    ].join('\u0003');
}

/** 草稿是否与已保存的配置存在差异。 */
export function isProjectTeamDraftDirty(
    draftAgents: ProjectTeamAgent[],
    draftCollaboration: ProjectTeamCollaboration,
    config: ProjectTeamConfig | null,
): boolean {
    if (!config) return false;
    return (
        projectTeamDraftSignature(draftAgents, draftCollaboration)
        !== projectTeamDraftSignature(config.agents, config.collaboration)
    );
}
