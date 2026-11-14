import { describe, expect, it } from 'vitest';

import {
    NO_PROGRESS_STOP_REASON,
    STALL_FINISH_REASON,
    TURN_STALL_DEFAULTS,
    createTurnStallGuard,
    isNoProgressStopReason,
    isProgressTool,
    isStallFinishReason,
    readTurnStallConfig,
    thinkingFingerprint,
    toolFailureFingerprint,
} from './turnStallGuard.js';

const cfg = (over = {}) => ({
    enabled: true,
    maxRepeatedThinking: 3,
    maxRepeatedToolFailure: 4,
    maxTurnWallClockMs: 60_000,
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
            PILOTV_STALL_MAX_TURN_MS: '0',
            PILOTV_STALL_MAX_TURN_TOKENS: '999',
        });
        expect(configured.enabled).toBe(false);
        expect(configured.maxRepeatedThinking).toBe(7);
        expect(configured.maxTurnWallClockMs).toBe(Number.POSITIVE_INFINITY);
        expect(configured.maxTurnTokens).toBe(999);
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

    it('read_file 成功不算进展；edit_file 成功才重置', () => {
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

    it('可单独关闭时长与 token 上限', () => {
        let t = 0;
        const guard = createTurnStallGuard({
            config: cfg({ maxTurnWallClockMs: Number.POSITIVE_INFINITY, maxTurnTokens: Number.POSITIVE_INFINITY }),
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
