import { describe, expect, it } from 'vitest';

import {
    COMMANDER_DEFAULT_LIMITS,
    extractAcceptance,
    COMMANDER_VERDICT_MARKER,
    buildJudgeRequest,
    buildWorkerDispatch,
    createCommanderState,
    decideNextAction,
    describeAction,
    lastAssistantText,
    noteDispatch,
    normalizeInstruction,
    parseVerdict,
    progressKey,
    settleCommanderState,
} from './commanderLoop.js';

const verdictLine = (payload) => `${COMMANDER_VERDICT_MARKER}${JSON.stringify(payload)}`;

function delegatedState(overrides = {}) {
    return createCommanderState({
        sessionKey: 'web:s_test',
        goal: '把登录页改成手机可用的',
        acceptance: ['手机宽度无横向滚动', 'npm test 通过'],
        mode: 'delegated',
        commanderId: 'boss',
        workerId: 'worker',
        limits: { maxIterations: 3, maxInstructionRepeats: 2, maxWallClockMs: 60_000 },
        now: 1_000,
        ...overrides,
    });
}

describe('normalizeInstruction / progressKey', () => {
    it('collapses whitespace and punctuation so cosmetic rewrites compare equal', () => {
        expect(normalizeInstruction('  1. 修复  登录页 。 ')).toBe('修复 登录页');
        expect(progressKey('修复 登录页。')).toBe(progressKey('修复   登录页'));
    });

    it('separates genuinely different instructions', () => {
        expect(progressKey('修复登录页')).not.toBe(progressKey('补测试'));
    });
});

describe('parseVerdict', () => {
    it('reads the marker line', () => {
        const text = `已经改完首屏。\n${verdictLine({ status: 'continue', summary: '还差测试', next: '补一个移动端快照测试' })}`;
        const verdict = parseVerdict(text);
        expect(verdict.ok).toBe(true);
        expect(verdict.status).toBe('continue');
        expect(verdict.nextInstruction).toBe('补一个移动端快照测试');
    });

    it('reads a fenced json block without the marker', () => {
        const text = '结论如下：\n```json\n{"status":"done","summary":"全部通过"}\n```\n';
        const verdict = parseVerdict(text);
        expect(verdict.ok).toBe(true);
        expect(verdict.status).toBe('done');
    });

    it('reads a bare json object with a status field', () => {
        expect(parseVerdict('{"status":"blocked","reason":"缺少后端地址"}').status).toBe('blocked');
    });

    it('rejects an unknown status instead of guessing', () => {
        const verdict = parseVerdict(verdictLine({ status: 'almost' }));
        expect(verdict.ok).toBe(false);
        expect(verdict.status).toBeNull();
        expect(verdict.reason).toContain('verdict_status_invalid');
    });

    it('rejects prose with no payload', () => {
        const verdict = parseVerdict('我觉得差不多了，应该没问题。');
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toBe('verdict_marker_missing');
    });

    it('survives truncated json in the message', () => {
        expect(parseVerdict(`${COMMANDER_VERDICT_MARKER}{"status":"cont`).ok).toBe(false);
    });
});

describe('extractAcceptance', () => {
    it('reads a bulleted criteria block', () => {
        const items = extractAcceptance('把登录页改成手机可用\n完成条件：\n- 无横向滚动\n2. npm test 通过\n\n顺便看看配色');
        expect(items).toEqual(['无横向滚动', 'npm test 通过']);
    });

    it('reads an inline criteria line', () => {
        expect(extractAcceptance('做登录页，验收：320px 下不出现横向滚动')).toEqual(['320px 下不出现横向滚动']);
    });

    it('returns nothing when the user did not state criteria', () => {
        expect(extractAcceptance('把登录页改一下')).toEqual([]);
        expect(extractAcceptance('')).toEqual([]);
    });
});

describe('decideNextAction', () => {
    it('dispatches the next instruction when the commander says continue', () => {
        const state = delegatedState();
        const action = decideNextAction(state, parseVerdict(verdictLine({
            status: 'continue',
            next: '补移动端快照测试',
            assignee: 'worker',
        })), { now: 2_000 });
        expect(action.type).toBe('dispatch');
        expect(action.instruction).toBe('补移动端快照测试');
        expect(action.assignee).toBe('worker');
    });

    it('finishes only on an explicit done verdict', () => {
        const state = delegatedState();
        const action = decideNextAction(state, parseVerdict(verdictLine({ status: 'done', summary: '两条完成条件都满足' })), { now: 2_000 });
        expect(action.type).toBe('finish');
        expect(action.summary).toContain('完成条件');
    });

    it('surfaces blocked work to the human instead of burning turns', () => {
        const state = delegatedState();
        const action = decideNextAction(state, parseVerdict(verdictLine({ status: 'blocked', reason: '缺少测试账号' })), { now: 2_000 });
        expect(action.type).toBe('wait_user');
        expect(action.reason).toBe('缺少测试账号');
    });

    it('stops when the human takes over', () => {
        const state = delegatedState();
        const action = decideNextAction(state, parseVerdict(verdictLine({ status: 'continue', next: 'x' })), {
            now: 2_000,
            userTookOver: true,
        });
        expect(action.type).toBe('stop');
        expect(action.reason).toBe('user_took_over');
    });

    it('stops at the iteration budget', () => {
        const state = delegatedState();
        state.iteration = state.limits.maxIterations;
        const action = decideNextAction(state, parseVerdict(verdictLine({ status: 'continue', next: '再来一轮' })), { now: 2_000 });
        expect(action.type).toBe('stop');
        expect(action.reason).toBe('max_iterations');
    });

    it('stops on the wall clock budget', () => {
        const state = delegatedState();
        const action = decideNextAction(state, parseVerdict(verdictLine({ status: 'continue', next: '再来一轮' })), {
            now: state.startedAt + state.limits.maxWallClockMs + 1,
        });
        expect(action.type).toBe('stop');
        expect(action.reason).toBe('time_budget');
    });

    it('stops when the same instruction repeats — the practical shape of a stuck loop', () => {
        const state = delegatedState();
        const verdict = parseVerdict(verdictLine({ status: 'continue', next: '再检查一遍风格' }));
        const first = decideNextAction(state, verdict, { now: 2_000 });
        noteDispatch(state, first, { now: 2_000 });
        const second = decideNextAction(state, verdict, { now: 3_000 });
        noteDispatch(state, second, { now: 3_000 });
        const third = decideNextAction(state, verdict, { now: 4_000 });
        expect(second.type).toBe('dispatch');
        expect(third.type).toBe('stop');
        expect(third.reason).toBe('no_progress');
    });

    it('retries an unreadable verdict, then asks the human', () => {
        const state = delegatedState();
        // 生产默认已放宽到 3 次；这里显式固定为 2，保留原语义回归。
        state.limits = { ...state.limits, maxInvalidVerdicts: 2 };
        const bad = parseVerdict('我先看看情况');
        const first = decideNextAction(state, bad, { now: 2_000 });
        const second = decideNextAction(state, bad, { now: 3_000 });
        expect(first.type).toBe('dispatch');
        expect(second.type).toBe('wait_user');
        expect(second.reason).toBe('verdict_marker_missing');
    });

    it('放宽后的默认阈值允许多一次判定重试', () => {
        const state = delegatedState();
        const bad = parseVerdict('我先看看情况');
        expect(decideNextAction(state, bad, { now: 2_000 }).type).toBe('dispatch');
        expect(decideNextAction(state, bad, { now: 3_000 }).type).toBe('dispatch');
        const third = decideNextAction(state, bad, { now: 4_000 });
        expect(third.type).toBe('wait_user');
        expect(third.reason).toBe('verdict_marker_missing');
    });

    it('treats a continue verdict without a next instruction as unreadable', () => {
        const state = delegatedState();
        state.limits = { ...state.limits, maxInvalidVerdicts: 2 };
        const verdict = parseVerdict(verdictLine({ status: 'continue' }));
        const first = decideNextAction(state, verdict, { now: 2_000 });
        expect(first.type).toBe('dispatch');
        expect(first.reason).toBe('next_instruction_missing_retry');
        const second = decideNextAction(state, verdict, { now: 3_000 });
        expect(second.type).toBe('wait_user');
    });
});

describe('loop reaches a final result instead of stopping after one turn', () => {
    it('runs worker -> judge -> worker -> judge until done', () => {
        const state = delegatedState();
        const script = [
            { status: 'continue', next: '补移动端快照测试' },
            { status: 'continue', next: '把 320px 下的横向溢出修掉' },
            { status: 'done', summary: '两条完成条件都满足' },
        ];
        const trace = [];
        for (let step = 0; step < script.length; step += 1) {
            const action = decideNextAction(state, parseVerdict(verdictLine(script[step])), {
                now: state.startedAt + (step + 1) * 1_000,
            });
            trace.push(action.type);
            if (action.type !== 'dispatch') {
                settleCommanderState(state, action);
                break;
            }
            noteDispatch(state, action, { now: state.startedAt + (step + 1) * 1_000 });
        }
        expect(trace).toEqual(['dispatch', 'dispatch', 'finish']);
        expect(state.status).toBe('done');
        expect(state.iteration).toBe(2);
    });

    it('stops at the cap even if the commander never says done', () => {
        const state = delegatedState();
        for (let i = 0; i < 10; i += 1) {
            const action = decideNextAction(state, parseVerdict(verdictLine({
                status: 'continue',
                next: `第 ${i} 步`,
            })), { now: state.startedAt + i * 1_000 });
            if (action.type !== 'dispatch') {
                settleCommanderState(state, action);
                expect(action.reason).toBe('max_iterations');
                break;
            }
            noteDispatch(state, action, { now: state.startedAt + i * 1_000 });
        }
        expect(state.iteration).toBe(state.limits.maxIterations);
    });
});

describe('prompts', () => {
    it('judge request carries goal, acceptance, evidence and the marker contract', () => {
        const text = buildJudgeRequest({
            goal: '把登录页改成手机可用',
            acceptance: ['无横向滚动', 'npm test 通过'],
            iteration: 2,
            mode: 'delegated',
            workerName: '执行甲',
            evidence: {
                lastAssistantText: '已改首屏',
                gitStatus: ' M src/Login.tsx',
                checks: [{ name: 'npm test', exitCode: 1, summary: '2 failed' }],
            },
        });
        expect(text).toContain('第 2 轮');
        expect(text).toContain('无横向滚动');
        expect(text).toContain('npm test');
        expect(text).toContain('exit=1');
        expect(text).toContain(COMMANDER_VERDICT_MARKER);
        expect(text).toContain('执行甲');
    });

    it('worker dispatch states the instruction and forbids plan-only replies', () => {
        const text = buildWorkerDispatch({ goal: 'g', acceptance: ['a'], instruction: '修 320px 溢出', iteration: 3 });
        expect(text).toContain('修 320px 溢出');
        expect(text).toContain('不要只给计划');
    });

    it('describes actions for the status chip', () => {
        const state = delegatedState();
        expect(describeAction({ type: 'dispatch', iteration: 2 }, state)).toContain('#2');
        expect(describeAction({ type: 'stop', reason: 'no_progress' }, state)).toContain('no_progress');
    });
});

describe('lastAssistantText', () => {
    it('picks the last non-empty assistant message', () => {
        const text = lastAssistantText({ messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: '第一版' },
            { role: 'assistant', content: [{ type: 'text', text: '最终版' }] },
            { role: 'assistant', content: '' },
        ] });
        expect(text).toBe('最终版');
    });

    it('returns empty string when there is no assistant text', () => {
        expect(lastAssistantText({ messages: [] })).toBe('');
        expect(lastAssistantText(null)).toBe('');
    });
});

describe('defaults', () => {
    it('keeps the loop bounded out of the box', () => {
        expect(COMMANDER_DEFAULT_LIMITS.maxIterations).toBeGreaterThan(0);
        // 长 CAD 任务单个 turn 就可能超过 45 分钟；预算仍须有界，但放宽到
        // 12 轮 / 4 小时，失控由 turnStallGuard 的无进展检测兜住。
        expect(COMMANDER_DEFAULT_LIMITS.maxIterations).toBeLessThanOrEqual(24);
        expect(COMMANDER_DEFAULT_LIMITS.maxWallClockMs).toBeLessThanOrEqual(8 * 60 * 60 * 1000);
    });
});
