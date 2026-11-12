import { afterAll, expect, it, vi } from 'vitest';
const mock = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const previousHome = process.env.PILOT_HOME;
    const home = mkdtempSync(join(tmpdir(), 'pilotdeck-sending-'));
    process.env.PILOT_HOME = home;
    return { gateway: null, home, previousHome };
});
vi.mock('./services/gatewayConnectionCache.js', () => ({ createGatewayConnectionCache: () => ({ get: async () => mock.gateway, invalidate: () => {} }) }));
import { enqueueInputViaGateway, getInputQueueStateViaGateway, serializeQueuedInputForStorage, runChatViaGateway } from './pilotdeck-bridge.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createRequestContextMiddleware, withAuthenticatedRequest } from './middleware/requestContext.js';
import { anonymousRequestId, withRequestContext } from '../../src/network/requestContext.js';
import { requestLimiters } from './middleware/rateLimits.js';
import { writeProjectTeamConfig } from './services/projectTeamConfig.js';
import { getSessionAgentBinding } from './services/projectTeamRuntime.js';
import { regenerateLastMessageTransaction } from './services/regenerateLastMessage.js';

it('binds a new real session, restores omitted sends and snapshots queued agent choices', async () => {
    const projectRoot = path.join(mock.home, 'binding-workspace');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(path.join(mock.home, 'projects', 'binding-test'), { recursive: true });
    await writeFile(path.join(mock.home, 'projects', 'binding-test', '.cwd'), projectRoot);
    const permissions = { toolAccess: 'all', allowedTools: [], deniedTools: [], network: 'none', writeScope: 'read-only', requireApproval: false };
    await writeProjectTeamConfig({ projectRoot, revision: '0', agents: [
        { id: 'worker', name: 'Worker', role: 'executor', enabled: true, description: '', roleDefinition: '', model: null, permissions },
        { id: 'reviewer', name: 'Reviewer', role: 'reviewer', enabled: true, description: '', roleDefinition: '', model: null, permissions },
    ] });
    const calls = [], frames = [];
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input);
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    const writer = { send: frame => frames.push(frame) };
    const first = await runChatViaGateway('hello', { projectPath: projectRoot, agentId: 'worker', executionMode: 'solo' }, writer);
    expect(calls.at(-1).executionMode).toBe('solo');
    expect(frames.some(frame => frame.kind === 'session_created' || frame.newSessionId === first.sessionKey)).toBe(true);
    expect((await getSessionAgentBinding({ projectRoot, sessionKey: first.sessionKey })).agentId).toBe('worker');
    await runChatViaGateway('again', { projectPath: projectRoot, sessionId: first.sessionKey }, writer);
    expect(calls.at(-1).syntheticMessages[0].text).toContain('Worker');
    const regenerated = await regenerateLastMessageTransaction({
        data: { command: 'edited', options: { projectPath: projectRoot, sessionId: first.sessionKey, runId: 'binding-edit', executionMode: 'autoSplit' } },
        sessionId: first.sessionKey, requestId: 'binding-edit', expectedTurnId: 'old', provider: 'pilotdeck',
        writer, streamWriter: writer, runChat: runChatViaGateway,
        replaceLastTurn: async () => ({ replacedTurnId: 'old', transactionId: 'binding-tx' }),
        finalizeLastTurnReplacement: vi.fn(),
    });
    expect(regenerated.success).toBe(true);
    expect(calls.at(-1).executionMode).toBe('solo');
    expect(calls.at(-1).syntheticMessages[0].text).toContain('Worker');
    expect((await getSessionAgentBinding({ projectRoot, sessionKey: first.sessionKey })).agentId).toBe('worker');
    const beforeReview = calls.length;
    await runChatViaGateway('review', { projectPath: projectRoot, sessionId: first.sessionKey, agentId: 'reviewer', reviewDepth: 1 }, writer);
    expect(calls).toHaveLength(beforeReview);
    expect((await getSessionAgentBinding({ projectRoot, sessionKey: first.sessionKey })).agentId).toBe('worker');
    await enqueueInputViaGateway(first.sessionKey, { id: 'bound-queue', command: 'queued', options: { projectPath: projectRoot, executionMode: 'autoSplit' } }, writer);
    await vi.waitFor(() => expect(calls.at(-1).message).toBe('queued'));
    expect(calls.at(-1).syntheticMessages[0].text).toContain('Worker');
    expect(calls.at(-1).toolPolicy.deny).toContain('agent');
    expect(calls.at(-1).executionMode).toBe('solo');
    await runChatViaGateway('clear', { projectPath: projectRoot, sessionId: first.sessionKey, agentId: null }, writer);
    expect(calls.at(-1).syntheticMessages).toBeUndefined();
    expect((await getSessionAgentBinding({ projectRoot, sessionKey: first.sessionKey })).agentId).toBeNull();
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const item = id => ({ id, runId: id, command: 'fixture', displayText: id, options: { projectPath: '/tmp/sending-project' } });

it('runs unbound sessions on the primary agent and preserves explicit and restored clears', async () => {
    const projectRoot = path.join(mock.home, 'three-state-workspace');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(path.join(mock.home, 'projects', 'three-state'), { recursive: true });
    await writeFile(path.join(mock.home, 'projects', 'three-state', '.cwd'), projectRoot);
    await writeProjectTeamConfig({ projectRoot, revision: '0', collaboration: { mode: 'commander' }, agents: [
        { id: 'commander', name: 'Commander', role: 'commander', enabled: true, description: '', roleDefinition: '', model: null,
            permissions: { toolAccess: 'all', allowedTools: [], deniedTools: [], network: 'none', writeScope: 'read-only', requireApproval: false } },
    ] });
    const calls = [];
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input);
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    const writer = { send() {} };
    const sid = 'web:three-state-queue';
    const queue = (id, options = {}) => enqueueInputViaGateway(sid, { id, command: id, options: { projectPath: projectRoot, ...options } }, writer);
    expect((await queue('default')).ok).toBe(true);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // The primary agent is the executor: no synthetic role briefing and no
    // project tool policy are injected into an unbound session.
    expect(calls[0].syntheticMessages).toBeUndefined();
    expect(calls[0].toolPolicy).toBeUndefined();
    expect((await queue('explicit-clear', { agentId: null })).ok).toBe(true);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].syntheticMessages).toBeUndefined();
    expect((await getSessionAgentBinding({ projectRoot, sessionKey: sid })).agentId).toBeNull();
    expect((await queue('restored-clear')).ok).toBe(true);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2].syntheticMessages).toBeUndefined();
});

it('atomically rejects duplicate concurrent admission after runtime resolution', async () => {
    mock.gateway = { getActiveTurnSnapshot: async () => ({ active: true, runId: 'busy', events: [] }) };
    const sid = 'web:concurrent-duplicate';
    const results = await Promise.all(Array.from({ length: 8 }, () => enqueueInputViaGateway(sid, item('same-id'), { send() {} })));
    expect(results.every(result => result.ok)).toBe(true);
    expect((await getInputQueueStateViaGateway(sid)).items.map(entry => entry.id)).toEqual(['same-id']);
});

it('limits concurrent admissions to twenty after runtime resolution', async () => {
    mock.gateway = { getActiveTurnSnapshot: async () => ({ active: true, runId: 'busy', events: [] }) };
    const sid = 'web:concurrent-capacity';
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => enqueueInputViaGateway(sid, item(`capacity-${i}`), { send() {} })));
    expect(results.filter(result => result.ok)).toHaveLength(20);
    expect(results.filter(result => !result.ok).every(result => result.error === 'The message queue is full.')).toBe(true);
    expect((await getInputQueueStateViaGateway(sid)).items).toHaveLength(20);
});

it('serializes authenticated HTTP attribution before crossing the gateway boundary', async () => {
    const calls = [];
    const gateway = {
        async *submitTurn(input) {
            // JSON serialization models the separate gateway process: only explicit
            // wire fields survive, regardless of the caller's AsyncLocalStorage.
            calls.push(JSON.parse(JSON.stringify(input)));
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    const app = express();
    app.use(requestLimiters.ingress);
    app.use(express.json());
    app.use(createRequestContextMiddleware());
    app.use((req, res, next) => {
        req.user = { id: req.headers['test-auth-user'] };
        return withAuthenticatedRequest(req, res, next);
    });
    app.post('/generate', async (req, res) => {
        await runChatViaGateway('Generate a commit message', { projectPath: '/tmp/http-project', runId: req.body.runId },
            { send() {} }, 'pilotdeck', { getGateway: async () => { await new Promise(r => setTimeout(r, 5)); return gateway; } });
        res.end();
    });
    const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    const requests = ['alice', 'bob'].map(user => ({ user, runId: randomUUID(), requestId: randomUUID(), deviceId: randomUUID() }));
    try {
        await Promise.all(requests.map(async request => {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/generate`, { method: 'POST', headers: {
                'content-type': 'application/json', 'test-auth-user': request.user,
                'x-pilotdeck-user-id': 'f'.repeat(32), 'x-pilotdeck-request-id': request.requestId,
                'x-pilotdeck-device-id': request.deviceId, 'x-pilotdeck-version': '2026.10.29',
            }, body: JSON.stringify({ runId: request.runId, requestContext: { userId: 'attacker' } }) });
            expect(response.status).toBe(200);
        }));
        for (const request of requests) expect(calls.find(call => call.runId === request.runId)?.requestContext).toEqual({
            userId: anonymousRequestId('user', request.user), deviceId: request.deviceId,
            clientVersion: '2026.10.29', parentRequestId: request.requestId,
        });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

it('preserves per-message attribution through delayed queue dispatch', async () => {
    const calls = [];
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input.requestContext);
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    const requestContext = { userId: 'a'.repeat(32), deviceId: 'device-a', parentRequestId: 'request-a' };
    const queued = item('context');
    queued.options.requestContext = requestContext;
    await withRequestContext({ userId: 'b'.repeat(32), parentRequestId: 'unrelated-request', clientVersion: 'unrelated-version' },
        () => enqueueInputViaGateway('web:context-queue', queued, { send() {} }));
    await vi.waitFor(() => expect(calls).toEqual([requestContext]));
});
afterAll(async () => {
    if (mock.previousHome === undefined) delete process.env.PILOT_HOME;
    else process.env.PILOT_HOME = mock.previousHome;
    await rm(mock.home, { recursive: true, force: true });
});
it('shows idle input as sending, preserves concurrent input order, and removes each send only on acceptance', async () => {
    const acceptance = deferred(), completion = deferred(); const calls = [], frames = [];
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input.runId);
            if (calls.length === 1) await acceptance.promise;
            yield { type: 'input_accepted', runId: input.runId };
            if (calls.length === 1) await completion.promise;
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    const sid = 'web:s_sending', writer = { send: frame => frames.push(structuredClone(frame)) };
    const first = await enqueueInputViaGateway(sid, item('first'), writer);
    expect(first.state.items[0].status).toBe('submitting');
    await vi.waitFor(() => expect(calls).toEqual(['first']));
    expect((await getInputQueueStateViaGateway(sid)).items[0].status).toBe('dispatching');
    const second = await enqueueInputViaGateway(sid, item('second'), writer);
    expect(second.state.items[1].status).toBe('queued');
    acceptance.resolve();
    await vi.waitFor(async () => expect((await getInputQueueStateViaGateway(sid)).items.map(x => x.id)).toEqual(['second']));
    expect(calls).toEqual(['first']);
    completion.resolve();
    await vi.waitFor(async () => expect((await getInputQueueStateViaGateway(sid)).items).toEqual([]));
    expect(calls).toEqual(['first', 'second']);
    expect(frames.filter(x => x.type === 'session-input-accepted').map(x => x.runId)).toEqual(['first', 'second']);
    expect(frames.filter(x => x.role === 'user').map(x => x.queueItemId)).toEqual(['first', 'second']);
});
it('converts a provisional send to a real queue item if the gateway discovers another active client', async () => {
    const snapshot = deferred();
    mock.gateway = { getActiveTurnSnapshot: () => snapshot.promise, submitTurn: vi.fn() };
    const sid = 'web:s_remote_busy';
    expect((await enqueueInputViaGateway(sid, item('remote'), { send() {} })).state.items[0].status).toBe('submitting');
    snapshot.resolve({ active: true, runId: 'other-client', events: [] });
    await vi.waitFor(async () => expect((await getInputQueueStateViaGateway(sid)).items[0].status).toBe('queued'));
    expect(mock.gateway.submitTurn).not.toHaveBeenCalled();
});
it('retains failed sends for recovery and treats only actually dispatched inputs as uncertain on restart', async () => {
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn() { yield { type: 'error', message: 'Rejected before acceptance' }; },
    };
    const sid = 'web:s_rejected';
    await enqueueInputViaGateway(sid, item('rejected'), { send() {} });
    await vi.waitFor(async () => expect(await getInputQueueStateViaGateway(sid)).toMatchObject({ paused: true, items: [{ id: 'rejected', status: 'failed' }] }));
    expect(serializeQueuedInputForStorage({ ...item('checking'), status: 'submitting' }).status).toBe('queued');
    expect(serializeQueuedInputForStorage({ ...item('sent'), status: 'dispatching' }).status).toBe('delivery_uncertain');
});

it.each([false, true])('acknowledges a retry after execution without dispatching again (restart=%s)', async restart => {
    const calls = [], frames = [];
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input.runId);
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    const sid = `web:s_retry_${restart}`, writer = {send: frame => frames.push(frame)};
    const first = item(`accepted-${restart}`);
    await enqueueInputViaGateway(sid, first, writer);
    await vi.waitFor(() => expect(frames.some(frame => frame.kind === 'complete')).toBe(true));
    let enqueue = enqueueInputViaGateway;
    if (restart) {
        vi.resetModules();
        enqueue = (await import('./pilotdeck-bridge.js')).enqueueInputViaGateway;
    }
    const retry = await enqueue(sid, first, writer);
    expect(retry).toMatchObject({ok: true, state: {items: []}});
    expect(calls).toEqual([first.id]);
    await enqueue(sid, {...first, id: first.id + '-new', runId: first.id + '-new'}, writer);
    await vi.waitFor(() => expect(calls).toEqual([first.id, first.id + '-new']));
});


it('assigns a real ID before startup failure without acknowledging the input', async () => {
    const frames = [];
    const result = await runChatViaGateway('fixture', { projectPath: '/tmp/sending-project', runId: 'failed-start' },
        { send: frame => frames.push(frame) }, 'pilotdeck', {
            getGateway: async () => { throw new Error('Gateway unavailable'); },
        });
    expect(frames.find(frame => frame.kind === 'session_created')?.newSessionId).toBe(result.sessionKey);
    expect(frames.some(frame => frame.kind === 'error' && frame.terminal === true && frame.sessionId === result.sessionKey)).toBe(true);
    expect(frames.some(frame => frame.type === 'session-input-accepted')).toBe(false);
});

it('ends a General send when workspace preflight fails before input acceptance', async () => {
    const previousRoot = process.env.WORKSPACES_ROOT;
    process.env.WORKSPACES_ROOT = mock.home;
    const frames = [];
    const gateway = { submitTurn: vi.fn() };
    try {
        const result = await runChatViaGateway('fixture', { projectPath: mock.home, runId: 'workspace-failed-start' },
            { send: frame => frames.push(frame) }, 'pilotdeck', { getGateway: async () => gateway });
        expect(frames.find(frame => frame.kind === 'session_created')?.newSessionId).toBe(result.sessionKey);
        expect(frames.find(frame => frame.kind === 'error')).toMatchObject({
            terminal: true, sessionId: result.sessionKey, runId: 'workspace-failed-start',
            content: 'General workspace must be separate from PILOT_HOME.',
        });
        expect(frames.some(frame => frame.type === 'session-input-accepted')).toBe(false);
        expect(gateway.submitTurn).not.toHaveBeenCalled();
    } finally {
        if (previousRoot === undefined) delete process.env.WORKSPACES_ROOT;
        else process.env.WORKSPACES_ROOT = previousRoot;
    }
});

it.each(['general', 'PilotDeck'])('uses the new cwd for existing and new General conversations after migrating %s', async legacyName => {
    const previousRoot = process.env.WORKSPACES_ROOT;
    const root = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-general-turn-'));
    const legacy = path.join(root, legacyName);
    const current = path.join(root, 'PilotDeckGeneral');
    const sessionId = `web:general-migration-${randomUUID()}`;
    const reads = [], frames = [];
    await mkdir(legacy);
    if (legacyName === 'PilotDeck') await writeFile(path.join(legacy, '.pilotdeck-workspace'), JSON.stringify({ product: 'PilotDeck', version: 1, id: 'old-workspace' }));
    await writeFile(path.join(legacy, 'report.md'), 'report from an earlier conversation');
    process.env.WORKSPACES_ROOT = root;
    const gateway = {
        async *submitTurn(input) {
            reads.push({ cwd: input.workspaceCwd, report: await readFile(path.join(input.workspaceCwd, 'report.md'), 'utf8') });
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    try {
        const result = await runChatViaGateway('Read report.md', {
            projectPath: mock.home, sessionId, workspaceCwd: legacy,
        }, { send: frame => frames.push(frame) }, 'pilotdeck', { getGateway: async () => gateway });
        expect(result).toMatchObject({ sessionKey: sessionId, inputAccepted: true, sawTurnCompleted: true });
        expect(reads).toEqual([{ cwd: current, report: 'report from an earlier conversation' }]);
        const newConversation = await runChatViaGateway('Read report.md again', {
            projectPath: mock.home, workspaceCwd: legacy,
        }, { send: frame => frames.push(frame) }, 'pilotdeck', { getGateway: async () => gateway });
        expect(newConversation).toMatchObject({ inputAccepted: true, sawTurnCompleted: true });
        expect(reads).toHaveLength(2);
        expect(reads[1]).toEqual({ cwd: current, report: 'report from an earlier conversation' });
        expect(frames.some(frame => frame.kind === 'error')).toBe(false);
        expect(await readFile(path.join(legacy, 'report.md'), 'utf8')).toBe('report from an earlier conversation');
    } finally {
        if (previousRoot === undefined) delete process.env.WORKSPACES_ROOT;
        else process.env.WORKSPACES_ROOT = previousRoot;
        expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
        await rm(root, { recursive: true, force: true });
    }
});
