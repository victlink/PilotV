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

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

/**
 * 清掉指挥循环账本目录。
 *
 * 这个文件里的用例共用同一个临时 home，所以上一个用例**暂停**（而不是归档）
 * 留下的账本会留在这里。断言「账本被暂停了」时必须先清干净，
 * 否则读到的是别的会话的账本，测试就成了假绿。
 */
async function clearLoopLedger() {
    const dir = path.join(mock.home, 'commander-loops');
    if (!existsSync(dir)) return;
    for (const name of await readdir(dir)) {
        if (name.endsWith('.json')) {
            await rm(path.join(dir, name), { force: true });
        }
    }
}

async function setupTeam({ mode = 'commander' } = {}) {    const suffix = `${mode}-${Math.random().toString(36).slice(2, 8)}`;
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

it('无进展熔断：判定轮复读时主动 abort，任务被暂停并可自动续跑（不再直接终止）', async () => {
    const envKeys = [
        'PILOTV_STALL_MAX_REPEATED_THINKING',
        'PILOTV_STALL_MAX_TURN_MS',
        'PILOTV_STALL_MAX_TURN_TOKENS',
    ];
    const saved = envKeys.map((key) => process.env[key]);
    process.env.PILOTV_COMMANDER_LOOP = '1';
    process.env.PILOTV_STALL_MAX_REPEATED_THINKING = '2';
    process.env.PILOTV_STALL_MAX_TURN_MS = '0';
    process.env.PILOTV_STALL_MAX_TURN_TOKENS = '0';

    await clearLoopLedger();
    const projectRoot = await setupTeam();
    const calls = [];
    const frames = [];
    const aborts = [];
    const repeated = 'The memory says read-only, no FreeCAD. ';
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input);
            yield { type: 'input_accepted', runId: input.runId };
            const isJudgement = (input.syntheticMessages || [])
                .some((message) => message.purpose === 'commander_judgement');
            if (isJudgement) {
                yield { type: 'assistant_block', kind: 'thinking', text: repeated };
                yield { type: 'assistant_block', kind: 'thinking', text: repeated };
                yield { type: 'assistant_stream_end' };
            }
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
        readSessionMessages: async () => ({
            messages: [{ role: 'assistant', content: verdict({ status: 'continue', summary: '还差一步', next: '继续' }) }],
        }),
        abortTurn: async (args) => { aborts.push(args); return true; },
    };
    const writer = { send: (frame) => frames.push(frame) };
    try {
        await runChatViaGateway('继续完成 CAD 交付', { projectPath: projectRoot, agentId: 'boss' }, writer);
    } finally {
        envKeys.forEach((key, index) => {
            if (saved[index] === undefined) delete process.env[key];
            else process.env[key] = saved[index];
        });
        delete process.env.PILOTV_COMMANDER_LOOP;
    }
    // abortTurn 是 fire-and-forget，让微任务跑完再断言。
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(aborts).not.toHaveLength(0);
    expect(frames.some((frame) => frame.status === 'turn_stalled')).toBe(true);
    const commanderTexts = frames
        .filter((frame) => frame.kind === 'status' && frame.status === 'commander')
        .map((frame) => frame.text);
    // 熔断不再终止任务，而是**暂停**并说明稍后自动续跑。
    expect(commanderTexts.some((text) => text.includes('已暂停'))).toBe(true);
    expect(commanderTexts.some((text) => text.includes('自动续跑'))).toBe(true);
    // 暂停不是断连：不能把用户吓成「网关挂了」。
    expect(commanderTexts.some((text) => text.includes('网关断连'))).toBe(false);

    // 关键：账本**没有**被归档。归档（删除 running 文件）是「永不恢复」的
    // 唯一凭据，暂停态必须留着文件，恢复守护才接得回来。
    const historyPath = path.join(mock.home, 'commander-loops', 'history.jsonl');
    const historyExists = existsSync(historyPath);
    if (historyExists) {
        const lines = (await readFile(historyPath, 'utf8')).trim().split('\n').map(JSON.parse);
        expect(lines.some((entry) => entry.stopReason === 'no_progress_stall')).toBe(false);
    }
    const runningDir = path.join(mock.home, 'commander-loops');
    const runningFiles = existsSync(runningDir)
        ? (await readdir(runningDir)).filter((name) => name.endsWith('.json'))
        : [];
    expect(runningFiles).not.toHaveLength(0);
    const paused = JSON.parse(await readFile(path.join(runningDir, runningFiles[0]), 'utf8'));
    expect(paused.status).toBe('paused');
    expect(paused.stopReason).toContain('paused:');
    // 恢复时要注入「换做法」的提示，否则模型会原样再犯一次。
    expect(typeof paused.resumeHint).toBe('string');
    expect(paused.resumeHint.length).toBeGreaterThan(0);
});

it('调度器关闭时熔断仍按旧语义终止（回滚开关）', async () => {
    const envKeys = [
        'PILOTV_STALL_MAX_REPEATED_THINKING',
        'PILOTV_STALL_MAX_TURN_MS',
        'PILOTV_STALL_MAX_TURN_TOKENS',
        'PILOTV_SCHEDULER',
    ];
    const saved = envKeys.map((key) => process.env[key]);
    process.env.PILOTV_COMMANDER_LOOP = '1';
    process.env.PILOTV_STALL_MAX_REPEATED_THINKING = '2';
    process.env.PILOTV_STALL_MAX_TURN_MS = '0';
    process.env.PILOTV_STALL_MAX_TURN_TOKENS = '0';
    process.env.PILOTV_SCHEDULER = '0';

    const projectRoot = await setupTeam();
    const frames = [];
    const aborts = [];
    const repeated = 'The memory says read-only, no FreeCAD. ';
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            yield { type: 'input_accepted', runId: input.runId };
            const isJudgement = (input.syntheticMessages || [])
                .some((message) => message.purpose === 'commander_judgement');
            if (isJudgement) {
                yield { type: 'assistant_block', kind: 'thinking', text: repeated };
                yield { type: 'assistant_block', kind: 'thinking', text: repeated };
                yield { type: 'assistant_stream_end' };
            }
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
        readSessionMessages: async () => ({
            messages: [{ role: 'assistant', content: verdict({ status: 'continue', summary: '还差一步', next: '继续' }) }],
        }),
        abortTurn: async (args) => { aborts.push(args); return true; },
    };
    const writer = { send: (frame) => frames.push(frame) };
    try {
        await runChatViaGateway('继续完成 CAD 交付', { projectPath: projectRoot, agentId: 'boss' }, writer);
    } finally {
        envKeys.forEach((key, index) => {
            if (saved[index] === undefined) delete process.env[key];
            else process.env[key] = saved[index];
        });
        delete process.env.PILOTV_COMMANDER_LOOP;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(aborts).not.toHaveLength(0);
    const history = path.join(mock.home, 'commander-loops', 'history.jsonl');
    const lines = (await readFile(history, 'utf8')).trim().split('\n').map(JSON.parse);
    const archived = lines[lines.length - 1];
    expect(archived.status).toBe('waiting_user');
    expect(archived.stopReason).toBe('no_progress_stall');
});

it('进展感知回归：判定轮有成功工具产出时不会被误判为无进展', async () => {
    const envKeys = [
        'PILOTV_STALL_MAX_REPEATED_THINKING',
        'PILOTV_STALL_MAX_TURN_MS',
        'PILOTV_STALL_MAX_TURN_TOKENS',
    ];
    const saved = envKeys.map((key) => process.env[key]);
    process.env.PILOTV_COMMANDER_LOOP = '1';
    process.env.PILOTV_STALL_MAX_REPEATED_THINKING = '2';
    process.env.PILOTV_STALL_MAX_TURN_MS = '0';
    process.env.PILOTV_STALL_MAX_TURN_TOKENS = '0';

    const projectRoot = await setupTeam();
    const frames = [];
    const aborts = [];
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            yield { type: 'input_accepted', runId: input.runId };
            const isJudgement = (input.syntheticMessages || [])
                .some((message) => message.purpose === 'commander_judgement');
            if (isJudgement) {
                // 同一段 thinking 出现两次（旧阈值会误杀），但中间夹着成功的写工具。
                yield { type: 'assistant_block', kind: 'thinking', text: '继续核对装配体尺寸。' };
                yield { type: 'tool_call_started', name: 'edit_file', toolCallId: 'c1' };
                yield { type: 'tool_call_finished', ok: true, toolName: 'edit_file', toolCallId: 'c1' };
                yield { type: 'assistant_block', kind: 'thinking', text: '继续核对装配体尺寸。' };
                yield { type: 'assistant_stream_end' };
            }
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
        readSessionMessages: async () => ({
            messages: [{ role: 'assistant', content: verdict({ status: 'done', summary: '已完成' }) }],
        }),
        abortTurn: async (args) => { aborts.push(args); return true; },
    };
    const writer = { send: (frame) => frames.push(frame) };
    try {
        await runChatViaGateway('继续完成 CAD 交付', { projectPath: projectRoot, agentId: 'boss' }, writer);
    } finally {
        envKeys.forEach((key, index) => {
            if (saved[index] === undefined) delete process.env[key];
            else process.env[key] = saved[index];
        });
        delete process.env.PILOTV_COMMANDER_LOOP;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(aborts).toHaveLength(0);
    expect(frames.some((frame) => frame.status === 'turn_stalled')).toBe(false);
    const history = path.join(mock.home, 'commander-loops', 'history.jsonl');
    const lines = (await readFile(history, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(lines[lines.length - 1].stopReason).not.toBe('no_progress_stall');
});

it('子 agent 事件包装回归：网关 agent_status 格式的子 agent 复读能被识别并熔断', async () => {
    const envKeys = [
        'PILOTV_STALL_MAX_REPEATED_THINKING',
        'PILOTV_STALL_MAX_TURN_MS',
        'PILOTV_STALL_MAX_TURN_TOKENS',
    ];
    const saved = envKeys.map((key) => process.env[key]);
    process.env.PILOTV_COMMANDER_LOOP = '1';
    process.env.PILOTV_STALL_MAX_REPEATED_THINKING = '3';
    process.env.PILOTV_STALL_MAX_TURN_MS = '0';
    process.env.PILOTV_STALL_MAX_TURN_TOKENS = '0';

    await clearLoopLedger();
    const projectRoot = await setupTeam();
    const frames = [];
    const aborts = [];
    // 真实网关格式：子 agent 事件被包在 agent_status 里，而不是顶层 subagent_*。
    const wrapped = (event, detail = {}) => ({ type: 'agent_status', event, detail });
    const repeated = 'The memory says read-only, no FreeCAD. ';
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            yield { type: 'input_accepted', runId: input.runId };
            const isJudgement = (input.syntheticMessages || [])
                .some((message) => message.purpose === 'commander_judgement');
            if (isJudgement) {
                for (let i = 0; i < 3; i += 1) {
                    yield wrapped('subagent_thinking_delta', {
                        subagentId: 'sa-integration', subagentType: 'agent', text: repeated,
                    });
                    yield wrapped('subagent_stream_end', { subagentId: 'sa-integration' });
                }
            }
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
        readSessionMessages: async () => ({
            messages: [{ role: 'assistant', content: verdict({ status: 'done', summary: '已完成' }) }],
        }),
        abortTurn: async (args) => { aborts.push(args); return true; },
    };
    const writer = { send: (frame) => frames.push(frame) };
    try {
        await runChatViaGateway('继续完成 CAD 交付', { projectPath: projectRoot, agentId: 'boss' }, writer);
    } finally {
        envKeys.forEach((key, index) => {
            if (saved[index] === undefined) delete process.env[key];
            else process.env[key] = saved[index];
        });
        delete process.env.PILOTV_COMMANDER_LOOP;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 旧实现里 subagent_* case 是死代码，这里不会有任何 stall；修好后必须命中。
    expect(aborts).not.toHaveLength(0);
    expect(frames.some((frame) => frame.status === 'turn_stalled')).toBe(true);
    // 子 agent 复读同样走「暂停后自动续跑」，不是终止。
    const runningDir = path.join(mock.home, 'commander-loops');
    const runningFiles = (await readdir(runningDir)).filter((name) => name.endsWith('.json'));
    expect(runningFiles).not.toHaveLength(0);
    const paused = JSON.parse(await readFile(path.join(runningDir, runningFiles[0]), 'utf8'));
    expect(paused.status).toBe('paused');
    expect(paused.stopReason).toContain('repeated_subagent_thinking');
});
