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
import { enqueueInputViaGateway, runChatViaGateway } from './pilotdeck-bridge.js';
import { rm } from 'node:fs/promises';
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
it.each(['worker', undefined])('starts one independent same-session review after %s, including queued turns', async agentId => {
    const { calls, frames } = await run(agentId, { uploadedAttachments: [{ id: 'original-upload' }] });
    expect(calls).toHaveLength(2);
    expect(calls[1].sessionKey).toBe(calls[0].sessionKey);
    expect(calls[1].runId).not.toBe(calls[0].runId);
    expect(calls[1].message).toBe('');
    expect(calls[1].syntheticMessages).toEqual(expect.arrayContaining([expect.objectContaining({ purpose: 'project_agent_review_request' })]));
    expect(calls[1].modelSelection).toEqual(mock.config.agents[1].model);
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
