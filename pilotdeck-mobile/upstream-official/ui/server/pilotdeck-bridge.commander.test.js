import { afterAll, expect, it, vi } from 'vitest';

const mock = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const previousHome = process.env.PILOT_HOME;
    const home = mkdtempSync(join(tmpdir(), 'pilotdeck-commander-'));
    process.env.PILOT_HOME = home;
    return { gateway: null, home, previousHome };
});
vi.mock('./services/gatewayConnectionCache.js', () => ({
    createGatewayConnectionCache: () => ({ get: async () => mock.gateway, invalidate: () => {} }),
}));

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runChatViaGateway } from './pilotdeck-bridge.js';
import { writeProjectTeamConfig } from './services/projectTeamConfig.js';
import { COMMANDER_VERDICT_MARKER } from './services/commanderLoop.js';

const permissions = {
    toolAccess: 'all',
    allowedTools: [],
    deniedTools: [],
    network: 'none',
    writeScope: 'project',
    requireApproval: false,
};

afterAll(async () => {
    delete process.env.PILOTV_COMMANDER_LOOP;
    if (mock.previousHome === undefined) delete process.env.PILOT_HOME;
    else process.env.PILOT_HOME = mock.previousHome;
    await rm(mock.home, { recursive: true, force: true });
});

async function setupTeam({ mode = 'commander' } = {}) {
    const suffix = `${mode}-${Math.random().toString(36).slice(2, 8)}`;
    const projectRoot = path.join(mock.home, `commander-workspace-${suffix}`);
    await mkdir(projectRoot, { recursive: true });
    await mkdir(path.join(mock.home, 'projects', `commander-${suffix}`), { recursive: true });
    await writeFile(path.join(mock.home, 'projects', `commander-${suffix}`, '.cwd'), projectRoot);
    await writeProjectTeamConfig({
        projectRoot,
        revision: '0',
        collaboration: { mode },
        agents: [
            {
                id: 'boss',
                name: 'Boss',
                role: 'commander',
                enabled: true,
                description: '',
                roleDefinition: '',
                model: null,
                permissions,
            },
            {
                id: 'worker',
                name: 'Worker',
                role: 'executor',
                enabled: true,
                description: '',
                roleDefinition: '',
                model: null,
                reportsTo: 'boss',
                permissions,
            },
        ],
    });
    return projectRoot;
}

function createGateway({ replies, calls }) {
    return {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input);
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
        readSessionMessages: async () => ({
            messages: [{ role: 'assistant', content: replies.shift() ?? '' }],
        }),
    };
}

const verdict = (payload) => `${COMMANDER_VERDICT_MARKER}${JSON.stringify(payload)}`;

it('drives a task to completion instead of stopping after the first reply', async () => {
    process.env.PILOTV_COMMANDER_LOOP = '1';
    const projectRoot = await setupTeam();
    const calls = [];
    const frames = [];
    mock.gateway = createGateway({
        calls,
        replies: [
            '我先看一眼现状。',                                              // evidence for judgement #1
            verdict({ status: 'continue', summary: '还差测试', next: '补一个移动端快照测试' }),
            '快照测试已补上。',                                              // evidence for judgement #2
            verdict({ status: 'done', summary: '两条完成条件都满足' }),
        ],
    });
    const writer = { send: (frame) => frames.push(frame) };

    // 环境变量开关要求项目里真的解析出 team runtime；resolveProjectTeamRuntime
    // 只在显式选了成员（agentId）时才返回 teamConfig，否则会退化成 self 模式。
    await runChatViaGateway('把登录页改成手机可用', { projectPath: projectRoot, agentId: 'boss' }, writer);

    // 用户轮 + 判定 #1 + 派发给执行者 + 判定 #2
    expect(calls).toHaveLength(4);
    expect(calls[0].message).toBe('把登录页改成手机可用');
    const synthetic = (index) => (calls[index].syntheticMessages || []).map((message) => message.text).join('\n');
    expect(synthetic(1)).toContain('指挥判定');
    expect(synthetic(1)).toContain('「Boss」');
    expect(synthetic(2)).toContain('「Worker」');
    expect(synthetic(2)).toContain('补一个移动端快照测试');
    expect(synthetic(3)).toContain('指挥判定');

    const commanderTexts = frames
        .filter((frame) => frame.kind === 'status' && frame.status === 'commander')
        .map((frame) => frame.text);
    expect(commanderTexts.some((text) => text.includes('自动推进启动'))).toBe(true);
    expect(commanderTexts.some((text) => text.includes('任务结束'))).toBe(true);
});

it('stops at the iteration budget when the commander never says done', async () => {
    process.env.PILOTV_COMMANDER_LOOP = '1';
    process.env.PILOTV_COMMANDER_MAX_ITERATIONS = '2';
    const projectRoot = await setupTeam({ mode: 'automated' });
    const calls = [];
    const frames = [];
    mock.gateway = createGateway({
        calls,
        replies: [
            'evidence 1',
            verdict({ status: 'continue', next: '第一步' }),
            'evidence 2',
            verdict({ status: 'continue', next: '第二步' }),
            'evidence 3',
            verdict({ status: 'continue', next: '第三步' }),
        ],
    });
    const writer = { send: (frame) => frames.push(frame) };

    await runChatViaGateway('一个永远做不完的任务', { projectPath: projectRoot, agentId: 'boss' }, writer);

    // 用户轮 + 判定#1 + 派发#1 + 判定#2 + 派发#2 + 判定#3（第 3 次判定触到上限）
    expect(calls).toHaveLength(6);
    const commanderTexts = frames
        .filter((frame) => frame.kind === 'status' && frame.status === 'commander')
        .map((frame) => frame.text);
    expect(commanderTexts.some((text) => text.includes('max_iterations'))).toBe(true);
    delete process.env.PILOTV_COMMANDER_MAX_ITERATIONS;
});

it('does nothing when the deployment switch is off', async () => {
    delete process.env.PILOTV_COMMANDER_LOOP;
    const projectRoot = await setupTeam();
    const calls = [];
    const frames = [];
    mock.gateway = createGateway({ calls, replies: [] });
    const writer = { send: (frame) => frames.push(frame) };

    await runChatViaGateway('只聊一句', { projectPath: projectRoot }, writer);

    expect(calls).toHaveLength(1);
    expect(frames.some((frame) => frame.status === 'commander')).toBe(false);
});

it('leaves manual collaboration mode alone even with the switch on', async () => {
    process.env.PILOTV_COMMANDER_LOOP = '1';
    const projectRoot = await setupTeam({ mode: 'manual' });
    const calls = [];
    const frames = [];
    mock.gateway = createGateway({ calls, replies: [] });
    const writer = { send: (frame) => frames.push(frame) };

    await runChatViaGateway('手动模式', { projectPath: projectRoot }, writer);

    expect(calls).toHaveLength(1);
    expect(frames.some((frame) => frame.status === 'commander')).toBe(false);
});

it('runs from the composer switch even when the deployment switch is off', async () => {
    delete process.env.PILOTV_COMMANDER_LOOP;
    const projectRoot = await setupTeam();
    const calls = [];
    const frames = [];
    mock.gateway = createGateway({
        calls,
        replies: [
            '现状是这样。',
            verdict({ status: 'done', summary: '目标已达成' }),
        ],
    });
    const writer = { send: (frame) => frames.push(frame) };

    await runChatViaGateway('把登录页改成手机可用', { projectPath: projectRoot, autoDrive: true }, writer);

    // 用户轮 + 判定轮
    expect(calls).toHaveLength(2);
    expect(frames.some((frame) => frame.status === 'commander')).toBe(true);
});

it('the switch being off wins over the deployment switch', async () => {
    process.env.PILOTV_COMMANDER_LOOP = '1';
    const projectRoot = await setupTeam();
    const calls = [];
    const frames = [];
    mock.gateway = createGateway({ calls, replies: [] });
    const writer = { send: (frame) => frames.push(frame) };

    await runChatViaGateway('这一轮我自己看', { projectPath: projectRoot, autoDrive: false }, writer);

    expect(calls).toHaveLength(1);
    expect(frames.some((frame) => frame.status === 'commander')).toBe(false);
});

it('self-checks with the current agent when the project has no team config', async () => {
    delete process.env.PILOTV_COMMANDER_LOOP;
    const projectRoot = path.join(mock.home, `no-team-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(projectRoot, { recursive: true });
    const calls = [];
    const frames = [];
    mock.gateway = createGateway({
        calls,
        replies: [
            '先做了第一步。',
            verdict({ status: 'done', summary: '目标已达成' }),
        ],
    });
    const writer = { send: (frame) => frames.push(frame) };

    await runChatViaGateway('把登录页改成手机可用', { projectPath: projectRoot, autoDrive: true }, writer);

    expect(calls).toHaveLength(2);
    const synthetic = (index) => (calls[index].syntheticMessages || []).map((message) => message.text).join('\n');
    expect(synthetic(1)).toContain('指挥判定');
    expect(calls[1].agentId).toBeUndefined();
    const commanderTexts = frames
        .filter((frame) => frame.kind === 'status' && frame.status === 'commander')
        .map((frame) => frame.text);
    expect(commanderTexts.some((text) => text.includes('自检'))).toBe(true);
});
