import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    buildProjectAgentBriefing,
    buildProjectAgentToolPolicy,
    resolveProjectTeamRuntime,
    getSessionAgentBinding,
    setSessionAgentBinding,
} from './projectTeamRuntime.js';
import { writeProjectTeamConfig } from './projectTeamConfig.js';

const roots = [];
afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agent(overrides = {}) {
    return {
        id: 'worker',
        name: 'Worker',
        description: 'Does the work',
        role: 'executor',
        roleDefinition: 'Execute assigned tasks',
        enabled: true,
        model: null,
        permissions: {
            toolAccess: 'all',
            allowedTools: [],
            deniedTools: [],
            network: 'allow',
            writeScope: 'project',
            requireApproval: false,
        },
        ...overrides,
    };
}

function root() {
    const value = mkdtempSync(join(tmpdir(), 'pilotdeck-runtime-'));
    roots.push(value);
    return value;
}

describe('project agent tool policy', () => {
    it('omits allow for all and preserves an explicitly empty allow-list', () => {
        const all = buildProjectAgentToolPolicy(agent());
        expect(all).not.toHaveProperty('allow');
        expect(buildProjectAgentToolPolicy(agent({ permissions: {
            ...agent().permissions, toolAccess: 'allow-list', allowedTools: [],
        } }))).toMatchObject({ allow: [] });
    });

    it('maps network, write scope, approval, and explicit denies', () => {
        const permissions = {
            ...agent().permissions,
            deniedTools: ['custom_tool'],
            network: 'none',
            writeScope: 'read-only',
            requireApproval: true,
        };
        const policy = buildProjectAgentToolPolicy(agent({ permissions }));
        expect(policy.deny).toEqual(expect.arrayContaining([
            'custom_tool', 'web_fetch', 'web_search', 'write_file', 'edit_file',
            'edit_notebook', 'bash', 'execute_code', 'agent', 'task_create',
        ]));
        // A deny is a hard boundary, so a denied tool must not keep an
        // approval entry: the runtime checks deny before ask.
        expect(policy.ask).not.toEqual(expect.arrayContaining(['write_file', 'edit_file', 'edit_notebook', 'bash']));
        expect(policy.ask).not.toContain('custom_tool');
    });

    it('asks for network and write tools without confusing denied tools with approvals', () => {
        const permissions = { ...agent().permissions, network: 'ask', writeScope: 'ask', deniedTools: ['blocked'] };
        const policy = buildProjectAgentToolPolicy(agent({ permissions }));
        expect(policy.deny).toContain('blocked');
        expect(policy.ask).toEqual(expect.arrayContaining([
            'web_fetch', 'web_search', 'write_file', 'edit_file', 'edit_notebook',
        ]));
        expect(policy.ask).not.toContain('blocked');
    });
});

describe('project agent capability scoping', () => {
    it('denies every network capable escape hatch when the network policy forbids network access', () => {
        const policy = buildProjectAgentToolPolicy(agent({ permissions: {
            ...agent().permissions, network: 'none', writeScope: 'project', requireApproval: false,
        } }));
        expect(policy.deny).toEqual(expect.arrayContaining([
            'web_fetch', 'web_search', 'bash', 'execute_code', 'agent', 'task_create',
            'mcp*', 'read_mcp_resource', 'list_mcp_resources',
        ]));
    });

    it('asks for every network capable escape hatch when the network policy requires approval', () => {
        const policy = buildProjectAgentToolPolicy(agent({ permissions: {
            ...agent().permissions, network: 'ask', writeScope: 'ask', requireApproval: false,
        } }));
        expect(policy.ask).toEqual(expect.arrayContaining([
            'web_fetch', 'web_search', 'bash', 'execute_code', 'agent', 'task_create',
            'mcp*', 'read_mcp_resource', 'list_mcp_resources',
        ]));
    });

    it('denies MCP tools and shell capabilities for a read-only write scope', () => {
        const policy = buildProjectAgentToolPolicy(agent({ permissions: {
            ...agent().permissions, network: 'allow', writeScope: 'read-only', requireApproval: false,
        } }));
        expect(policy.deny).toEqual(expect.arrayContaining([
            'write_file', 'edit_file', 'edit_notebook', 'bash', 'execute_code', 'agent', 'task_create', 'mcp*',
        ]));
        expect(policy.ask).not.toContain('write_file');
    });

    it('scopes a project write scope to the project root', () => {
        const projectRoot = root();
        const policy = buildProjectAgentToolPolicy(agent({ permissions: {
            ...agent().permissions, network: 'allow', writeScope: 'project', requireApproval: false,
        } }), { projectRoot });
        expect(policy.writeRoots).toEqual([projectRoot]);
        expect(policy.deny).not.toContain('write_file');
    });

    it('denies the writers that cannot be path scoped when the write scope is the project', () => {
        const projectRoot = root();
        const policy = buildProjectAgentToolPolicy(agent({ permissions: {
            ...agent().permissions, network: 'allow', writeScope: 'project', requireApproval: false,
        } }), { projectRoot });
        // A directory scope can never be applied to these tools: an approval
        // would let them write anywhere, and `bypassPermissions` approves
        // every approval automatically. A project write scope is a boundary,
        // so the unscopable writers have to be denied.
        expect(policy.deny).toEqual(expect.arrayContaining([
            'bash', 'execute_code', 'agent', 'task_create', 'mcp*',
        ]));
        expect(policy.ask).not.toContain('bash');
        expect(policy.ask).not.toContain('execute_code');
        expect(policy.ask).not.toContain('agent');
        expect(policy.ask).not.toContain('task_create');
        expect(policy.ask).not.toContain('mcp*');
        // The direct writers stay available, confined by the write scope.
        expect(policy.writeRoots).toEqual([projectRoot]);
        expect(policy.deny).not.toContain('write_file');
        expect(policy.deny).not.toContain('edit_file');
        expect(policy.deny).not.toContain('edit_notebook');
    });

    it('lets the project write boundary win over a network approval for the same tool', () => {
        const policy = buildProjectAgentToolPolicy(agent({ permissions: {
            ...agent().permissions, network: 'ask', writeScope: 'project', requireApproval: false,
        } }), { projectRoot: root() });
        // `bash` and `mcp*` are network capable *and* unscopable writers.
        // The write boundary wins: they are denied, not approved.
        expect(policy.deny).toEqual(expect.arrayContaining([
            'bash', 'execute_code', 'agent', 'task_create', 'mcp*',
        ]));
        expect(policy.ask).not.toContain('bash');
        expect(policy.ask).not.toContain('mcp*');
    });

    it('keeps the network approval meaningful for the read-only network tools', () => {
        const policy = buildProjectAgentToolPolicy(agent({ permissions: {
            ...agent().permissions, network: 'ask', writeScope: 'project', requireApproval: false,
        } }), { projectRoot: root() });
        // The write scope does not touch the tools that cannot write.
        expect(policy.ask).toEqual(expect.arrayContaining([
            'web_fetch', 'web_search', 'read_mcp_resource', 'list_mcp_resources',
        ]));
        expect(policy.deny).not.toContain('web_fetch');
        expect(policy.deny).not.toContain('web_search');
        expect(policy.deny).not.toContain('read_mcp_resource');
        expect(policy.deny).not.toContain('list_mcp_resources');
    });

    it('does not let the approval requirement re-open a denied writer', () => {
        const policy = buildProjectAgentToolPolicy(agent({ permissions: {
            ...agent().permissions, network: 'allow', writeScope: 'project', requireApproval: true,
        } }), { projectRoot: root() });
        expect(policy.deny).toContain('bash');
        expect(policy.ask).not.toContain('bash');
        // The direct writers still ask, they are only confined to the root.
        expect(policy.ask).toEqual(expect.arrayContaining(['write_file', 'edit_file', 'edit_notebook']));
    });

    it('fails closed when a project write scope has no known project root', () => {
        const policy = buildProjectAgentToolPolicy(agent({ permissions: {
            ...agent().permissions, network: 'allow', writeScope: 'project', requireApproval: false,
        } }));
        expect(policy.writeRoots).toBeUndefined();
        // Without a root the scope cannot be enforced at all, so every writer
        // is denied instead of approved.
        expect(policy.deny).toEqual(expect.arrayContaining([
            'write_file', 'edit_file', 'edit_notebook', 'bash', 'execute_code',
            'agent', 'task_create', 'mcp*',
        ]));
        expect(policy.ask).not.toContain('write_file');
        expect(policy.ask).not.toContain('bash');
    });

    it('keeps an ask write scope a confirmation boundary instead of a hard boundary', () => {
        const policy = buildProjectAgentToolPolicy(agent({ permissions: {
            ...agent().permissions, network: 'allow', writeScope: 'ask', requireApproval: false,
        } }), { projectRoot: root() });
        // `ask` means "confirm before writing": it is a prompt boundary, not a
        // scope. The write may still land anywhere in the filesystem, and
        // `bypassPermissions` approves the prompt automatically, so only the
        // project scope confines writes.
        expect(policy.ask).toEqual(expect.arrayContaining([
            'write_file', 'edit_file', 'edit_notebook', 'bash', 'execute_code',
            'agent', 'task_create', 'mcp*',
        ]));
        expect(policy.deny).not.toContain('bash');
        expect(policy.writeRoots).toBeUndefined();
    });

    it('keeps non-project write scopes unscoped', () => {
        const policy = buildProjectAgentToolPolicy(agent({ permissions: {
            ...agent().permissions, network: 'allow', writeScope: 'ask', requireApproval: false,
        } }), { projectRoot: root() });
        expect(policy.writeRoots).toBeUndefined();
    });

    it('resolves the write scope root of the resolved project runtime', async () => {
        const projectRoot = root();
        await writeProjectTeamConfig({
            projectRoot,
            revision: '0',
            agents: [agent({ permissions: { ...agent().permissions, network: 'allow', writeScope: 'project' } })],
            snapshotProvider: async () => [{ fullPath: projectRoot }],
        });
        const resolved = await resolveProjectTeamRuntime({
            projectKey: projectRoot,
            agentId: 'worker',
            snapshotProvider: async () => [{ fullPath: projectRoot }],
        });
        expect(resolved.toolPolicy.writeRoots).toEqual([projectRoot]);
    });

    it('carries the project write boundary into the resolved runtime policy', async () => {
        const projectRoot = root();
        await writeProjectTeamConfig({
            projectRoot,
            revision: '0',
            agents: [agent({ permissions: { ...agent().permissions, network: 'allow', writeScope: 'project' } })],
            snapshotProvider: async () => [{ fullPath: projectRoot }],
        });
        const resolved = await resolveProjectTeamRuntime({
            projectKey: projectRoot,
            agentId: 'worker',
            snapshotProvider: async () => [{ fullPath: projectRoot }],
        });
        expect(resolved.toolPolicy.deny).toEqual(expect.arrayContaining([
            'bash', 'execute_code', 'agent', 'task_create', 'mcp*',
        ]));
        expect(resolved.toolPolicy.ask).not.toContain('bash');
    });
});

describe('session agent binding', () => {
    it('keeps unbound distinct from explicit null across JSON and commander fallback', async () => {
        vi.stubEnv('PILOT_HOME', root());
        const projectRoot = root();
        const snapshotProvider = async () => [{ fullPath: projectRoot }];
        await writeProjectTeamConfig({ projectRoot, revision: '0', collaboration: { mode: 'commander' }, agents: [agent({ role: 'commander' })], snapshotProvider });
        const scope = { projectRoot, sessionKey: 'web:three-state', snapshotProvider };
        expect(JSON.parse(JSON.stringify(await getSessionAgentBinding(scope)))).not.toHaveProperty('agentId');
        expect((await resolveProjectTeamRuntime({ projectKey: projectRoot, sessionKey: scope.sessionKey, snapshotProvider }))?.agentId).toBe('worker');
        await setSessionAgentBinding({ ...scope, agentId: null });
        expect(JSON.parse(JSON.stringify(await getSessionAgentBinding(scope)))).toEqual({ agentId: null });
        expect(await resolveProjectTeamRuntime({ projectKey: projectRoot, sessionKey: scope.sessionKey, snapshotProvider })).toBeNull();
    });
    it('isolates A/B, restores omitted selections, clears with null and keeps background reviewers transient', async () => {
        vi.stubEnv('PILOT_HOME', root());
        const projectRoot = root();
        const snapshotProvider = async () => [{ fullPath: projectRoot }];
        await writeProjectTeamConfig({ projectRoot, revision: '0', agents: [agent(), agent({ id: 'reviewer', role: 'reviewer' })], snapshotProvider });
        const resolve = (sessionKey, options = {}) => resolveProjectTeamRuntime({ projectKey: projectRoot, sessionKey, snapshotProvider, ...options });
        await resolve('web:binding-a', { agentId: 'worker' });
        expect((await resolve('web:binding-a'))?.agentId).toBe('worker');
        expect(await resolve('web:binding-b')).toBeNull();
        await resolve('web:binding-a', { agentId: 'reviewer', persistBinding: false });
        expect((await resolve('web:binding-a'))?.agentId).toBe('worker');
        await expect(resolve('web:binding-a', { agentId: 'missing' })).rejects.toMatchObject({ code: 'PROJECT_AGENT_UNAVAILABLE' });
        expect((await resolve('web:binding-a'))?.agentId).toBe('worker');
        await resolve('web:binding-a', { agentId: null });
        expect(await resolve('web:binding-a')).toBeNull();
    });
});

describe('project agent briefing and runtime resolution', () => {
    it('includes role and configured permission guidance in the briefing', () => {
        const text = buildProjectAgentBriefing(agent({ permissions: {
            ...agent().permissions, network: 'none', writeScope: 'read-only', requireApproval: true,
        } }));
        expect(text).toContain('角色定义：Execute assigned tasks');
        expect(text).toContain('联网策略：none');
        expect(text).toContain('写入范围：read-only');
        expect(text).toContain('高风险操作需要先向我确认');
    });

    it('states the project write scope as a boundary in the briefing', () => {
        const text = buildProjectAgentBriefing(agent({ permissions: {
            ...agent().permissions, network: 'allow', writeScope: 'project', requireApproval: false,
        } }));
        expect(text).toContain('写入范围：project');
    });

    it('states that an ask write scope is not path limited in the briefing', () => {
        const text = buildProjectAgentBriefing(agent({ permissions: {
            ...agent().permissions, network: 'allow', writeScope: 'ask', requireApproval: false,
        } }));
        expect(text).toContain('写入范围：ask');
    });

    it('resolves an enabled agent from a registered root using the snapshot provider', async () => {
        const projectRoot = root();
        await writeProjectTeamConfig({
            projectRoot,
            revision: '0',
            agents: [agent()],
            snapshotProvider: async () => [{ fullPath: projectRoot }],
        });
        const resolved = await resolveProjectTeamRuntime({
            projectKey: projectRoot,
            agentId: 'worker',
            snapshotProvider: async () => [{ fullPath: projectRoot }],
        });
        expect(resolved.projectRoot).toBe(projectRoot);
        expect(resolved.agentId).toBe('worker');
        expect(resolved.syntheticMessages[0].purpose).toBe('project_agent_role');
    });

    it('returns null without an agent id and rejects missing or disabled agents', async () => {
        expect(await resolveProjectTeamRuntime({ projectKey: root() })).toBeNull();
        const projectRoot = root();
        const snapshotProvider = async () => [{ fullPath: projectRoot }];
        await expect(resolveProjectTeamRuntime({ projectKey: projectRoot, agentId: 'missing', snapshotProvider }))
            .rejects.toMatchObject({ code: 'PROJECT_AGENT_UNAVAILABLE', statusCode: 404 });
    });
});
