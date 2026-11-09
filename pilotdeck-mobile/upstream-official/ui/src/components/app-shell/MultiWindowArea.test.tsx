// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MultiWindowArea from './MultiWindowArea';

const BACKEND = 'http://127.0.0.1:3001';

function renderWorkspace() {
  return render(<MultiWindowArea projects={[]} selectedProject={null} selectedSession={null} onBack={vi.fn()} />);
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  (window as unknown as { __PILOTV__: unknown }).__PILOTV__ = { backend: BACKEND };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { __PILOTV__?: unknown }).__PILOTV__;
});

describe('多窗口工作区', () => {
  it('默认 2 窗，iframe 带设备标记与 embed 开关，视图交给窗格内悬浮按钮', () => {
    const view = renderWorkspace();
    const frames = Array.from(view.container.querySelectorAll('iframe'));
    expect(frames).toHaveLength(2);
    expect(frames[0].getAttribute('src')).toContain('embed=1');
    expect(frames[0].getAttribute('src')).toContain(`d=${encodeURIComponent(BACKEND)}`);
    expect(frames[0].getAttribute('src')).not.toContain('view=');
    expect(screen.queryByRole('combobox', { name: '窗口 1 内容' })).toBeNull();
    expect(view.container.textContent).toContain('用每个窗口右侧的悬浮按钮切换对话 / 文件 / 成果台');
  });

  it('可以在 2 / 4 / 6 之间切换', () => {
    const view = renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: '4 窗口布局' }));
    expect(view.container.querySelectorAll('iframe')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: '6 窗口布局' }));
    expect(view.container.querySelectorAll('iframe')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: '2 窗口布局' }));
    expect(view.container.querySelectorAll('iframe')).toHaveLength(2);
  });

  it('布局会记住，重新挂载后仍然生效', () => {
    const first = renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: '6 窗口布局' }));
    first.unmount();
    const second = renderWorkspace();
    expect(second.container.querySelectorAll('iframe')).toHaveLength(6);
  });

  it('放大单格后可还原', () => {
    const view = renderWorkspace();
    fireEvent.click(screen.getAllByRole('button', { name: '放大此窗口' })[0]);
    expect(view.container.querySelectorAll('iframe')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '取消放大' }));
    expect(view.container.querySelectorAll('iframe')).toHaveLength(2);
  });

  it('弹出为独立窗口时去掉 embed，保留设备标记', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderWorkspace();
    fireEvent.click(screen.getAllByRole('button', { name: '弹出为独立窗口' })[0]);
    expect(open).toHaveBeenCalledTimes(1);
    const url = String(open.mock.calls[0][0]);
    expect(url).toContain(`d=${encodeURIComponent(BACKEND)}`);
    expect(url).not.toContain('embed=1');
    expect(open.mock.calls[0][2]).toContain('noopener');
    open.mockRestore();
  });

  it('每个窗格可以按需展开该设备自己的侧栏', () => {
    const view = renderWorkspace();
    expect(view.container.querySelector('iframe')?.getAttribute('src')).not.toContain('sidebar=1');
    fireEvent.click(screen.getAllByRole('button', { name: '显示此窗口侧栏' })[0]);
    expect(view.container.querySelector('iframe')?.getAttribute('src')).toContain('sidebar=1');
    fireEvent.click(screen.getByRole('button', { name: '隐藏此窗口侧栏' }));
    expect(view.container.querySelector('iframe')?.getAttribute('src')).not.toContain('sidebar=1');
  });

  it('窗格工具条只保留设备、会话与侧栏，不再有内容下拉', () => {
    renderWorkspace();
    expect(screen.getAllByRole('combobox')).toHaveLength(4); // 每格两个：设备 + 会话
    expect(screen.queryByRole('combobox', { name: '窗口 1 内容' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '窗口 1 路径' })).toBeNull();
    expect(screen.getAllByRole('combobox', { name: '窗口 1 会话' })).toHaveLength(1);
    expect(screen.getAllByRole('combobox', { name: '窗口 2 会话' })).toHaveLength(1);
  });
});
