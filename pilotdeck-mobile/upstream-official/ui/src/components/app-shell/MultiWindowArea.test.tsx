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
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  (window as unknown as { __PILOTV__: unknown }).__PILOTV__ = { backend: BACKEND };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { __PILOTV__?: unknown }).__PILOTV__;
});

describe('多窗口工作区', () => {
  it('内部切设备同步外部选择器，但消息、load 和布局变更不重载 iframe', () => {
    const view = renderWorkspace();
    const frame = view.container.querySelector('iframe')!;
    const src = frame.getAttribute('src');
    const select = screen.getByRole('combobox', { name: '窗口 1 设备' }) as HTMLSelectElement;
    for (const device of [BACKEND, 'http://remote:3001']) {
      const option = document.createElement('option');
      option.value = device;
      select.appendChild(option);
    }
    const source = { location: { href: `${window.location.origin}/session/remote?window=pane-1&view=files&d=http%3A%2F%2Fremote%3A3001` } };
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: source });
    fireEvent(window, new MessageEvent('message', { origin: window.location.origin, source: source as unknown as Window, data: { type: 'pilotv-pane-context' } }));
    expect(select.value).toBe('http://remote:3001');
    expect(JSON.parse(sessionStorage.getItem('pilotv-multi-window-v1')!).panes[0].device).toBe('http://remote:3001');
    fireEvent.load(frame);
    fireEvent.click(screen.getByRole('button', { name: '4 窗口布局' }));
    expect(view.container.querySelector('iframe')).toBe(frame);
    expect(frame.getAttribute('src')).toBe(src);
    expect(select.value).toBe('http://remote:3001');
    // An explicit toolbar change must still navigate this pane and update its controlled value.
    fireEvent.change(select, { target: { value: BACKEND } });
    expect(select.value).toBe(BACKEND);
    expect(view.container.querySelector('iframe')).not.toBe(frame);
    expect(new URL(view.container.querySelector('iframe')!.getAttribute('src')!).searchParams.get('d')).toBe(BACKEND);
  });
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

  it('不向远端窗格提供外层设备会话，默认各自展开导航', () => {
    const view = renderWorkspace();
    expect(view.container.querySelector('iframe')?.getAttribute('src')).toContain('sidebar=1');
    expect(screen.queryByRole('combobox', { name: '窗口 1 会话' })).toBeNull();
  });

  it('布局缩减和放大不卸载其它窗格', () => {
    const view = renderWorkspace();
    const first = view.container.querySelector('iframe');
    fireEvent.click(screen.getByRole('button', { name: '4 窗口布局' }));
    const fourth = view.container.querySelectorAll('iframe')[3];
    fireEvent.click(screen.getByRole('button', { name: '2 窗口布局' }));
    fireEvent.click(screen.getByRole('button', { name: '4 窗口布局' }));
    expect(view.container.querySelectorAll('iframe')[3]).toBe(fourth);
    expect(view.container.querySelector('iframe')).toBe(first);
  });

  it('刷新、弹出、重挂载保留窗格内选择的设备、项目会话与视图', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const first = renderWorkspace();
    const frame = first.container.querySelector('iframe')!;
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { location: { href: `${window.location.origin}/p/remote-project/c/remote-session?d=http%3A%2F%2Fremote%3A3001&window=pane-1&embed=1&view=artifacts` } } });
    fireEvent.click(screen.getAllByRole('button', { name: '弹出为独立窗口' })[0]);
    const popped = new URL(String(open.mock.calls[0][0]));
    expect(popped.pathname).toBe('/p/remote-project/c/remote-session');
    expect(popped.searchParams.get('d')).toBe('http://remote:3001');
    expect(popped.searchParams.get('view')).toBe('artifacts');
    expect(popped.searchParams.get('window')).toMatch(/^popup-/);
    expect(open.mock.calls[0][2]).toContain('popup');
    fireEvent.click(screen.getAllByRole('button', { name: '刷新此窗口' })[0]);
    expect(first.container.querySelector('iframe')?.getAttribute('src')).toContain('/p/remote-project/c/remote-session');
    first.unmount();
    const second = renderWorkspace();
    expect(second.container.querySelector('iframe')?.getAttribute('src')).toContain('view=artifacts');
    open.mockRestore();
  });

  it('切设备清空旧会话路径，只修改目标窗格', () => {
    const view = renderWorkspace();
    const frames = view.container.querySelectorAll('iframe');
    const second = frames[1];
    Object.defineProperty(frames[0], 'contentWindow', { configurable: true, value: { location: { href: `${window.location.origin}/session/old-session?window=pane-1&embed=1&view=files&d=${encodeURIComponent(BACKEND)}` } } });
    const select = screen.getByRole('combobox', { name: '窗口 1 设备' });
    const option = document.createElement('option');
    option.value = 'http://remote:3001';
    select.appendChild(option);
    fireEvent.change(select, { target: { value: option.value } });
    const next = new URL(view.container.querySelector('iframe')!.getAttribute('src')!);
    expect(next.pathname).toBe('/');
    expect(next.searchParams.get('d')).toBe('http://remote:3001');
    expect(next.searchParams.get('view')).toBe('files');
    expect(view.container.querySelectorAll('iframe')[1]).toBe(second);
  });

  it('可以在 2 / 4 / 6 之间切换', () => {
    const view = renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: '4 窗口布局' }));
    expect(view.container.querySelectorAll('iframe')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: '6 窗口布局' }));
    expect(view.container.querySelectorAll('iframe')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: '2 窗口布局' }));
    expect(view.container.querySelectorAll('section:not([hidden]) iframe')).toHaveLength(2);
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
    expect(view.container.querySelectorAll('section:not([hidden]) iframe')).toHaveLength(1);
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
    expect(view.container.querySelector('iframe')?.getAttribute('src')).toContain('sidebar=1');
    fireEvent.click(screen.getAllByRole('button', { name: '隐藏此窗口侧栏' })[0]);
    expect(view.container.querySelector('iframe')?.getAttribute('src')).not.toContain('sidebar=1');
    fireEvent.click(screen.getByRole('button', { name: '显示此窗口侧栏' }));
    expect(view.container.querySelector('iframe')?.getAttribute('src')).toContain('sidebar=1');
  });

  it('窗格工具条只保留设备、会话与侧栏，不再有内容下拉', () => {
    renderWorkspace();
    expect(screen.getAllByRole('combobox')).toHaveLength(2); // 外层只选设备，会话由各窗格侧栏提供
    expect(screen.queryByRole('combobox', { name: '窗口 1 内容' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '窗口 1 路径' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '窗口 1 会话' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '窗口 2 会话' })).toBeNull();
  });
});
