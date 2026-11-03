import { describe, expect, it } from 'vitest';

import { attachProjectAgentToFrame } from './pilotdeck-bridge.js';
import {
    getProjectAgentRun,
    normalizeProjectAgentRuns,
    recordProjectAgentRun,
} from './services/projectTeamRuns.js';

const runtime = { agentId: 'agent-1', agent: { name: '小林', role: 'engineer' } };

describe('project team speaker labels', () => {
    it('names the member behind an assistant reply', () => {
        const frame = attachProjectAgentToFrame(
            { kind: 'text', role: 'assistant', content: '好的' },
            runtime,
        );
        expect(frame.agentName).toBe('小林');
        expect(frame.agentRole).toBe('engineer');
    });

    it('names streaming deltas so the finished reply keeps the speaker', () => {
        const frame = attachProjectAgentToFrame(
            { kind: 'stream_delta', content: '好' },
            runtime,
        );
        expect(frame.agentName).toBe('小林');
    });

    it('leaves the default agent unnamed', () => {
        const original = { kind: 'text', role: 'assistant', content: '好的' };
        expect(attachProjectAgentToFrame(original, null)).toBe(original);
        expect(attachProjectAgentToFrame(original, { agentId: undefined, agent: undefined })).toBe(original);
    });

    it('never labels user frames', () => {
        const original = { kind: 'text', role: 'user', content: '在吗' };
        expect(attachProjectAgentToFrame(original, runtime)).toBe(original);
    });

    it('remembers who replied for a turn', () => {
        const state = { projectAgentRuns: {} };
        recordProjectAgentRun(state, runtime, 'turn-1');
        expect(getProjectAgentRun(state.projectAgentRuns, 'turn-1')).toEqual({
            agentId: 'agent-1',
            name: '小林',
            role: 'engineer',
        });
        // 另一个 turn 是默认 Agent 在回：查不到发言人。
        expect(getProjectAgentRun(state.projectAgentRuns, 'turn-2')).toBeNull();
    });

    it('restores the turn speakers from the sidecar payload', () => {
        const runs = normalizeProjectAgentRuns({
            'turn-1': { agentId: 'agent-1', name: '小林', role: 'engineer' },
            'turn-2': { agentId: 'agent-2', name: '小周', role: 'designer' },
        });
        expect(getProjectAgentRun(runs, 'turn-2')?.name).toBe('小周');
        expect(getProjectAgentRun(runs, 'turn-3')).toBeNull();
    });
});
