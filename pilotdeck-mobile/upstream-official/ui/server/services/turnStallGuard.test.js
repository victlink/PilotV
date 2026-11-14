import { describe, expect, it } from 'vitest';

import {
    NO_PROGRESS_STOP_REASON,
    STALL_FINISH_REASON,
    TURN_STALL_DEFAULTS,
    createTurnStallGuard,
    isNoProgressStopReason,
    isProgressTool,
    isStallFinishReason,
    normalizeStallEvent,
    readTurnStallConfig,
    thinkingFingerprint,
    toolFailureFingerprint,
} from './turnStallGuard.js';

// 单测里用较紧的阈值方便触发；生产默认值见 TURN_STALL_DEFAULTS。
const cfg = (over = {}) => ({
    enabled: true,
    maxRepeatedThinking: 3,
    maxRepeatedToolFailure: 4,
    maxIdleMs: 30 * 60_000,
    maxTurnWallClockMs: 4 * 60 * 60_000,
    maxTurnTokens: 8_000_000,
    thinkingKeyChars: 120,
    ...over,
});

const thinking = (text, kind = 'thinking') => ({ type: 'assistant_block', kind, text });
const toolOk = (name = 'read_file') => ({ type: 'tool_call_finished', ok: true, toolName: name });
const toolFail = (name = 'edit_file', message = 'TOOL_ERROR[invalid_tool_input][edit_file] old_string not found at line 12') => ({
    type: 'tool_call_finished',
    ok: false,
    toolName: name,
    errorCode: 'invalid_tool_input',
    resultPreview: message,
});

describe('无进展检测的纯函数', () => {
    it('常量与判定函数一致', () => {
        expect(STALL_FINISH_REASON).toBe('stalled_no_progress');
        expect(isStallFinishReason(STALL_FINISH_REASON)).toBe(true);
        expect(isStallFinishReason('stalled_turn_timeout')).toBe(true);
        expect(isStallFinishReason('completed')).toBe(false);
        expect(isStallFinishReason('gateway_error')).toBe(false);
        expect(isStallFinishReason(null)).toBe(false);
        expect(isNoProgressStopReason(NO_PROGRESS_STOP_REASON)).toBe(true);
        expect(isNoProgressStopReason('verdict_marker_missing')).toBe(false);
    });

    it('thinking 指纹折叠空白、忽略大小写、只取前缀', () => {
        expect(thinkingFingerprint('  The memory\n says  read-only.  '))
            .toBe(thinkingFingerprint('the memory says read-only.'));
        expect(thinkingFingerprint('')).toBe('');
        expect(thinkingFingerprint('abcdef', 3)).toBe('abc');
        expect(thinkingFingerprint('The memory', 6)).not.toBe(thinkingFingerprint('The model', 6));
    });

    it('工具失败指纹抹掉易变的引号内容与数字', () => {
        const a = toolFailureFingerprint({ toolName: 'edit_file', errorCode: 'invalid_tool_input', message: 'old_string "COLLAR_Z0 = -9" not found at line 12' });
        const b = toolFailureFingerprint({ toolName: 'edit_file', errorCode: 'invalid_tool_input', message: 'old_string "COLLAR_Z0 = -7" not found at line 88' });
        expect(a).toBe(b);
        const c = toolFailureFingerprint({ toolName: 'read_file', errorCode: 'invalid_tool_input', message: 'old_string "x" not found at line 1' });
        expect(c).not.toBe(a);
    });

    it('只有会改动工作区的成功工具算进展', () => {
        expect(isProgressTool('edit_file')).toBe(true);
        expect(isProgressTool('write_file')).toBe(true);
        expect(isProgressTool('bash')).toBe(true);
        expect(isProgressTool('functions.edit_file')).toBe(true);
        expect(isProgressTool('read_file')).toBe(false);
        expect(isProgressTool('list_files')).toBe(false);
        expect(isProgressTool('')).toBe(false);
        expect(isProgressTool(undefined)).toBe(false);
    });

    it('读环境变量；显式 0 关闭单项；可整体关闭', () => {
        expect(readTurnStallConfig({})).toEqual(TURN_STALL_DEFAULTS);
        const configured = readTurnStallConfig({
            PILOTV_STALL_ENABLED: '0',
            PILOTV_STALL_MAX_REPEATED_THINKING: '7',
            PILOTV_STALL_MAX_IDLE_MS: '0',
            PILOTV_STALL_MAX_TURN_MS: '0',
            PILOTV_STALL_MAX_TURN_TOKENS: '999',
        });
        expect(configured.enabled).toBe(false);
        expect(configured.maxRepeatedThinking).toBe(7);
        expect(configured.maxIdleMs).toBe(Number.POSITIVE_INFINITY);
        expect(configured.maxTurnWallClockMs).toBe(Number.POSITIVE_INFINITY);
        expect(configured.maxTurnTokens).toBe(999);
        expect(readTurnStallConfig({ PILOTV_STALL_MAX_IDLE_MS: '600000' }).maxIdleMs).toBe(600000);
        expect(readTurnStallConfig({ PILOTV_STALL_ENABLED: 'false' }).enabled).toBe(false);
        expect(readTurnStallConfig({ PILOTV_STALL_MAX_REPEATED_THINKING: 'garbage' }).maxRepeatedThinking)
            .toBe(TURN_STALL_DEFAULTS.maxRepeatedThinking);
    });
});

describe('单 turn 熔断', () => {
    it('连续 3 次相同 thinking 前缀触发，且只触发一次', () => {
        const guard = createTurnStallGuard({ config: cfg() });
        expect(guard.observe(thinking('The memory confirms C18 is implemented. ...'))).toBeNull();
        expect(guard.observe(thinking('The memory confirms C18 is implemented. ...'))).toBeNull();
        const stall = guard.observe(thinking('The memory confirms C18 is implemented. ...'));
        expect(stall?.code).toBe('repeated_thinking');
        expect(stall?.detail.repeated).toBe(3);
        expect(guard.observe(thinking('The memory confirms C18 is implemented. ...'))).toBe(stall);
        expect(guard.stalled).toBe(stall);
    });

    it('thinking 前缀变化会重置计数', () => {
        const guard = createTurnStallGuard({ config: cfg() });
        expect(guard.observe(thinking('The memory confirms C18.'))).toBeNull();
        expect(guard.observe(thinking('The memory confirms C18.'))).toBeNull();
        expect(guard.observe(thinking('Now I have the exact cap geometry.'))).toBeNull();
        expect(guard.observe(thinking('The memory confirms C18.'))).toBeNull();
        expect(guard.stalled).toBeNull();
    });

    it('read_file 成功不算「写类进展」，不清空复读计数；edit_file 成功才重置', () => {
        const guard = createTurnStallGuard({ config: cfg() });
        guard.observe(thinking('same thinking'));
        guard.observe(toolOk('read_file'));
        guard.observe(thinking('same thinking'));
        expect(guard.stalled).toBeNull();
        guard.observe(thinking('same thinking'));
        expect(guard.stalled?.code).toBe('repeated_thinking');

        const withProgress = createTurnStallGuard({ config: cfg() });
        withProgress.observe(thinking('same thinking'));
        withProgress.observe(thinking('same thinking'));
        withProgress.observe(toolOk('edit_file'));
        withProgress.observe(thinking('same thinking'));
        withProgress.observe(thinking('same thinking'));
        expect(withProgress.stalled).toBeNull();
    });

    it('只有 thinking delta 没有 block 时，stream_end 也能结算', () => {
        const guard = createTurnStallGuard({ config: cfg() });
        for (let i = 0; i < 2; i += 1) {
            expect(guard.observe({ type: 'assistant_thinking_delta', text: 'memory says read-only ' })).toBeNull();
            expect(guard.observe({ type: 'assistant_stream_end' })).toBeNull();
        }
        guard.observe({ type: 'assistant_thinking_delta', text: 'memory says read-only ' });
        expect(guard.observe({ type: 'assistant_stream_end' })?.code).toBe('repeated_thinking');
    });

    it('assistant_block 已结算时 stream_end 不重复计数', () => {
        const guard = createTurnStallGuard({ config: cfg() });
        guard.observe(thinking('same'));
        guard.observe({ type: 'assistant_stream_end' });
        guard.observe(thinking('same'));
        expect(guard.stalled).toBeNull();
        guard.observe(thinking('same'));
        expect(guard.stalled?.code).toBe('repeated_thinking');
    });

    it('子 agent 复读独立计数', () => {
        const guard = createTurnStallGuard({ config: cfg() });
        for (let i = 0; i < 3; i += 1) {
            guard.observe({ type: 'subagent_thinking_delta', text: 'The memory says read-only, no FreeCAD. ' });
            guard.observe({ type: 'subagent_stream_end' });
        }
        expect(guard.stalled?.code).toBe('repeated_subagent_thinking');
    });

    it('重复工具失败：错误文本里的 old_string / 行号变化仍能识别', () => {
        const guard = createTurnStallGuard({ config: cfg() });
        for (let i = 0; i < 3; i += 1) {
            expect(guard.observe(toolFail('edit_file', `old_string "value ${i}" not found at line ${10 + i}`))).toBeNull();
        }
        expect(guard.observe(toolFail('edit_file', 'old_string "value 3" not found at line 13'))?.code)
            .toBe('repeated_tool_failure');
        expect(guard.stalled?.detail.repeated).toBe(4);
    });

    it('成功的写工具清空重复失败计数', () => {
        const guard = createTurnStallGuard({ config: cfg() });
        guard.observe(toolFail());
        guard.observe(toolFail());
        guard.observe(toolFail());
        guard.observe(toolOk('write_file'));
        guard.observe(toolFail());
        guard.observe(toolFail());
        guard.observe(toolFail());
        expect(guard.stalled).toBeNull();
    });

    it('单 turn token 超限触发', () => {
        const guard = createTurnStallGuard({ config: cfg({ maxTurnTokens: 1000 }) });
        expect(guard.observe({ type: 'turn_completed', usage: { totalTokens: 999 } })).toBeNull();
        const stall = guard.observe({ type: 'turn_completed', usage: { totalTokens: 1001 } });
        expect(stall?.code).toBe('turn_token_budget');
        expect(stall?.totalTokens).toBe(1001);
    });

    it('单 turn 墙钟超限触发', () => {
        let t = 0;
        const guard = createTurnStallGuard({ config: cfg({ maxTurnWallClockMs: 1000 }), now: () => t });
        expect(guard.observe(thinking('one'))).toBeNull();
        t = 1001;
        const stall = guard.observe({ type: 'context_budget' });
        expect(stall?.code).toBe('turn_timeout');
        expect(stall?.elapsedMs).toBe(1001);
    });

    it('总开关关闭时任何事件都不触发', () => {
        const guard = createTurnStallGuard({ config: cfg({ enabled: false }) });
        for (let i = 0; i < 5; i += 1) guard.observe(thinking('same'));
        expect(guard.stalled).toBeNull();
        expect(guard.snapshot().enabled).toBe(false);
    });

    it('可单独关闭时长、静默与 token 上限', () => {
        let t = 0;
        const guard = createTurnStallGuard({
            config: cfg({
                maxIdleMs: Number.POSITIVE_INFINITY,
                maxTurnWallClockMs: Number.POSITIVE_INFINITY,
                maxTurnTokens: Number.POSITIVE_INFINITY,
            }),
            now: () => t,
        });
        t = 10_000_000;
        expect(guard.observe({ type: 'context_budget' })).toBeNull();
        expect(guard.observe({ type: 'turn_completed', usage: { totalTokens: 99_999_999 } })).toBeNull();
        expect(guard.stalled).toBeNull();
    });

    it('snapshot 暴露计数与终态，便于日志排查', () => {
        const guard = createTurnStallGuard({ config: cfg() });
        guard.observe(thinking('a'));
        const snap = guard.snapshot();
        expect(snap.repeatedThinking).toBe(1);
        expect(snap.repeatedFailure).toBe(0);
        expect(snap.totalTokens).toBe(0);
        expect(snap.turnCompleted).toBe(false);
        expect(snap.stalled).toBeNull();
        guard.observe({ type: 'turn_completed', usage: { totalTokens: 42 } });
        expect(guard.snapshot().turnCompleted).toBe(true);
        expect(guard.snapshot().totalTokens).toBe(42);
    });
});

describe('进展感知：正常长任务不误杀（2026-11-14 回归）', () => {
    it('生产默认阈值已放宽：复读 5 次、静默 30 分钟、绝对兜底 4 小时', () => {
        expect(TURN_STALL_DEFAULTS.maxRepeatedThinking).toBe(5);
        expect(TURN_STALL_DEFAULTS.maxIdleMs).toBe(30 * 60_000);
        expect(TURN_STALL_DEFAULTS.maxTurnWallClockMs).toBe(4 * 60 * 60_000);
        const guard = createTurnStallGuard({});
        for (let i = 0; i < 4; i += 1) expect(guard.observe(thinking('same'))).toBeNull();
        expect(guard.observe(thinking('same'))?.code).toBe('repeated_thinking');
    });

    it('持续有成功工具的长 turn 跨过 45 分钟也不会被砍', () => {
        let t = 0;
        const guard = createTurnStallGuard({
            config: cfg({ maxIdleMs: 30 * 60_000, maxTurnWallClockMs: 8 * 60 * 60_000 }),
            now: () => t,
        });
        for (let i = 1; i <= 8; i += 1) {
            t = i * 10 * 60_000;
            expect(guard.observe({ type: 'tool_call_started', name: 'bash' })).toBeNull();
            t += 60_000;
            expect(guard.observe({ type: 'tool_call_finished', ok: true, toolName: 'bash' })).toBeNull();
        }
        expect(guard.snapshot().elapsedMs).toBe(8 * 10 * 60_000 + 60_000);
        expect(guard.stalled).toBeNull();
    });

    it('工具在飞期间不按静默计时（FreeCAD / task_wait 长跑不误杀）', () => {
        let t = 0;
        const guard = createTurnStallGuard({
            config: cfg({ maxIdleMs: 30 * 60_000, maxTurnWallClockMs: 4 * 60 * 60_000 }),
            now: () => t,
        });
        guard.observe({ type: 'tool_call_started', name: 'task_wait' });
        t = 90 * 60_000;
        expect(guard.observe({ type: 'context_budget' })).toBeNull();
        expect(guard.snapshot().inFlightTools).toBe(1);
        guard.observe({ type: 'tool_call_finished', ok: true, toolName: 'task_wait' });
        expect(guard.snapshot().inFlightTools).toBe(0);
        expect(guard.stalled).toBeNull();
    });

    it('超过 30 分钟没有任何进展才判 turn_idle', () => {
        let t = 0;
        const guard = createTurnStallGuard({
            config: cfg({ maxIdleMs: 30 * 60_000, maxTurnWallClockMs: 4 * 60 * 60_000 }),
            now: () => t,
        });
        guard.observe({ type: 'tool_call_finished', ok: true, toolName: 'edit_file' });
        t = 29 * 60_000;
        expect(guard.observe({ type: 'context_budget' })).toBeNull();
        t = 31 * 60_000;
        const stall = guard.observe({ type: 'assistant_thinking_delta', text: 'still thinking' });
        expect(stall?.code).toBe('turn_idle');
        expect(stall?.detail.idleMs).toBe(31 * 60_000);
    });

    it('纯复读死循环仍会被抓（没有工具产出，静默超限）', () => {
        let t = 0;
        const guard = createTurnStallGuard({
            config: cfg({ maxIdleMs: 30 * 60_000, maxRepeatedThinking: 999, maxTurnWallClockMs: 4 * 60 * 60_000 }),
            now: () => t,
        });
        for (let i = 1; i <= 6; i += 1) {
            t = i * 6 * 60_000;
            guard.observe(thinking('The memory says read-only, no FreeCAD. '));
        }
        expect(guard.stalled?.code).toBe('turn_idle');
    });

    it('子 agent 工具结果与文件产物都算有效进展', () => {
        let t = 0;
        const guard = createTurnStallGuard({
            config: cfg({ maxIdleMs: 30 * 60_000, maxTurnWallClockMs: 8 * 60 * 60_000 }),
            now: () => t,
        });
        for (let i = 1; i <= 4; i += 1) {
            t = i * 25 * 60_000;
            const event = i % 2
                ? { type: 'subagent_tool_result', toolName: 'edit_file' }
                : { type: 'file_artifacts', artifacts: [] };
            expect(guard.observe(event)).toBeNull();
        }
        expect(guard.stalled).toBeNull();
        expect(guard.snapshot().lastProgressAtMs).toBe(100 * 60_000);
    });

    it('工具失败不算进展；连续相同失败仍按原逻辑抓死循环', () => {
        let t = 0;
        const guard = createTurnStallGuard({
            config: cfg({ maxIdleMs: 30 * 60_000 }),
            now: () => t,
        });
        for (let i = 0; i < 3; i += 1) {
            t += 60_000;
            expect(guard.observe(toolFail('edit_file', `old_string "v${i}" not found at line ${10 + i}`))).toBeNull();
        }
        t += 60_000;
        expect(guard.observe(toolFail('edit_file', 'old_string "v3" not found at line 13'))?.code)
            .toBe('repeated_tool_failure');
    });

    it('context_budget 只记录上下文用量，不误触发 token 上限', () => {
        const guard = createTurnStallGuard({ config: cfg() });
        expect(guard.observe({ type: 'context_budget', used: 9_999_999 })).toBeNull();
        expect(guard.snapshot().observedContextUsed).toBe(9_999_999);
        expect(guard.stalled).toBeNull();
    });

    it('snapshot 暴露静默与在飞工具，便于线上排查误杀', () => {
        let t = 0;
        const guard = createTurnStallGuard({ config: cfg(), now: () => t });
        guard.observe({ type: 'tool_call_finished', ok: true, toolName: 'write_file' });
        t = 5 * 60_000;
        expect(guard.snapshot().idleMs).toBe(5 * 60_000);
        expect(guard.snapshot().inFlightTools).toBe(0);
        expect(guard.snapshot().lastProgressAtMs).toBe(0);
    });
});

/**
 * 回归：网关协议里子 agent 事件不是顶层 type，而是
 *   { type: 'agent_status', event: 'subagent_*', detail: {...} }
 * 初版护栏按顶层 type 写 case，这些分支在生产里全是死代码，导致长 CAD turn
 * （主要靠子 agent 干活）被 turn_idle 误杀。下面全部用真实包装格式构造事件。
 */
const wrapped = (event, detail = {}) => ({ type: 'agent_status', event, detail });
const subagentThinking = (text) => wrapped('subagent_thinking_delta', {
    subagentId: 'sa-1', subagentType: 'agent', text,
});
const subagentStreamEnd = () => wrapped('subagent_stream_end', { subagentId: 'sa-1', subagentType: 'agent' });
const subagentToolCall = (id, name) => wrapped('subagent_tool_call_started', {
    subagentId: 'sa-1', subagentType: 'agent', toolCallId: id, toolName: name, input: { path: 'x' },
});
const subagentToolOk = (id, name = 'edit_file') => wrapped('subagent_tool_result', {
    subagentId: 'sa-1', subagentType: 'agent', toolCallId: id, toolName: name,
    ok: true, content: 'done', preview: 'done',
});
const subagentToolFail = (id) => wrapped('subagent_tool_result', {
    subagentId: 'sa-1', subagentType: 'agent', toolCallId: id, toolName: 'edit_file',
    ok: false, errorCode: 'invalid_tool_input', content: 'old_string "v" not found at line 12',
});

describe('子 agent 事件包装（agent_status）：三次修正回归', () => {
    it('normalizeStallEvent 把 agent_status 摊平成内部事件并统一字段别名', () => {
        const normalized = normalizeStallEvent(subagentToolOk('t1', 'write_file'));
        expect(normalized.type).toBe('subagent_tool_result');
        expect(normalized.subagentId).toBe('sa-1');
        expect(normalized.toolCallId).toBe('t1');
        expect(normalized.toolName).toBe('write_file');
        expect(normalized.ok).toBe(true);
        // 顶层事件原样返回，保持兼容。
        const plain = { type: 'tool_call_finished', ok: true };
        expect(normalizeStallEvent(plain)).toBe(plain);
    });

    it('非子 agent 的 agent_status 被忽略；缺 detail 与非法输入不崩', () => {
        expect(normalizeStallEvent(wrapped('compact_started', { stage: 'compacting' }))).toBeNull();
        expect(normalizeStallEvent({ type: 'agent_status' })).toBeNull();
        expect(normalizeStallEvent(null)).toBeNull();
        expect(normalizeStallEvent(wrapped('subagent_completed', { subagentId: 'sa-1' })).subagentId).toBe('sa-1');
        const guard = createTurnStallGuard({ config: cfg() });
        expect(guard.observe(wrapped('compact_started'))).toBeNull();
        expect(guard.observe(wrapped('file_input_progress'))).toBeNull();
        expect(guard.stalled).toBeNull();
    });

    it('真实包装格式的子 agent 复读能触发 repeated_subagent_thinking', () => {
        const guard = createTurnStallGuard({ config: cfg() });
        for (let i = 0; i < 3; i += 1) {
            guard.observe(subagentThinking('The memory says read-only, no FreeCAD. '));
            guard.observe(subagentStreamEnd());
        }
        expect(guard.stalled?.code).toBe('repeated_subagent_thinking');
        expect(guard.snapshot().subagentEventsSeen).toBeGreaterThan(0);
    });

    it('真实包装格式的子 agent 工具结果刷新进展心跳，长 turn 不再被 idle 误杀', () => {
        let t = 0;
        const guard = createTurnStallGuard({
            config: cfg({ maxIdleMs: 30 * 60_000, maxTurnWallClockMs: 8 * 60 * 60_000 }),
            now: () => t,
        });
        for (let i = 1; i <= 8; i += 1) {
            t = i * 10 * 60_000;
            expect(guard.observe(subagentToolCall(`t${i}`, 'edit_file'))).toBeNull();
            t += 60_000;
            expect(guard.observe(subagentToolOk(`t${i}`))).toBeNull();
        }
        expect(guard.stalled).toBeNull();
        expect(guard.snapshot().subagentToolResults).toBe(8);
        expect(guard.snapshot().lastProgressAtMs).toBe(8 * 10 * 60_000 + 60_000);
        expect(guard.snapshot().inFlightSubagentTools).toBe(0);
    });

    it('子 agent 工具在飞期间不按静默计时；completed 清掉残留计数', () => {
        let t = 0;
        const guard = createTurnStallGuard({
            config: cfg({ maxIdleMs: 30 * 60_000, maxTurnWallClockMs: 4 * 60 * 60_000 }),
            now: () => t,
        });
        guard.observe(subagentToolCall('long-freecad', 'run_freecad'));
        expect(guard.snapshot().inFlightSubagentTools).toBe(1);
        t = 90 * 60_000;
        expect(guard.observe({ type: 'context_budget' })).toBeNull();
        expect(guard.stalled).toBeNull();
        // 子 agent 收尾会清掉它残留的在飞工具，避免计数永久挂住掩盖死循环。
        guard.observe(wrapped('subagent_completed', { subagentId: 'sa-1', success: true }));
        expect(guard.snapshot().inFlightSubagentTools).toBe(0);
    });

    it('子 agent 工具失败走同一套重复失败检测（不能被子 agent 洗白）', () => {
        const guard = createTurnStallGuard({ config: cfg() });
        for (let i = 0; i < 3; i += 1) expect(guard.observe(subagentToolFail(`f${i}`))).toBeNull();
        const stall = guard.observe(subagentToolFail('f3'));
        expect(stall?.code).toBe('repeated_tool_failure');
        expect(stall?.detail.scope).toBe('subagent');
    });

    it('子 agent 成功的写工具清空复读计数；只读工具不清', () => {
        const readOnly = wrapped('subagent_tool_result', {
            subagentId: 'sa-1', toolCallId: 'r1', toolName: 'read_file', ok: true,
        });
        const guardRead = createTurnStallGuard({ config: cfg() });
        guardRead.observe(thinking('same'));
        guardRead.observe(thinking('same'));
        guardRead.observe(readOnly);
        expect(guardRead.observe(thinking('same'))?.code).toBe('repeated_thinking');

        const guardWrite = createTurnStallGuard({ config: cfg() });
        guardWrite.observe(thinking('same'));
        guardWrite.observe(thinking('same'));
        guardWrite.observe(subagentToolOk('w1', 'write_file'));
        expect(guardWrite.observe(thinking('same'))).toBeNull();
    });

    it('迟到的进展事件不被上一次静默误杀', () => {
        let t = 0;
        const guard = createTurnStallGuard({
            config: cfg({ maxIdleMs: 30 * 60_000, maxTurnWallClockMs: 4 * 60 * 60_000 }),
            now: () => t,
        });
        guard.observe(toolOk('edit_file'));
        t = 61 * 60_000;
        // 事件稀疏但确实在干活：本身是进展事件，先刷新心跳再判静默。
        expect(guard.observe(subagentToolOk('late-1'))).toBeNull();
        expect(guard.stalled).toBeNull();
        expect(guard.snapshot().lastProgressAtMs).toBe(61 * 60_000);
        // 而纯 thinking 在同样长的静默后仍会被抓（用独立时钟，避免复用上面已推进的 t）。
        let t2 = 0;
        const idleGuard = createTurnStallGuard({
            config: cfg({ maxIdleMs: 30 * 60_000, maxTurnWallClockMs: 4 * 60 * 60_000 }),
            now: () => t2,
        });
        idleGuard.observe(toolOk('edit_file'));
        t2 = 61 * 60_000;
        expect(idleGuard.observe(thinking('still stuck'))?.code).toBe('turn_idle');
    });

    it('顶层 subagent_* 事件仍兼容（旧调用方 / 测试不受影响）', () => {
        const guard = createTurnStallGuard({ config: cfg() });
        guard.observe({ type: 'subagent_thinking_delta', text: 'repeat' });
        guard.observe({ type: 'subagent_stream_end' });
        expect(guard.observe({ type: 'subagent_thinking_delta', text: 'repeat' })).toBeNull();
        expect(guard.observe({ type: 'subagent_stream_end' })).toBeNull();
        expect(guard.observe({ type: 'subagent_thinking_delta', text: 'repeat' })).toBeNull();
        expect(guard.observe({ type: 'subagent_stream_end' })?.code).toBe('repeated_subagent_thinking');
    });
});
