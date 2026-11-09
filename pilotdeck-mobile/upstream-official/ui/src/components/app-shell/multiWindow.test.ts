// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildPaneUrl,
  defaultPane,
  defaultState,
  layoutGridClass,
  MAX_PANES,
  MULTI_WINDOW_STORAGE_KEY,
  normalizeCustomPath,
  normalizeState,
  readState,
  writeState,
} from './multiWindow';

const ORIGIN = 'https://nas.example:5186';
const DEVICE = 'http://127.0.0.1:3001';
const REMOTE = 'http://marc-pc.example:3001';

beforeEach(() => { localStorage.clear(); });

describe('buildPaneUrl', () => {
  it('显式带 d，避免多个窗格抢同一个网关 Cookie', () => {
    const pane = { ...defaultPane(0), view: 'home' as const };
    const url = new URL(buildPaneUrl(pane, { origin: ORIGIN, currentDevice: DEVICE }));
    expect(url.searchParams.get('d')).toBe(DEVICE);
    expect(url.searchParams.get('embed')).toBe('1');
    expect(url.pathname).toBe('/');
  });

  it('每个窗格可以连不同设备', () => {
    const pane = { ...defaultPane(0), device: REMOTE, view: 'session' as const, sessionId: 's-1' };
    const url = new URL(buildPaneUrl(pane, { origin: ORIGIN, currentDevice: DEVICE }));
    expect(url.searchParams.get('d')).toBe(REMOTE);
    expect(url.pathname).toBe('/session/s-1');
  });

  it('会话为空时跟随主界面的当前会话', () => {
    const pane = { ...defaultPane(0), view: 'session' as const, sessionId: '' };
    const url = new URL(buildPaneUrl(pane, { origin: ORIGIN, currentDevice: DEVICE, currentSessionId: 'current-42' }));
    expect(url.pathname).toBe('/session/current-42');
  });

  it('成果台用 view 参数直达，并保留会话深链', () => {
    const pane = { ...defaultPane(1), view: 'artifacts' as const, sessionId: 'art-session' };
    const url = new URL(buildPaneUrl(pane, { origin: ORIGIN, currentDevice: DEVICE }));
    expect(url.searchParams.get('view')).toBe('artifacts');
    expect(url.pathname).toBe('/session/art-session');
  });

  it('弹出独立窗口时去掉 embed，显示完整外壳', () => {
    const pane = { ...defaultPane(0), view: 'home' as const };
    const url = new URL(buildPaneUrl(pane, { origin: ORIGIN, currentDevice: DEVICE, embed: false }));
    expect(url.searchParams.has('embed')).toBe(false);
    expect(url.searchParams.get('d')).toBe(DEVICE);
  });

  it('侧栏开关只在内嵌窗格里生效', () => {
    const pane = { ...defaultPane(0), sidebar: true, view: 'home' as const };
    const embedded = new URL(buildPaneUrl(pane, { origin: ORIGIN, currentDevice: DEVICE }));
    expect(embedded.searchParams.get('sidebar')).toBe('1');
    const popped = new URL(buildPaneUrl(pane, { origin: ORIGIN, currentDevice: DEVICE, embed: false }));
    expect(popped.searchParams.has('sidebar')).toBe(false);
  });

  it('没有网关时不伪造 d 参数', () => {
    const pane = { ...defaultPane(0), view: 'home' as const };
    const url = new URL(buildPaneUrl(pane, { origin: ORIGIN, currentDevice: null }));
    expect(url.searchParams.has('d')).toBe(false);
  });

  it('自定义路径只接受站内绝对路径', () => {
    expect(normalizeCustomPath('/p/demo?tab=files')).toBe('/p/demo?tab=files');
    expect(normalizeCustomPath('https://evil.example')).toBe('/');
    expect(normalizeCustomPath('//evil.example')).toBe('/');
    expect(normalizeCustomPath('/a\\b')).toBe('/');
    const pane = { ...defaultPane(0), view: 'custom' as const, path: 'https://evil.example' };
    expect(new URL(buildPaneUrl(pane, { origin: ORIGIN })).origin).toBe(ORIGIN);
  });
});

describe('布局状态', () => {
  it('默认 2 窗，第一格对话、第二格成果台，其余补满 6 格', () => {
    const state = defaultState();
    expect(state.layout).toBe(2);
    expect(state.panes).toHaveLength(MAX_PANES);
    expect(state.panes[0].view).toBe('session');
    expect(state.panes[1].view).toBe('artifacts');
  });

  it('坏数据不会让工作区白屏', () => {
    expect(normalizeState(null).layout).toBe(2);
    const restored = normalizeState({ layout: 9, panes: [{ view: 'nope', device: 'javascript:alert(1)', sidebar: true }] });
    expect(restored.layout).toBe(2);
    expect(restored.panes).toHaveLength(MAX_PANES);
    expect(restored.panes[0].view).toBe('session');
    expect(restored.panes[0].device).toBe('');
    expect(restored.panes[0].sidebar).toBe(true);
  });

  it('合法配置可以往返 localStorage', () => {
    const state = { ...defaultState(), layout: 6 as const };
    state.panes[0] = { ...state.panes[0], device: REMOTE };
    writeState(state);
    expect(localStorage.getItem(MULTI_WINDOW_STORAGE_KEY)).toBeTruthy();
    expect(readState().layout).toBe(6);
    expect(readState().panes[0].device).toBe(REMOTE);
  });

  it('三种布局都有完整字面量的 grid 类名', () => {
    expect(layoutGridClass(2, false)).toContain('lg:grid-cols-2');
    expect(layoutGridClass(4, false)).toContain('sm:grid-cols-2');
    expect(layoutGridClass(6, false)).toContain('lg:grid-cols-3');
    expect(layoutGridClass(6, true)).toBe('grid-cols-1 grid-rows-1');
  });
});
