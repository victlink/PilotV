import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useSessionStore, type NormalizedMessage } from './useSessionStore';

vi.mock('../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => fetch(...args as Parameters<typeof fetch>),
  readAgentStatusErrorFromResponse: vi.fn(),
}));

const progress = (overrides: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: `subagent_progress_${Math.random().toString(36).slice(2, 8)}`,
  sessionId: 's',
  provider: 'pilotdeck',
  timestamp: new Date().toISOString(),
  kind: 'subagent_progress',
  subagentId: 'child',
  subagentType: 'explore',
  at: new Date().toISOString(),
  ...overrides,
});

it('merges consecutive child text deltas into one growing progress row', () => {
  const { result } = renderHook(useSessionStore);
  act(() => {
    result.current.appendSubagentProgress('s', progress({ phase: 'text', text: '先看目录' }));
    result.current.appendSubagentProgress('s', progress({ phase: 'text', text: '，再看入口文件。' }));
  });
  const rows = result.current.getMessages('s').filter((message) => message.isSubagentProgress);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ phase: 'text', content: '先看目录，再看入口文件。' });
});

it('freezes a finished block and starts a fresh row for the next one', () => {
  const { result } = renderHook(useSessionStore);
  act(() => {
    result.current.appendSubagentProgress('s', progress({ phase: 'text', text: '第一段' }));
    result.current.appendSubagentProgress('s', progress({ phase: 'text', text: '第一段正文', isSubagentProgressFinal: true }));
    result.current.appendSubagentProgress('s', progress({ phase: 'text', text: '第二段' }));
  });
  const rows = result.current.getMessages('s').filter((message) => message.isSubagentProgress);
  expect(rows.map((row) => row.content)).toEqual(['第一段正文', '第二段']);
});

it('keeps one row per tool call and rewrites it with the result', () => {
  const { result } = renderHook(useSessionStore);
  act(() => {
    result.current.appendSubagentProgress('s', progress({ phase: 'tool', toolId: 'call-1', toolName: 'Read', text: '正在调用 Read：src/app.ts' }));
    result.current.appendSubagentProgress('s', progress({ phase: 'tool', toolId: 'call-1', toolName: 'Read', text: 'Read 已返回：export const a = 1;' }));
    result.current.appendSubagentProgress('s', progress({ phase: 'tool', toolId: 'call-2', toolName: 'Grep', text: '正在调用 Grep：useSession' }));
  });
  const rows = result.current.getMessages('s').filter((message) => message.isSubagentProgress);
  expect(rows.map((row) => row.content)).toEqual([
    'Read 已返回：export const a = 1;',
    '正在调用 Grep：useSession',
  ]);
});
