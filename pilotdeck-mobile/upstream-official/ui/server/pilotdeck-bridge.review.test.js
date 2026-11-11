import { afterAll, beforeEach, expect, it, vi } from 'vitest';
const mock = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const previousHome = process.env.PILOT_HOME;
    const home = mkdtempSync(join(tmpdir(), 'pilotdeck-review-'));
    process.env.PILOT_HOME = home;
    return { home, previousHome, config: null, gateway: null };
});
vi.mock('./services/projectTeamRuntime.js', () => ({
    resolveProjectTeamRuntime: async ({ agentId, projectKey }) => {
        const agent = mock.config.agents.find(a => a.id === agentId);
        if (!agent) return { projectRoot: projectKey, teamConfig: mock.config, syntheticMessages: [] };
        return { projectRoot: projectKey, teamConfig: mock.config, agentId: agent.id, agent,
            syntheticMessages: [{ text: agent.name, purpose: 'project_agent_role' }],
            modelSelection: agent.model, toolPolicy: agent.policy };
    },
}));
vi.mock('./services/gatewayConnectionCache.js', () => ({ createGatewayConnectionCache: () => ({ get: async () => mock.gateway, invalidate: () => {} }) }));
// 显式审查要直读团队配置：manual 模式下 `resolveProjectTeamRuntime` 不返回配置。
vi.mock('./services/projectTeamConfig.js', () => ({
    readProjectTeamConfig: async () => mock.config,
}));
import { enqueueInputViaGateway, getInputQueueStateViaGateway, requestProjectReview, resumeInputQueueViaGateway, runChatViaGateway } from './pilotdeck-bridge.js';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

it('resolves persisted solo mode for a queued turn and blocks both reviews', async () => {
    const sessionKey = 'web:s_review_solo';
    const projectPath = '/fixture/project';
    const key = createHash('sha256').update(JSON.stringify([resolve(projectPath), sessionKey])).digest('hex');
    const dir = join(mock.home, 'session-execution-modes');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${key}.json`), JSON.stringify({ executionMode: 'solo' }));
    const { calls } = await run('worker', { sessionId: sessionKey, projectPath, executionMode: 'autoSplit' });
    expect(calls.map(call => call.executionMode)).toEqual(['solo']);
    const frames = [];
    const getGateway = vi.fn();
    const result = await requestProjectReview({ sessionId: sessionKey, projectPath },
        { send: frame => frames.push(frame) }, 'pilotdeck', { getGateway });
    expect(result.dispatched).toBe(false);
    expect(frames[0]?.code).toBe('review_solo_mode');
    expect(getGateway).not.toHaveBeenCalled();
});
beforeEach(() => { mock.config = { collaboration: { mode: 'automated' }, agents: [
    { id: 'worker', name: '执行员', role: 'implementer', enabled: true },
    { id: 'reviewer', name: '审查员', role: 'reviewer', enabled: true, reportsTo: null,
        model: { mode: 'model', provider: 'fixture', model: 'review-model' }, policy: { allow: ['read_file'] } },
] }; });
afterAll(async () => {
    if (mock.previousHome === undefined) delete process.env.PILOT_HOME;
    else process.env.PILOT_HOME = mock.previousHome;
    await rm(mock.home, { recursive: true, force: true });
});
async function run(agentId, extra = {}, finishReason = 'completed') {
    const calls = [], frames = [];
    const gateway = { async *submitTurn(input) {
        calls.push(input);
        yield { type: 'input_accepted', runId: input.runId };
        yield { type: 'assistant_text_delta', text: calls.length === 1 ? '执行内容' : '独立审查内容', runId: input.runId };
        yield { type: 'turn_completed', runId: input.runId, finishReason, usage: {} };
    } };
    await runChatViaGateway('用户请求', { projectPath: '/fixture/project', agentId, ...extra },
        { send: frame => frames.push(frame) }, 'pilotdeck', { getGateway: async () => gateway, fromQueue: true });
    return { calls, frames };
}
it.each([{ mode: 'auto' }, { mode: 'model', provider: 'fixture', model: 'user-model' }])(
    'keeps the queued user choice $mode for both the worker and background review', async selection => {
        mock.config.agents[0].model = { mode: 'model', provider: 'fixture', model: 'worker-model' };
        const { calls } = await run('worker', { modelSelection: selection });
        expect(calls.map(call => call.modelSelection)).toEqual([selection, selection]);
        expect(calls.every(call => call.modelOverride === undefined)).toBe(true);
    });
it('keeps legacy override turn-only for the worker and background review', async () => {
    mock.config.agents[0].model = { mode: 'model', provider: 'fixture', model: 'worker-model' };
    const override = { mode: 'model', provider: 'fixture', model: 'legacy-model' };
    const { calls } = await run('worker', { modelOverride: override });
    expect(calls.map(call => call.modelOverride)).toEqual([override, override]);
    expect(calls.every(call => call.modelSelection === undefined)).toBe(true);
});
it('reuses the queued model choice after a pre-acceptance failure', async () => {
    mock.config.agents[0].model = { mode: 'model', provider: 'fixture', model: 'worker-model' };
    const selection = { mode: 'model', provider: 'fixture', model: 'user-model' };
    const calls = [];
    const writer = { send() {} };
    const sessionKey = 'web:s_review_model_retry';
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input);
            if (calls.length === 1) {
                yield { type: 'error', code: 'fixture_failure', message: 'Try again', runId: input.runId };
                return;
            }
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    expect((await enqueueInputViaGateway(sessionKey, {
        id: 'model-retry', command: 'retry fixture',
        options: { projectPath: '/fixture/project', agentId: 'worker', modelSelection: selection },
    }, writer)).ok).toBe(true);
    await vi.waitFor(async () => expect(await getInputQueueStateViaGateway(sessionKey)).toMatchObject({ paused: true, items: [{ status: 'failed' }] }));
    expect((await resumeInputQueueViaGateway(sessionKey, writer)).ok).toBe(true);
    await vi.waitFor(() => expect(calls.map(call => call.modelSelection)).toEqual([selection, selection, selection]));
    expect(calls[1].runId).toBe(calls[0].runId);
    expect(calls[2].message).toBe('');
});
it.each(['worker', undefined])('starts one independent same-session review after %s, including queued turns', async agentId => {
    const { calls, frames } = await run(agentId, { uploadedAttachments: [{ id: 'original-upload' }] });
    expect(calls).toHaveLength(2);
    expect(calls[1].sessionKey).toBe(calls[0].sessionKey);
    expect(calls[1].runId).not.toBe(calls[0].runId);
    expect(calls[1].message).toBe('');
    expect(calls[1].syntheticMessages).toEqual(expect.arrayContaining([expect.objectContaining({ purpose: 'project_agent_review_request' })]));
    expect(calls[1].modelSelection).toBeUndefined();
    expect(calls[1].defaultModelSelection).toEqual(mock.config.agents[1].model);
    expect(calls[1].toolPolicy).toEqual({ allow: ['read_file'] });
    expect(calls[1].uploadedAttachments).toBeUndefined();
    expect(frames.some(f => f.kind === 'stream_delta' && f.agentName === '审查员')).toBe(true);
    expect(frames.some(f => f.role === 'user')).toBe(false);
});
it.each(['completed', 'aborted', 'error'])('dispatches queued input first without stale review (latest=%s)', async latestFinishReason => {
    const calls = [], frames = [];
    const writer = { send: frame => frames.push(frame) };
    mock.gateway = { async *submitTurn(input) {
        calls.push(input);
        yield { type: 'input_accepted', runId: input.runId };
        if (calls.length === 1) {
            await enqueueInputViaGateway(input.sessionKey, {
                id: 'queued-review-order', runId: 'queued-review-order', command: '后续请求',
                agentId: 'worker', options: { projectPath: '/fixture/project' },
            }, writer);
        }
        yield { type: 'assistant_text_delta', text: '回复', runId: input.runId };
        yield { type: 'turn_completed', runId: input.runId,
            finishReason: input.runId === 'queued-review-order' ? latestFinishReason : 'completed', usage: {} };
    } };
    await runChatViaGateway('首个请求', { projectPath: '/fixture/project', agentId: 'worker' },
        writer, 'pilotdeck', { getGateway: async () => mock.gateway, fromQueue: true });
    if (latestFinishReason !== 'completed') {
        expect(calls.map(call => call.message)).toEqual(['首个请求', '后续请求']);
        return;
    }
    expect(calls.map(call => call.message)).toEqual(['首个请求', '后续请求', '']);
    const review = calls[2].syntheticMessages.find(message => message.purpose === 'project_agent_review_request');
    expect(review.text).toContain('queued-review-order');
    expect(review.text).not.toContain(calls[0].runId);
});

it('manual collaboration does not launch review', async () => {
    mock.config.collaboration.mode = 'manual';
    expect((await run('worker')).calls).toHaveLength(1);
});
it('failed or aborted user turn does not launch review', async () => {
    expect((await run('worker', {}, 'aborted')).calls).toHaveLength(1);
});
it('disabled reviewer does not launch review', async () => {
    mock.config.agents[1].enabled = false;
    expect((await run('worker')).calls).toHaveLength(1);
});
it('reviewer selected directly does not trigger another reviewer', async () => {
    mock.config.agents.push({ id: 'reviewer2', name: '另一个审查员', role: 'reviewer', enabled: true, reportsTo: null });
    expect((await run('reviewer')).calls).toHaveLength(1);
});

/**
 * manual 协作模式下自动审查不会跑，用户必须能显式把这一轮交给审查员。
 */
it('explicit review request runs one reviewer turn in manual mode', async () => {
    mock.config.collaboration.mode = 'manual';
    const calls = [], frames = [];
    const gateway = { async *submitTurn(input) {
        calls.push(input);
        yield { type: 'input_accepted', runId: input.runId };
        yield { type: 'assistant_text_delta', text: '手动审查内容', runId: input.runId };
        yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
    } };
    const writer = { send: frame => frames.push(frame) };
    await runChatViaGateway('用户请求', { projectPath: '/fixture/project', agentId: 'worker' },
        writer, 'pilotdeck', { getGateway: async () => gateway, fromQueue: true });
    // manual 模式下没有自动审查。
    expect(calls).toHaveLength(1);

    const result = await requestProjectReview(
        { sessionId: calls[0].sessionKey, projectPath: '/fixture/project', agentId: 'reviewer' },
        writer, 'pilotdeck', { getGateway: async () => gateway });

    expect(result.dispatched).toBe(true);
    expect(result.reviewerId).toBe('reviewer');
    expect(calls).toHaveLength(2);
    expect(calls[1].sessionKey).toBe(calls[0].sessionKey);
    expect(calls[1].message).toBe('');
    expect(calls[1].syntheticMessages).toEqual(expect.arrayContaining([
        expect.objectContaining({ purpose: 'project_agent_review_request' }),
    ]));
    // 审查员用自己的模型和工具权限。
    expect(calls[1].modelSelection).toBeUndefined();
    expect(calls[1].defaultModelSelection).toEqual(mock.config.agents[1].model);
    expect(calls[1].toolPolicy).toEqual({ allow: ['read_file'] });
    // 回复挂在同一个会话里，并带上审查员的身份。
    expect(frames.some(f => f.kind === 'stream_delta' && f.agentName === '审查员')).toBe(true);
    expect(frames.some(f => f.role === 'user')).toBe(false);
    // 显式审查不会再自己触发一轮审查。
    expect(calls).toHaveLength(2);
});

it('explicit review request reports a missing reviewer instead of doing nothing', async () => {
    mock.config.collaboration.mode = 'manual';
    mock.config.agents = mock.config.agents.filter(agent => agent.role !== 'reviewer');
    const calls = [], frames = [];
    const gateway = { async *submitTurn(input) {
        calls.push(input);
        yield { type: 'input_accepted', runId: input.runId };
        yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
    } };
    const writer = { send: frame => frames.push(frame) };
    await runChatViaGateway('用户请求', { projectPath: '/fixture/project' },
        writer, 'pilotdeck', { getGateway: async () => gateway, fromQueue: true });

    const result = await requestProjectReview(
        { sessionId: calls[0].sessionKey, projectPath: '/fixture/project' },
        writer, 'pilotdeck', { getGateway: async () => gateway });

    expect(result.dispatched).toBe(false);
    expect(calls).toHaveLength(1);
    expect(frames.some(f => f.code === 'review_reviewer_missing')).toBe(true);
});

it('explicit review request needs an existing session', async () => {
    const frames = [];
    const result = await requestProjectReview(
        { sessionId: 'not-a-session-key', projectPath: '/fixture/project' },
        { send: frame => frames.push(frame) }, 'pilotdeck', { getGateway: async () => ({}) });

    expect(result.dispatched).toBe(false);
    expect(frames.some(f => f.code === 'review_session_missing')).toBe(true);
});
