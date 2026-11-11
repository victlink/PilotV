import { ProjectTeamConfigError, readProjectTeamConfig } from './projectTeamConfig.js';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolvePilotHome } from '../utils/pilotPaths.js';

function sessionBindingPath(projectRoot, sessionKey) {
    if (typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 512) {
        throw new ProjectTeamConfigError('A session key is required.', { statusCode: 400, code: 'SESSION_KEY_REQUIRED' });
    }
    const key = createHash('sha256').update(JSON.stringify([path.resolve(projectRoot), sessionKey])).digest('hex');
    return path.join(resolvePilotHome(), 'session-agent-bindings', `${key}.json`);
}

export function readSessionAgentBinding(projectRoot, sessionKey) {
    try {
        const value = JSON.parse(readFileSync(sessionBindingPath(projectRoot, sessionKey), 'utf8'));
        if (value.agentId !== null && typeof value.agentId !== 'string') throw new Error('Invalid session agent binding.');
        return value.agentId;
    } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
    }
}

function writeSessionAgentBinding(projectRoot, sessionKey, agentId) {
    const file = sessionBindingPath(projectRoot, sessionKey);
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temp, JSON.stringify({ agentId }), { mode: 0o600 });
        renameSync(temp, file);
    } finally {
        rmSync(temp, { force: true });
    }
}

export async function getSessionAgentBinding({ projectRoot, sessionKey, snapshotProvider = defaultSnapshotProvider }) {
    const config = await readProjectTeamConfig({ projectRoot, snapshotProvider });
    const agentId = readSessionAgentBinding(projectRoot, sessionKey);
    if (agentId != null && !config.agents.some(agent => agent.id === agentId && agent.enabled)) {
        throw new ProjectTeamConfigError(`Project agent is not enabled or does not exist: ${agentId}`, { statusCode: 404, code: 'PROJECT_AGENT_UNAVAILABLE' });
    }
    // JSON omits undefined (follow configured defaults); null explicitly opts
    // out of the team runtime, including commander fallback.
    return { agentId };
}

export async function setSessionAgentBinding({ projectRoot, sessionKey, agentId, snapshotProvider = defaultSnapshotProvider }) {
    if (agentId !== null && (typeof agentId !== 'string' || !agentId)) {
        throw new ProjectTeamConfigError('agentId must be a member id or null.', { statusCode: 400, code: 'PROJECT_AGENT_INVALID' });
    }
    const config = await readProjectTeamConfig({ projectRoot, snapshotProvider });
    if (agentId !== null && !config.agents.some(agent => agent.id === agentId && agent.enabled)) {
        throw new ProjectTeamConfigError(`Project agent is not enabled or does not exist: ${agentId}`, { statusCode: 404, code: 'PROJECT_AGENT_UNAVAILABLE' });
    }
    writeSessionAgentBinding(projectRoot, sessionKey, agentId);
    return { agentId };
}
import path from 'node:path';

async function defaultSnapshotProvider() {
    try {
        const { getProjectsSnapshot } = await import('../projects.js');
        return (await getProjectsSnapshot())?.projects ?? [];
    } catch {
        return [];
    }
}

const RESTRICTED_ROLES = new Set(['commander', 'reviewer', 'inspector']);
const READ_ONLY_TOOLS = ['read_file', 'grep', 'glob'];

function effectivePermissions(agent) {
    const permissions = agent.permissions;
    if (!RESTRICTED_ROLES.has(agent.role)) return permissions;
    return {
        ...permissions,
        toolAccess: 'allow-list',
        allowedTools: permissions.toolAccess === 'all'
            ? READ_ONLY_TOOLS
            : READ_ONLY_TOOLS.filter((tool) => permissions.allowedTools.includes(tool)),
        writeScope: 'read-only',
        network: 'none',
    };
}

export function buildProjectAgentBriefing(agent) {
    const lines = [`你现在是本项目的 Agent「${agent.name}」。`];
    if (agent.description) lines.push(`职责：${agent.description}`);
    if (agent.roleDefinition) lines.push(`角色定义：${agent.roleDefinition}`);
    const permissions = effectivePermissions(agent);
    if (permissions.toolAccess === 'allow-list') {
        lines.push(`可用工具（白名单）：${permissions.allowedTools.join(', ') || '（空）'}`);
    }
    if (permissions.deniedTools.length) lines.push(`禁止使用：${permissions.deniedTools.join(', ')}`);
    if (permissions.network !== 'allow') lines.push(`联网策略：${permissions.network}`);
    if (permissions.writeScope === 'project') {
        lines.push('写入范围：project（只允许写入项目目录内的文件，无法限定路径的写入工具不可用）。');
    } else {
        lines.push(`写入范围：${permissions.writeScope}`);
    }
    if (permissions.requireApproval) lines.push('高风险操作需要先向我确认。');
    return lines.join('\n');
}

/**
 * Tool capability classes used to derive a project agent's tool policy.
 *
 * - `NETWORK_TOOLS` reach the network on their own.
 * - `MCP_RESOURCE_TOOLS` read resources from MCP servers, which usually live
 *   outside the project and therefore reach the network.
 * - `MCP_TOOLS` are the MCP tools themselves. Their wire names are
 *   `mcp__<server>__<tool>`, so the wildcard covers every server. An MCP
 *   server can reach the network and write files, which means MCP tools
 *   inherit both the network and the write scope policy.
 * - `SHELL_TOOLS` run arbitrary code. They can reach the network and write
 *   outside any path scope, so a path restriction can never apply to them.
 * - `WRITE_TOOLS` are the direct filesystem writers. They are the only
 *   writers whose target path can be constrained to a directory.
 */
const NETWORK_TOOLS = ['web_fetch', 'web_search'];
const MCP_RESOURCE_TOOLS = ['read_mcp_resource', 'list_mcp_resources'];
const MCP_TOOLS = ['mcp*'];
const SHELL_TOOLS = ['bash', 'execute_code', 'agent', 'task_create'];
const WRITE_TOOLS = ['write_file', 'edit_file', 'edit_notebook'];

/**
 * Build the tool authorization policy for a project agent.
 *
 * The policy is enforced by the permission runtime before a tool runs:
 * `deny` is a hard boundary, `ask` requires a confirmation and `writeRoots`
 * confines filesystem writes to the listed directories.
 *
 * Write scope semantics:
 * - `read-only` denies every writer.
 * - `project` is a hard boundary: the direct writers are confined to the
 *   project root by `writeRoots`, and the writers that cannot be path scoped
 *   are denied. They must not be turned into an approval: the permission
 *   runtime approves an `ask` rule automatically in `bypassPermissions` mode
 *   (`finalizeAsk`), so an approval would turn the scope into a suggestion
 *   and let the agent write anywhere in the filesystem.
 * - `ask` is a confirmation boundary, not a scope: the write still lands
 *   wherever the tool decides, and `bypassPermissions` approves it. It is
 *   kept as-is because the configuration explicitly asks for a confirmation
 *   instead of a boundary.
 *
 * Precedence at runtime: a deny is checked before the exclusive allow list
 * and before an approval, so a scope derived deny also wins over an
 * explicitly allowed tool.
 *
 * @param {object} agent project agent configuration
 * @param {{ projectRoot?: string }} [options] root the agent is bound to
 */
export function buildProjectAgentToolPolicy(agent, { projectRoot } = {}) {
    const permissions = effectivePermissions(agent);
    const deny = new Set(permissions.deniedTools);
    const ask = new Set();

    // Everything that can reach the network without an explicit network tool.
    const networkCapable = [...NETWORK_TOOLS, ...MCP_RESOURCE_TOOLS, ...MCP_TOOLS, ...SHELL_TOOLS];
    // Everything that can write files without an explicit write tool.
    const writeCapable = [...WRITE_TOOLS, ...MCP_TOOLS, ...SHELL_TOOLS];
    // The writers whose target cannot be constrained to a directory.
    const unscopableWriters = [...SHELL_TOOLS, ...MCP_TOOLS];

    if (permissions.network === 'none') networkCapable.forEach((tool) => deny.add(tool));
    if (permissions.network === 'ask') networkCapable.forEach((tool) => ask.add(tool));

    const writeRoots = permissions.writeScope === 'project' && typeof projectRoot === 'string' && projectRoot
        ? [projectRoot]
        : undefined;

    if (permissions.writeScope === 'read-only') {
        writeCapable.forEach((tool) => deny.add(tool));
    } else if (permissions.writeScope === 'ask') {
        writeCapable.forEach((tool) => ask.add(tool));
    } else if (permissions.writeScope === 'project') {
        if (writeRoots) {
            // Direct writers are confined to the project root by the runtime.
            // Tools that cannot be path scoped would escape that boundary:
            // they run arbitrary code, spawn sub agents and background tasks,
            // and MCP servers live outside the project. They are denied
            // instead of approved so the scope stays a boundary.
            unscopableWriters.forEach((tool) => deny.add(tool));
        } else {
            // Without a known project root the scope cannot be enforced at
            // all, so every writer is denied rather than writing anywhere.
            writeCapable.forEach((tool) => deny.add(tool));
        }
    }

    if (permissions.requireApproval) {
        [...WRITE_TOOLS, 'bash'].forEach((tool) => ask.add(tool));
    }

    // A deny is a hard boundary and the runtime checks it before an approval,
    // so a denied tool must not keep an approval entry: the write scope wins
    // over the network approval and over the approval requirement.
    for (const tool of deny) ask.delete(tool);

    const policy = {
        deny: [...deny],
        ask: [...ask],
    };
    if (writeRoots) policy.writeRoots = writeRoots;
    if (permissions.toolAccess === 'allow-list') policy.allow = [...permissions.allowedTools];
    return policy;
}

/** Resolve a fresh, server-owned delegation envelope. Never persists a binding. */
export async function resolveProjectTaskAuthority(options = {}) {
    const runtime = await resolveProjectTeamRuntime({ ...options, persistBinding: false });
    if (!runtime || runtime.agent?.role !== 'commander') return undefined;
    const members = runtime.agents.filter(member => member.enabled && member.id !== runtime.agentId
        && member.role !== 'commander').map(member => ({
        id: member.id,
        briefing: buildProjectAgentBriefing(member),
        toolPolicy: buildProjectAgentToolPolicy(member, { projectRoot: runtime.projectRoot }),
        ...(member.model ? { model: member.model } : {}),
    }));
    return {
        projectRoot: runtime.projectRoot,
        members,
        async resolveMember(memberId) {
            // Re-read registered project, session binding, role and permissions
            // after queue waits; never authorize from the advertised snapshot.
            const fresh = await resolveProjectTeamRuntime({ ...options, persistBinding: false });
            if (!fresh || path.resolve(fresh.projectRoot) !== path.resolve(runtime.projectRoot)
                || fresh.agentId !== runtime.agentId || fresh.agent?.role !== 'commander') return undefined;
            const member = fresh.agents.find(candidate => candidate.id === memberId && candidate.enabled
                && candidate.id !== fresh.agentId && candidate.role !== 'commander');
            if (!member) return undefined;
            return {
                id: member.id,
                briefing: buildProjectAgentBriefing(member),
                toolPolicy: buildProjectAgentToolPolicy(member, { projectRoot: fresh.projectRoot }),
            };
        },
    };
}

export async function resolveProjectTeamRuntime({ projectKey, cwd, agentId, sessionKey, persistBinding = true, snapshotProvider = defaultSnapshotProvider } = {}) {
    const root = projectKey || cwd;
    if (root && sessionKey) {
        if (agentId !== undefined && persistBinding) await setSessionAgentBinding({ projectRoot: root, sessionKey, agentId, snapshotProvider });
        else if (agentId === undefined) agentId = readSessionAgentBinding(root, sessionKey);
    }
    if (typeof root !== 'string' || !root) {
        if (agentId === undefined || agentId === null || agentId === '') return null;
        throw new ProjectTeamConfigError('An agent requires a project root.', { statusCode: 400, code: 'PROJECT_ROOT_REQUIRED' });
    }
    if (agentId === null) return null;
    // In commander/automated collaboration, an omitted UI selection still
    // runs through the configured commander (or first enabled worker). This
    // keeps the default chat turn eligible for a bounded reviewer turn.
    const hasExplicitAgent = agentId !== undefined && agentId !== null && agentId !== '';
    // Ordinary chats without a team file must not wait for a gateway snapshot.
    if (!hasExplicitAgent && !existsSync(path.join(root, '.pilotdeck', 'project-team.json'))) return null;
    let selectedAgentId = agentId;
    if (selectedAgentId === undefined || selectedAgentId === null || selectedAgentId === '') {
        let config;
        try {
            config = await readProjectTeamConfig({ projectRoot: root, snapshotProvider });
        } catch (error) {
            if (error?.code === 'PROJECT_NOT_REGISTERED') return null;
            throw error;
        }
        const mode = config.collaboration?.mode || 'manual';
        if (mode === 'manual') return null;
        const fallback = config.agents.find((candidate) => candidate.enabled && candidate.role === 'commander')
            || config.agents.find((candidate) => candidate.enabled && candidate.role !== 'reviewer' && candidate.role !== 'inspector');
        if (!fallback) return { projectRoot: root, teamConfig: config, syntheticMessages: [] };
        selectedAgentId = fallback.id;
    }
    const config = await readProjectTeamConfig({ projectRoot: root, snapshotProvider });
    const agent = config.agents.find((candidate) => candidate.id === selectedAgentId && candidate.enabled);
    if (!agent) {
        throw new ProjectTeamConfigError(`Project agent is not enabled or does not exist: ${selectedAgentId}`, {
            statusCode: 404,
            code: 'PROJECT_AGENT_UNAVAILABLE',
        });
    }
    return {
        projectRoot: root,
        agentId: agent.id,
        agent,
        collaboration: config.collaboration,
        agents: config.agents,
        teamConfig: config,
        syntheticMessages: [{ text: buildProjectAgentBriefing(agent), purpose: 'project_agent_role' }],
        toolPolicy: buildProjectAgentToolPolicy(agent, { projectRoot: root }),
        modelSelection: agent.model ? { mode: 'model', provider: agent.model.provider, model: agent.model.model } : undefined,
    };
}
