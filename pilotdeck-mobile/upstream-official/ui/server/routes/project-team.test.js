import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProjectTeamRouter } from './project-team.js';

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
