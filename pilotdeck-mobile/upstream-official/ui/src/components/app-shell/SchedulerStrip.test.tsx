// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SchedulerStrip, { formatBytes } from './SchedulerStrip';
import { schedulerQueuePosition, type SchedulerTask } from './useResourceScheduler';
import sidebarZh from '../../i18n/locales/zh-CN/sidebar.json';

/**
 * 用**真实的** zh-CN 词条渲染，而不是把 t() 打桩成返回 key。
 * 这样测试能真正验证「词条存在且拼写正确」——
 * 少一个 key 时界面会露出 `sidebar:scheduler.pressure.high` 这种原文。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const path = key.replace(/^sidebar:/, '').split('.');
      let node: unknown = sidebarZh;
      for (const segment of path) {
        node = (node as Record<string, unknown> | undefined)?.[segment];
      }
      if (typeof node !== 'string') return key;
      return node.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''));
    },
  }),
}));

const tasksResponse = vi.fn();
const resumeResponse = vi.fn();

vi.mock('../../utils/api', () => ({
  api: {
    resourceScheduler: {
      tasks: () => tasksResponse(),
      resumeTask: (...args: unknown[]) => resumeResponse(...args),
    },
  },
}));

vi.mock('../../contexts/WebSocketContext', () => ({
  useOptionalWebSocket: () => ({ subscribe: () => () => {} }),
}));

const GB = 1024 ** 3;

function makeTask(overrides: Partial<SchedulerTask> = {}): SchedulerTask {
  return {
    id: 'task-a',
    sessionKey: 'web-s_a',
    projectPath: null,
    goal: '咖啡机设计',
    priority: 0,
    status: 'running',
    enqueuedAt: 1_000,
    startedAt: 2_000,
    lastProgressAt: 3_000,
    progressCount: 4,
    attempts: 1,
    pauseCount: 0,
    pauseReason: null,
    pauseHint: null,
    resumeAt: null,
    stopReason: null,
    ...overrides,
  };
}

function respondWith(payload: unknown) {
  tasksResponse.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
  });
}

const RESOURCES = {
  timestamp: 1_700_000_000_000,
  cpuPercent: 35,
  cpuCores: 16,
  memTotalBytes: 16 * GB,
  memFreeBytes: 2.3 * GB,
  vram: { totalBytes: 4 * GB, usedBytes: 0.5 * GB },
  headroom: {
    cpu: 0.65,
    cpuIdleCores: 10.4,
    memory: 0.14,
    memoryAboveFloor: 0.01,
    vram: 0.87,
    overall: 0.01,
    pressure: 'elevated',
    saturated: false,
  },
};

beforeEach(() => {
  tasksResponse.mockReset();
  resumeResponse.mockReset();
  resumeResponse.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
});

afterEach(() => {
  cleanup();
});

describe('SchedulerStrip', () => {
  it('显示资源占用与压力分级', async () => {
    respondWith({ enabled: true, counts: { total: 0, running: 0, queued: 0, paused: 0 }, tasks: [], resources: RESOURCES });
    render(<SchedulerStrip />);

    await waitFor(() => expect(screen.getByTestId('scheduler-strip')).toBeTruthy());
    expect(screen.getByTestId('scheduler-resource-CPU')).toBeTruthy();
    expect(screen.getByTestId('scheduler-resource-内存')).toBeTruthy();
    expect(screen.getByTestId('scheduler-resource-显存')).toBeTruthy();
    // 压力分级如实显示为「偏高」，而不是笼统的「正常」。
    expect(screen.getByTestId('scheduler-pressure').textContent).toContain('偏高');
  });

  it('显存读不到时不显示假的 0，而是标为不可用', async () => {
    respondWith({
      enabled: true,
      counts: { total: 0, running: 0, queued: 0, paused: 0 },
      tasks: [],
      resources: { ...RESOURCES, vram: null },
    });
    render(<SchedulerStrip />);

    await waitFor(() => expect(screen.getByTestId('scheduler-strip')).toBeTruthy());
    expect(screen.queryByTestId('scheduler-resource-显存')).toBeNull();
    expect(screen.getByText('不可用')).toBeTruthy();
  });

  it('列出执行中、排队中与已暂停的任务', async () => {
    respondWith({
      enabled: true,
      counts: { total: 3, running: 1, queued: 1, paused: 1 },
      tasks: [
        makeTask({ id: 'run', status: 'running', goal: '车顶行李架' }),
        makeTask({ id: 'queue', status: 'queued', goal: '新风机设计', enqueuedAt: 5_000 }),
        makeTask({
          id: 'pause',
          status: 'paused',
          goal: '咖啡机设计',
          pauseReason: 'repeated_thinking',
          resumeAt: Date.now() + 30_000,
        }),
      ],
      resources: RESOURCES,
    });
    render(<SchedulerStrip />);

    await waitFor(() => expect(screen.getByTestId('scheduler-task-running')).toBeTruthy());
    expect(screen.getByTestId('scheduler-task-queued')).toBeTruthy();
    expect(screen.getByTestId('scheduler-task-paused')).toBeTruthy();
    expect(screen.getByText('车顶行李架')).toBeTruthy();
    // 暂停的任务要显示原因，否则用户只看到「不动了」却不知道为什么。
    expect(screen.getByText(/repeated_thinking/)).toBeTruthy();
  });

  it('队列为空时只显示资源条，不显示空列表', async () => {
    respondWith({ enabled: true, counts: { total: 0, running: 0, queued: 0, paused: 0 }, tasks: [], resources: RESOURCES });
    render(<SchedulerStrip />);

    await waitFor(() => expect(screen.getByTestId('scheduler-strip')).toBeTruthy());
    expect(screen.queryByTestId('scheduler-task-running')).toBeNull();
    expect(screen.queryByTestId('scheduler-task-queued')).toBeNull();
  });

  it('调度器无响应时保留上一次读数并标出「无响应」', async () => {
    tasksResponse.mockRejectedValue(new Error('offline'));
    render(<SchedulerStrip />);

    await waitFor(() => expect(screen.getByText(/无响应/)).toBeTruthy());
  });

  it('立即恢复被拒时显示服务端给的原因，而不是只报 HTTP 409', async () => {
    respondWith({
      enabled: true,
      counts: { total: 1, running: 0, queued: 0, paused: 1 },
      tasks: [
        makeTask({
          id: 'pause',
          status: 'paused',
          goal: '便携咖啡机',
          pauseReason: 'repeated_thinking',
          resumeAt: Date.now() + 60_000,
        }),
      ],
      resources: RESOURCES,
    });
    resumeResponse.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'resources do not allow admission yet' }),
    });

    render(<SchedulerStrip />);
    const button = await screen.findByText('立即恢复');
    button.click();

    await waitFor(() =>
      expect(screen.getByTestId('scheduler-resume-error').textContent)
        .toContain('resources do not allow admission yet'),
    );
  });
});

describe('formatBytes', () => {
  it('0 字节显示为 0 MB，而不是破折号', () => {
    // 显存刚开机占用就是 0；显示「–」会让人误以为读不到。
    expect(formatBytes(0)).toBe('0 MB');
  });

  it('读不到时显示破折号', () => {
    expect(formatBytes(undefined)).toBe('–');
    expect(formatBytes(null)).toBe('–');
    expect(formatBytes(Number.NaN)).toBe('–');
    expect(formatBytes(-1)).toBe('–');
  });

  it('按量级选 GB / MB', () => {
    expect(formatBytes(4 * GB)).toBe('4.0 GB');
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB');
  });
});

describe('schedulerQueuePosition', () => {
  it('按优先级再按入队时间给出排队位置', () => {
    const tasks = [
      makeTask({ id: 'low', status: 'queued', priority: 0, enqueuedAt: 1 }),
      makeTask({ id: 'high', status: 'queued', priority: 10, enqueuedAt: 2 }),
      makeTask({ id: 'mid', status: 'queued', priority: 5, enqueuedAt: 3 }),
    ];
    expect(schedulerQueuePosition(tasks[1], tasks)).toBe(0);
    expect(schedulerQueuePosition(tasks[2], tasks)).toBe(1);
    expect(schedulerQueuePosition(tasks[0], tasks)).toBe(2);
  });

  it('运行中的任务不占排队位置', () => {
    const tasks = [
      makeTask({ id: 'running', status: 'running' }),
      makeTask({ id: 'queued', status: 'queued', enqueuedAt: 2 }),
    ];
    expect(schedulerQueuePosition(tasks[1], tasks)).toBe(0);
  });
});
