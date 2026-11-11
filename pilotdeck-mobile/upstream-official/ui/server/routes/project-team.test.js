import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProjectTeamRouter, SNAPSHOT_TIMEOUT_MS } from './project-team.js';

// Match the safe database mock used by agent.requestContext.test.js: never
// load the authentication database (whose migration can copy a real auth.db).
vi.mock('../database/db.js', () => ({
    userDb: { getFirstUser: () => ({ id: 'platform-user' }) },
    apiKeysDb: { validateApiKey: () => null },
    githubTokensDb: {},
}));

const nativeFetch = globalThis.fetch;
const workspaces = [];

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of workspaces.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function createWorkspace() {
    const base = mkdtempSync(join(tmpdir(), 'pilotdeck-project-team-route-'));
    workspaces.push(base);
    const pilotHome = join(base, 'pilot-home');
    mkdirSync(join(pilotHome, 'projects'), { recursive: true });
    vi.stubEnv('PILOT_HOME', pilotHome);

    function registerProject(name) {
        const root = join(base, 'workspace', name);
        mkdirSync(root, { recursive: true });
        const projectId = `-${name.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
        const projectDir = join(pilotHome, 'projects', projectId);
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(join(projectDir, '.cwd'), root, 'utf8');
        return root;
    }

    return { base, pilotHome, registerProject };
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

function createApp(options = {}) {
    const app = express();
    app.use(express.json());
    app.use('/api/project-team', createProjectTeamRouter(options));
    return app;
}

async function requestJson(app, path, init = {}) {
    const server = app.listen(0);
    try {
        const { port } = server.address();
        const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
            headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
            ...init,
        });
        return { status: response.status, body: await response.json() };
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

describe('session agent binding API', () => {
    it('persists across router recreation, isolates projects and sessions, clears and rejects unavailable members', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('binding');
        const other = workspace.registerProject('other');
        const app = createApp();
        const teamUrl = `/api/project-team?projectRoot=${encodeURIComponent(root)}`;
        const saved = await requestJson(app, teamUrl, { method: 'PUT', body: JSON.stringify({ version: 1, revision: '0', agents: [buildAgent()] }) });
        expect(saved.status).toBe(200);
        const url = (project, session) => `/api/project-team/session-agent?projectRoot=${encodeURIComponent(project)}&sessionKey=${session}`;
        const put = (agentId) => ({ method: 'PUT', body: JSON.stringify({ agentId }) });
        expect((await requestJson(app, url(root, 'web:a'), put('reviewer-1'))).body.agentId).toBe('reviewer-1');
        expect((await requestJson(createApp(), url(root, 'web:a'))).body.agentId).toBe('reviewer-1');
        expect((await requestJson(app, url(root, 'web:b'))).body).not.toHaveProperty('agentId');
        expect((await requestJson(app, url(other, 'web:a'))).body).not.toHaveProperty('agentId');
        expect((await requestJson(app, url(root, 'web:a'), put('missing'))).status).toBe(404);
        expect((await requestJson(app, url(root, 'web:a'))).body.agentId).toBe('reviewer-1');
        expect((await requestJson(app, url(root, 'web:a'), put(null))).status).toBe(200);
        expect((await requestJson(createApp(), url(root, 'web:a'))).body.agentId).toBeNull();
        await requestJson(app, url(root, 'web:a'), put('reviewer-1'));
        await requestJson(app, teamUrl, { method: 'PUT', body: JSON.stringify({ version: 1, revision: saved.body.revision, agents: [buildAgent({ enabled: false })] }) });
        expect((await requestJson(app, url(root, 'web:a'))).status).toBe(404);
        expect((await requestJson(app, url(root, 'web:a'), put('reviewer-1'))).status).toBe(404);
        expect((await requestJson(app, url(join(workspace.base, 'unregistered'), 'web:a'), put(null))).status).toBe(404);
    }, 20_000);
});

it('persists execution mode per project and session without a team config', async () => {
    const workspace = createWorkspace();
    const root = workspace.registerProject('execution');
    const other = workspace.registerProject('other');
    const app = createApp({ snapshotProvider: async () => [] });
    const url = (project, session) => `/api/project-team/session-execution-mode?projectRoot=${encodeURIComponent(project)}&sessionKey=${session}`;
    const put = executionMode => ({ method: 'PUT', body: JSON.stringify({ executionMode }) });
    const target = url(root, 'web:s_mode');
    expect(await requestJson(app, target)).toEqual({ status: 200, body: { executionMode: 'autoSplit' } });
    expect(await requestJson(app, target, put('solo'))).toEqual({ status: 200, body: { executionMode: 'solo' } });
    expect((await requestJson(createApp(), target)).body.executionMode).toBe('solo');
    expect((await requestJson(app, url(root, 'web:s_other'))).body.executionMode).toBe('autoSplit');
    expect((await requestJson(app, url(other, 'web:s_mode'))).body.executionMode).toBe('autoSplit');
    expect((await requestJson(app, target, put('invalid'))).status).toBe(400);
    expect((await requestJson(app, target)).body.executionMode).toBe('solo');
    expect((await requestJson(app, url(join(workspace.base, 'unregistered'), 'web:s_mode'), put('solo'))).status).toBe(404);
});

describe('GET /api/project-team', () => {
    it('returns the empty configuration for a registered project', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');
        const app = createApp();

        const result = await requestJson(app, `/api/project-team?projectRoot=${encodeURIComponent(root)}`);

        expect(result.status).toBe(200);
        expect(result.body).toEqual({
                version: 1,
                revision: '0',
                collaboration: { mode: 'manual' },
                agents: [],
            });
        expect(existsSync(join(root, '.pilotdeck'))).toBe(false);
    });

    it('resolves the project root through the gateway snapshot when no local marker exists', async () => {
        const workspace = createWorkspace();
        const root = join(workspace.base, 'gateway-project');
        mkdirSync(root, { recursive: true });
        const app = createApp({
            snapshotProvider: async () => [{ fullPath: root, name: 'gateway-project' }],
        });

        const result = await requestJson(app, `/api/project-team?projectRoot=${encodeURIComponent(root)}`);

        expect(result.status).toBe(200);
        expect(result.body.revision).toBe('0');
    });

    it('reuses the gateway snapshot across requests instead of refetching it every time', async () => {
        const workspace = createWorkspace();
        const root = join(workspace.base, 'gateway-project');
        mkdirSync(root, { recursive: true });
        let calls = 0;
        const app = createApp({
            snapshotProvider: async () => {
                calls += 1;
                return [{ fullPath: root, name: 'gateway-project' }];
            },
        });

        const first = await requestJson(app, `/api/project-team?projectRoot=${encodeURIComponent(root)}`);
        const second = await requestJson(app, `/api/project-team?projectRoot=${encodeURIComponent(root)}`);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(calls).toBe(1);
    });

    it('keeps the gateway snapshot timeout above the real gateway latency', () => {
        // 生产环境的 getProjectsSnapshot() 要 1.3~1.6s（它会逐个项目统计会话）。
        // 超时低于这个值时，gateway 快照会被截断，所有「只有 gateway 知道」
        // 的项目根都会被判成未注册，设置页项目团队面板直接报 404。
        expect(SNAPSHOT_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
    });

    it('rejects a missing projectRoot parameter', async () => {
        const app = createApp();

        const result = await requestJson(app, '/api/project-team');

        expect(result.status).toBe(400);
        expect(typeof result.body.error).toBe('string');
        expect(result.body.error.length).toBeGreaterThan(0);
    });

    it('rejects a relative projectRoot parameter', async () => {
        const app = createApp();

        const result = await requestJson(app, '/api/project-team?projectRoot=relative/path');

        expect(result.status).toBe(400);
        expect(typeof result.body.error).toBe('string');
    });

    it('rejects an unregistered project root', async () => {
        const workspace = createWorkspace();
        const unregistered = join(workspace.base, 'not-registered');
        mkdirSync(unregistered, { recursive: true });
        // 必须给 snapshotProvider 一个空快照：默认实现会去连真实 gateway，
        // 挂起 1 秒超时，把这个用例拖到 vitest 的 5 秒上限。
        const app = createApp({ snapshotProvider: async () => [] });

        const result = await requestJson(app, `/api/project-team?projectRoot=${encodeURIComponent(unregistered)}`);

        expect(result.status).toBe(404);
        expect(typeof result.body.error).toBe('string');
    });
});

describe('PUT /api/project-team', () => {
    it('stores the agents and returns the updated configuration', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');
        const app = createApp();

        const result = await requestJson(app, `/api/project-team?projectRoot=${encodeURIComponent(root)}`, {
            method: 'PUT',
            body: JSON.stringify({
                version: 1,
                revision: '0',
                agents: [buildAgent()],
            }),
        });

        expect(result.status).toBe(200);
        expect(result.body.version).toBe(1);
        expect(result.body.revision).not.toBe('0');
        expect(result.body.agents).toHaveLength(1);
        expect(result.body.agents[0].id).toBe('reviewer-1');

        const stored = JSON.parse(readFileSync(join(root, '.pilotdeck', 'project-team.json'), 'utf8'));
        expect(stored.revision).toBe(result.body.revision);
        expect(stored.agents).toHaveLength(1);
    });

    it('reloads the stored configuration on the next GET', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');
        const app = createApp();

        const saved = await requestJson(app, `/api/project-team?projectRoot=${encodeURIComponent(root)}`, {
            method: 'PUT',
            body: JSON.stringify({
                version: 1,
                revision: '0',
                agents: [buildAgent({ role: 'commander', id: 'commander-1' })],
            }),
        });
        const reloaded = await requestJson(app, `/api/project-team?projectRoot=${encodeURIComponent(root)}`);

        expect(reloaded.status).toBe(200);
        expect(reloaded.body.revision).toBe(saved.body.revision);
        expect(reloaded.body.agents[0].role).toBe('commander');
    });

    it('returns a conflict when the revision is stale', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');
        const app = createApp();

        const saved = await requestJson(app, `/api/project-team?projectRoot=${encodeURIComponent(root)}`, {
            method: 'PUT',
            body: JSON.stringify({ version: 1, revision: '0', agents: [buildAgent()] }),
        });
        expect(saved.status).toBe(200);

        const conflict = await requestJson(app, `/api/project-team?projectRoot=${encodeURIComponent(root)}`, {
            method: 'PUT',
            body: JSON.stringify({ version: 1, revision: '0', agents: [] }),
        });

        expect(conflict.status).toBe(409);
        expect(typeof conflict.body.error).toBe('string');
    });

    it('rejects an invalid payload with a validation error', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');
        const app = createApp();

        const result = await requestJson(app, `/api/project-team?projectRoot=${encodeURIComponent(root)}`, {
            method: 'PUT',
            body: JSON.stringify({
                version: 1,
                revision: '0',
                agents: [buildAgent({ role: 'manager' })],
            }),
        });

        expect(result.status).toBe(400);
        expect(typeof result.body.error).toBe('string');
        expect(result.body.error).toContain('role');
        expect(existsSync(join(root, '.pilotdeck', 'project-team.json'))).toBe(false);
    });

    it('rejects a payload that carries unknown fields or credentials', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');
        const app = createApp();

        const result = await requestJson(app, `/api/project-team?projectRoot=${encodeURIComponent(root)}`, {
            method: 'PUT',
            body: JSON.stringify({
                version: 1,
                revision: '0',
                agents: [buildAgent({ model: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-secret' } })],
            }),
        });

        expect(result.status).toBe(400);
        expect(result.body.error).toContain('apiKey');
    });

    it('rejects a write for an unregistered project root', async () => {
        const workspace = createWorkspace();
        const unregistered = join(workspace.base, 'not-registered');
        mkdirSync(unregistered, { recursive: true });
        // 同上：给一个空快照，别让用例去等真实 gateway。
        const app = createApp({ snapshotProvider: async () => [] });

        const result = await requestJson(app, `/api/project-team?projectRoot=${encodeURIComponent(unregistered)}`, {
            method: 'PUT',
            body: JSON.stringify({ version: 1, revision: '0', agents: [] }),
        });

        expect(result.status).toBe(404);
        expect(existsSync(join(unregistered, '.pilotdeck', 'project-team.json'))).toBe(false);
    });

    it('refuses to overwrite a corrupted configuration file', async () => {
        const workspace = createWorkspace();
        const root = workspace.registerProject('alpha');
        mkdirSync(join(root, '.pilotdeck'), { recursive: true });
        writeFileSync(join(root, '.pilotdeck', 'project-team.json'), '{ broken', 'utf8');
        const app = createApp();

        const result = await requestJson(app, `/api/project-team?projectRoot=${encodeURIComponent(root)}`, {
            method: 'PUT',
            body: JSON.stringify({ version: 1, revision: '0', agents: [] }),
        });

        expect(result.status).toBe(422);
        expect(typeof result.body.error).toBe('string');
        expect(readFileSync(join(root, '.pilotdeck', 'project-team.json'), 'utf8')).toBe('{ broken');
    });
});
