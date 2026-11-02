import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    DEFAULT_AGENT_PERMISSIONS,
    INITIAL_PROJECT_TEAM_REVISION,
    PROJECT_TEAM_ROLES,
    ProjectTeamConfigError,
    listRegisteredProjectRoots,
    readProjectTeamConfig,
    resolveRegisteredProjectRoot,
    validateProjectTeamPayload,
    writeProjectTeamConfig,
} from './projectTeamConfig.js';

const workspaces = [];

afterEach(() => {
    for (const dir of workspaces.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function createWorkspace() {
    const base = mkdtempSync(join(tmpdir(), 'pilotdeck-project-team-'));
    workspaces.push(base);
    const pilotHome = join(base, 'pilot-home');
    mkdirSync(join(pilotHome, 'projects'), { recursive: true });
    const env = { PILOT_HOME: pilotHome };

    function registerProject(name) {
        const root = join(base, 'workspace', name);
        mkdirSync(root, { recursive: true });
        const projectId = `-${name.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
        const projectDir = join(pilotHome, 'projects', projectId);
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(join(projectDir, '.cwd'), root, 'utf8');
        return root;
    }

    return { base, pilotHome, env, registerProject };
}

function buildAgent(overrides = {}) {
    return {
        id: 'reviewer-1',
        name: '审查员',
        description: '审查实现与回归风险',
        role: 'reviewer',
        roleDefinition: '只做审查，不修改代码',
        model: { provider: 'openai', model: 'gpt-4o' },
        enabled: true,
        ...overrides,
    };
}

function buildPermissions(overrides = {}) {
    return {
        toolAccess: 'allow-list',
        allowedTools: ['read_file', 'grep', 'bash:git status:*'],
        deniedTools: ['bash:rm:*'],
        network: 'ask',
        writeScope: 'project',
        requireApproval: true,
        ...overrides,
    };
}

function configFile(root) {
    return join(root, '.pilotdeck', 'project-team.json');
}

describe('project team registration lookup', () => {
    it('lists project roots registered through local .cwd markers', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');

        const roots = await listRegisteredProjectRoots({ env: workspace.env });

        expect(roots.map((entry) => entry.replace(/\\/g, '/'))).toEqual([
            root.replace(/\\/g, '/'),
        ]);
    });

    it('accepts a registered project root and rejects unregistered or nested paths', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');
        const unregistered = join(workspace.base, 'not-registered');
        mkdirSync(unregistered, { recursive: true });
        const nested = join(root, 'src');
        mkdirSync(nested, { recursive: true });

        await expect(resolveRegisteredProjectRoot(root, { env: workspace.env }))
            .resolves.toBe(root);
        await expect(resolveRegisteredProjectRoot(unregistered, { env: workspace.env }))
            .rejects.toMatchObject({ statusCode: 404, code: 'PROJECT_NOT_REGISTERED' });
        await expect(resolveRegisteredProjectRoot(nested, { env: workspace.env }))
            .rejects.toMatchObject({ statusCode: 404, code: 'PROJECT_NOT_REGISTERED' });
    });

    it('rejects relative and empty project roots', async () => {
        const workspace = createWorkspace();

        await expect(resolveRegisteredProjectRoot('relative/path', { env: workspace.env }))
            .rejects.toMatchObject({ statusCode: 400 });
        await expect(resolveRegisteredProjectRoot('', { env: workspace.env }))
            .rejects.toMatchObject({ statusCode: 400 });
    });

    it('accepts roots reported by the gateway snapshot even without local markers', async () => {
        const workspace = createWorkspace();
        const root = join(workspace.base, 'gateway-project');
        mkdirSync(root, { recursive: true });

        const resolved = await resolveRegisteredProjectRoot(root, {
            env: workspace.env,
            snapshotProvider: async () => [{ fullPath: root, name: 'gateway-project' }],
        });

        expect(resolved).toBe(root);
    });

    it('does not wait for gateway when the requested project has a local marker', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');
        let called = false;
        const resolved = await resolveRegisteredProjectRoot(root, {
            env: workspace.env,
            snapshotProvider: async () => {
                called = true;
                return new Promise(() => {});
            },
        });
        expect(resolved).toBe(root);
        expect(called).toBe(false);
    });

    it('falls back to local markers when the gateway snapshot fails', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');

        const roots = await listRegisteredProjectRoots({
            env: workspace.env,
            snapshotProvider: async () => {
                throw new Error('gateway unavailable');
            },
        });

        expect(roots).toHaveLength(1);
        expect(await resolveRegisteredProjectRoot(root, {
            env: workspace.env,
            snapshotProvider: async () => {
                throw new Error('gateway unavailable');
            },
        })).toBe(root);
    });
});

describe('project team configuration storage', () => {
    it('returns an empty configuration with the initial revision when nothing is stored', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');

        const config = await readProjectTeamConfig({ projectRoot: root, env: workspace.env });

        expect(config).toEqual({
            version: 1,
            revision: INITIAL_PROJECT_TEAM_REVISION,
            collaboration: { mode: 'manual' },
            agents: [],
        });
        expect(existsSync(configFile(root))).toBe(false);
    });

    it('does not create any directory or file while reading', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');

        await readProjectTeamConfig({ projectRoot: root, env: workspace.env });

        expect(existsSync(join(root, '.pilotdeck'))).toBe(false);
    });

    it('stores the agents, issues an opaque revision and reloads them from disk', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');
        const agents = [buildAgent(), buildAgent({ id: 'commander-1', role: 'commander' })];
        // Agents without an explicit block are stored with the default
        // tool authorization so the file always has a complete shape.
        const expected = agents.map((agent) => ({
            ...agent,
            permissions: { ...DEFAULT_AGENT_PERMISSIONS },
            reportsTo: null,
        }));

        const saved = await writeProjectTeamConfig({
            projectRoot: root,
            revision: INITIAL_PROJECT_TEAM_REVISION,
            agents,
            env: workspace.env,
        });

        expect(saved.version).toBe(1);
        expect(typeof saved.revision).toBe('string');
        expect(saved.revision).not.toBe(INITIAL_PROJECT_TEAM_REVISION);
        expect(saved.agents).toHaveLength(2);

        const reloaded = await readProjectTeamConfig({ projectRoot: root, env: workspace.env });
        expect(reloaded.revision).toBe(saved.revision);
        expect(reloaded.agents).toEqual(expected);

        const raw = JSON.parse(readFileSync(configFile(root), 'utf8'));
        expect(raw.version).toBe(1);
        expect(raw.revision).toBe(saved.revision);
        expect(raw.agents).toEqual(expected);
    });

    it('keeps the tool authorization of an agent across a reload', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');
        const permissions = buildPermissions();

        await writeProjectTeamConfig({
            projectRoot: root,
            revision: INITIAL_PROJECT_TEAM_REVISION,
            agents: [buildAgent({ permissions })],
            env: workspace.env,
        });

        const reloaded = await readProjectTeamConfig({ projectRoot: root, env: workspace.env });
        expect(reloaded.agents[0].permissions).toEqual(permissions);
    });

    it('keeps configurations isolated between projects', async () => {
        const workspace = createWorkspace();
        const alpha = workspace.registerProject('alpha');
        const beta = workspace.registerProject('beta');

        const alphaConfig = await writeProjectTeamConfig({
            projectRoot: alpha,
            revision: INITIAL_PROJECT_TEAM_REVISION,
            agents: [buildAgent()],
            env: workspace.env,
        });
        const betaConfig = await writeProjectTeamConfig({
            projectRoot: beta,
            revision: INITIAL_PROJECT_TEAM_REVISION,
            agents: [buildAgent({ id: 'executor-1', role: 'executor' })],
            env: workspace.env,
        });

        expect(alphaConfig.revision).not.toBe(betaConfig.revision);
        const alphaReload = await readProjectTeamConfig({ projectRoot: alpha, env: workspace.env });
        const betaReload = await readProjectTeamConfig({ projectRoot: beta, env: workspace.env });
        expect(alphaReload.agents.map((agent) => agent.id)).toEqual(['reviewer-1']);
        expect(betaReload.agents.map((agent) => agent.id)).toEqual(['executor-1']);
    });

    it('rejects a stale revision with a conflict and keeps the stored configuration', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');

        const saved = await writeProjectTeamConfig({
            projectRoot: root,
            revision: INITIAL_PROJECT_TEAM_REVISION,
            agents: [buildAgent()],
            env: workspace.env,
        });

        await expect(writeProjectTeamConfig({
            projectRoot: root,
            revision: INITIAL_PROJECT_TEAM_REVISION,
            agents: [],
            env: workspace.env,
        })).rejects.toMatchObject({
            statusCode: 409,
            code: 'PROJECT_TEAM_REVISION_CONFLICT',
        });

        const reloaded = await readProjectTeamConfig({ projectRoot: root, env: workspace.env });
        expect(reloaded.revision).toBe(saved.revision);
        expect(reloaded.agents).toHaveLength(1);
    });

    it('serializes concurrent writes so only the first revision wins', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');

        const results = await Promise.allSettled([
            writeProjectTeamConfig({
                projectRoot: root,
                revision: INITIAL_PROJECT_TEAM_REVISION,
                agents: [buildAgent({ id: 'first' })],
                env: workspace.env,
            }),
            writeProjectTeamConfig({
                projectRoot: root,
                revision: INITIAL_PROJECT_TEAM_REVISION,
                agents: [buildAgent({ id: 'second' })],
                env: workspace.env,
            }),
        ]);

        const fulfilled = results.filter((result) => result.status === 'fulfilled');
        const rejected = results.filter((result) => result.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(ProjectTeamConfigError);
        expect(rejected[0].reason.statusCode).toBe(409);
    });

    it('refuses to read or overwrite a corrupted configuration file', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');
        mkdirSync(join(root, '.pilotdeck'), { recursive: true });
        writeFileSync(configFile(root), '{ not json', 'utf8');

        await expect(readProjectTeamConfig({ projectRoot: root, env: workspace.env }))
            .rejects.toMatchObject({
                statusCode: 422,
                code: 'PROJECT_TEAM_CONFIG_CORRUPTED',
            });
        await expect(writeProjectTeamConfig({
            projectRoot: root,
            revision: INITIAL_PROJECT_TEAM_REVISION,
            agents: [],
            env: workspace.env,
        })).rejects.toMatchObject({
            statusCode: 422,
            code: 'PROJECT_TEAM_CONFIG_CORRUPTED',
        });

        expect(readFileSync(configFile(root), 'utf8')).toBe('{ not json');
    });

    it('refuses to write through a symlinked .pilotdeck directory', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');
        const outside = join(workspace.base, 'outside');
        mkdirSync(outside, { recursive: true });
        symlinkSync(outside, join(root, '.pilotdeck'));

        await expect(writeProjectTeamConfig({
            projectRoot: root,
            revision: INITIAL_PROJECT_TEAM_REVISION,
            agents: [],
            env: workspace.env,
        })).rejects.toMatchObject({
            statusCode: 422,
            code: 'PROJECT_TEAM_CONFIG_SYMLINK',
        });

        expect(existsSync(join(outside, 'project-team.json'))).toBe(false);
    });

    it('refuses to write through a symlinked project-team.json file', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');
        mkdirSync(join(root, '.pilotdeck'), { recursive: true });
        const outsideFile = join(workspace.base, 'outside.json');
        writeFileSync(outsideFile, '{"keep":true}', 'utf8');
        symlinkSync(outsideFile, configFile(root));

        await expect(writeProjectTeamConfig({
            projectRoot: root,
            revision: INITIAL_PROJECT_TEAM_REVISION,
            agents: [],
            env: workspace.env,
        })).rejects.toMatchObject({
            statusCode: 422,
            code: 'PROJECT_TEAM_CONFIG_SYMLINK',
        });

        expect(readFileSync(outsideFile, 'utf8')).toBe('{"keep":true}');
    });

    it('leaves no temporary files behind after a successful write', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');

        await writeProjectTeamConfig({
            projectRoot: root,
            revision: INITIAL_PROJECT_TEAM_REVISION,
            agents: [buildAgent()],
            env: workspace.env,
        });

        const entries = readdirSync(join(root, '.pilotdeck'));
        expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
        expect(entries).toContain('project-team.json');
    });
});

describe('project team payload validation', () => {
    it('accepts a well-formed payload', () => {
        const validation = validateProjectTeamPayload({
            version: 1,
            revision: INITIAL_PROJECT_TEAM_REVISION,
            agents: [buildAgent()],
        });

        expect(validation).toEqual({ valid: true, errors: [] });
    });

    it('exposes exactly the supported roles', () => {
        expect([...PROJECT_TEAM_ROLES]).toEqual([
            'commander',
            'executor',
            'reviewer',
            'supervisor',
        ]);
    });

    it.each([
        [
            'unknown top-level field',
            { version: 1, revision: '0', agents: [], permissions: { shell: true } },
            'Unknown field',
        ],
        [
            'unsupported version',
            { version: 2, revision: '0', agents: [] },
            'version must be 1',
        ],
        [
            'missing revision',
            { version: 1, agents: [] },
            'revision',
        ],
        [
            'non-string revision',
            { version: 1, revision: 7, agents: [] },
            'revision',
        ],
        [
            'agents not an array',
            { version: 1, revision: '0', agents: {} },
            'agents must be an array',
        ],
        [
            'duplicate agent ids',
            {
                version: 1,
                revision: '0',
                agents: [buildAgent(), buildAgent({ name: '第二个审查员' })],
            },
            'duplicates another agent id',
        ],
        [
            'unknown agent field',
            {
                version: 1,
                revision: '0',
                agents: [buildAgent({ tools: ['shell'] })],
            },
            'unknown field',
        ],
        [
            'invalid agent id',
            {
                version: 1,
                revision: '0',
                agents: [buildAgent({ id: '../escape' })],
            },
            'agents[0].id',
        ],
        [
            'empty agent name',
            {
                version: 1,
                revision: '0',
                agents: [buildAgent({ name: '   ' })],
            },
            'agents[0].name',
        ],
        [
            'unsupported role',
            {
                version: 1,
                revision: '0',
                agents: [buildAgent({ role: 'manager' })],
            },
            'agents[0].role',
        ],
        [
            'model missing provider',
            {
                version: 1,
                revision: '0',
                agents: [buildAgent({ model: { model: 'gpt-4o' } })],
            },
            'agents[0].model.provider',
        ],
        [
            'model missing model id',
            {
                version: 1,
                revision: '0',
                agents: [buildAgent({ model: { provider: 'openai' } })],
            },
            'agents[0].model.model',
        ],
        [
            'model carrying a credential',
            {
                version: 1,
                revision: '0',
                agents: [buildAgent({ model: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-secret' } })],
            },
            'agents[0].model has unknown field',
        ],
        [
            'non-boolean enabled flag',
            {
                version: 1,
                revision: '0',
                agents: [buildAgent({ enabled: 'yes' })],
            },
            'agents[0].enabled',
            ],
        [
            'oversized description',
            {
                version: 1,
                revision: '0',
                agents: [buildAgent({ description: 'x'.repeat(1001) })],
            },
            'agents[0].description',
        ],
    ])('rejects %s', (_label, payload, expectedMessage) => {
        const validation = validateProjectTeamPayload(payload);

        expect(validation.valid).toBe(false);
        expect(validation.errors.join(' ')).toContain(expectedMessage);
    });

    it('rejects a payload that carries a secret-like field', () => {
        const validation = validateProjectTeamPayload({
            version: 1,
            revision: '0',
            agents: [buildAgent({ apiKey: 'sk-secret' })],
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors.join(' ')).toContain('apiKey');
    });

    it('rejects a payload with more agents than the supported maximum', () => {
        const agents = Array.from({ length: 33 }, (_value, index) =>
            buildAgent({ id: `agent-${index}` }));
        const validation = validateProjectTeamPayload({
            version: 1,
            revision: '0',
            agents,
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors.join(' ')).toContain('at most');
    });

    it('rejects a non-object payload', () => {
        expect(validateProjectTeamPayload(null).valid).toBe(false);
        expect(validateProjectTeamPayload([]).valid).toBe(false);
        expect(validateProjectTeamPayload('agents').valid).toBe(false);
    });

    it('accepts an agent with a full tool authorization block', () => {
        const validation = validateProjectTeamPayload({
            version: 1,
            revision: '0',
            agents: [buildAgent({ permissions: buildPermissions() })],
        });

        expect(validation).toEqual({ valid: true, errors: [] });
    });

    it('accepts an agent without a model so it can follow the session default', () => {
        const validation = validateProjectTeamPayload({
            version: 1,
            revision: '0',
            agents: [buildAgent({ model: null })],
        });

        expect(validation).toEqual({ valid: true, errors: [] });
    });

    it.each([
        [
            'unknown permission field',
            buildPermissions({ shell: true }),
            'unknown field',
        ],
        [
            'invalid tool access mode',
            buildPermissions({ toolAccess: 'everything' }),
            'toolAccess',
        ],
        [
            'invalid network mode',
            buildPermissions({ network: 'sometimes' }),
            'network',
        ],
        [
            'invalid write scope',
            buildPermissions({ writeScope: 'anywhere' }),
            'writeScope',
        ],
        [
            'non-boolean approval flag',
            buildPermissions({ requireApproval: 'yes' }),
            'requireApproval',
        ],
        [
            'malformed tool entry',
            buildPermissions({ allowedTools: ['read_file', 'rm -rf /'] }),
            'allowedTools',
        ],
        [
            'tool entries that are not an array',
            buildPermissions({ deniedTools: 'bash' }),
            'deniedTools',
        ],
    ])('rejects an agent with %s', (_label, permissions, expected) => {
        const validation = validateProjectTeamPayload({
            version: 1,
            revision: '0',
            agents: [buildAgent({ permissions })],
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors.join(' ')).toContain(expected);
    });

    it('rejects a model that is neither null nor a provider/model object', () => {
        const validation = validateProjectTeamPayload({
            version: 1,
            revision: '0',
            agents: [buildAgent({ model: 'gpt-4o' })],
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors.join(' ')).toContain('model');
    });

    it('accepts a team with a collaboration mode and coordinator references', () => {
        const validation = validateProjectTeamPayload({
            version: 1,
            revision: '0',
            collaboration: { mode: 'commander' },
            agents: [
                buildAgent({ id: 'lead', role: 'commander' }),
                buildAgent({ id: 'worker', role: 'executor', reportsTo: 'lead' }),
            ],
        });

        expect(validation).toEqual({ valid: true, errors: [] });
    });

    it.each([
        [
            'unknown collaboration field',
            { mode: 'manual', secretPlan: 'x' },
            'unknown field',
        ],
        [
            'invalid collaboration mode',
            { mode: 'sometimes' },
            'mode',
        ],
    ])('rejects a team with %s', (_label, collaboration, expected) => {
        const validation = validateProjectTeamPayload({
            version: 1,
            revision: '0',
            collaboration,
            agents: [],
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors.join(' ')).toContain(expected);
    });

    it('rejects a coordinator reference to an agent outside the team', () => {
        const validation = validateProjectTeamPayload({
            version: 1,
            revision: '0',
            agents: [buildAgent({ id: 'worker', reportsTo: 'ghost' })],
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors.join(' ')).toContain('reportsTo');
    });

    it('rejects an agent that reports to itself', () => {
        const validation = validateProjectTeamPayload({
            version: 1,
            revision: '0',
            agents: [buildAgent({ id: 'worker', reportsTo: 'worker' })],
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors.join(' ')).toContain('reportsTo');
    });
});
