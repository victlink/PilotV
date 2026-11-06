/**
 * 项目团队数据契约的前端回归测试。
 *
 * 后端契约（`ui/server/services/projectTeamConfig.js`）：
 *   - 白名单与黑名单**分别**限制 200 条（`validateToolEntries` 对每个列表单独判断）。
 *   - `version` 只接受 1。
 *
 * 这些用例锁住前端与后端的一致性，避免前端比后端更严格（保存被白白拒绝）
 * 或者比后端更宽松（发出必然 400 的请求）。
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import * as projectTeamModule from './projectTeam';
import {
    DEFAULT_PROJECT_AGENT_PERMISSIONS,
    PROJECT_TEAM_MAX_TOOL_ENTRIES,
    createProjectTeamAgent,
    normalizeProjectTeamConfig,
    validateProjectTeamDraft,
    type ProjectTeamAgent,
    type ProjectTeamConfig,
} from './projectTeam';

function toolEntries(count: number, prefix = 'tool'): string[] {
    return Array.from({ length: count }, (_, index) => `${prefix}_${index}`);
}

function agentWithToolLists(allowedTools: string[], deniedTools: string[]): ProjectTeamAgent {
    return createProjectTeamAgent('executor', {
        id: 'agent-1',
        name: 'Executor',
        permissions: {
            ...DEFAULT_PROJECT_AGENT_PERMISSIONS,
            toolAccess: 'allow-list',
            allowedTools,
            deniedTools,
        },
    });
}

describe('project team tool entry limits', () => {
    it('accepts the backend limit of 200 entries in each tool list', () => {
        const agent = agentWithToolLists(
            toolEntries(PROJECT_TEAM_MAX_TOOL_ENTRIES),
            toolEntries(PROJECT_TEAM_MAX_TOOL_ENTRIES, 'denied'),
        );

        // 后端对白名单与黑名单分别限制 200 条，两个列表都写满也必须能保存。
        expect(validateProjectTeamDraft([agent])).toEqual({ ok: true });
    });

    it('rejects an allow list that is longer than the per-list limit', () => {
        const agent = agentWithToolLists(
            toolEntries(PROJECT_TEAM_MAX_TOOL_ENTRIES + 1),
            [],
        );

        const result = validateProjectTeamDraft([agent]);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.issue.kind).toBe('tooManyToolEntries');
        if (result.issue.kind !== 'tooManyToolEntries') return;
        expect(result.issue.max).toBe(PROJECT_TEAM_MAX_TOOL_ENTRIES);
        expect(result.issue.list).toBe('allowedTools');
    });

    it('rejects a deny list that is longer than the per-list limit', () => {
        const agent = agentWithToolLists(
            [],
            toolEntries(PROJECT_TEAM_MAX_TOOL_ENTRIES + 1, 'denied'),
        );

        const result = validateProjectTeamDraft([agent]);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.issue.kind).toBe('tooManyToolEntries');
        if (result.issue.kind !== 'tooManyToolEntries') return;
        expect(result.issue.max).toBe(PROJECT_TEAM_MAX_TOOL_ENTRIES);
        expect(result.issue.list).toBe('deniedTools');
    });

    it('does not export a divergent frontend tool policy derivation', () => {
        // 运行期的策略解释权在 gateway（`toolPolicyToRuleSet`）：allow 是独占白名单，
        // allow: [] 表示"禁止所有工具"。前端那份派生逻辑（allow-list 之外返回空
        // allow）语义相反，而且没有任何调用方，必须删掉以免被误用。
        expect(Object.keys(projectTeamModule)).not.toContain('resolveAgentToolPolicy');
    });
});

describe('project team config version', () => {
    it('always speaks the version the backend accepts', () => {
        expect(normalizeProjectTeamConfig({ version: 2 }).version).toBe(1);
        expect(normalizeProjectTeamConfig({}).version).toBe(1);
        expect(normalizeProjectTeamConfig({ version: 1 }).version).toBe(1);
    });

    it('types the config version as the literal backend version', () => {
        expectTypeOf<ProjectTeamConfig['version']>().toEqualTypeOf<1>();
    });
});
