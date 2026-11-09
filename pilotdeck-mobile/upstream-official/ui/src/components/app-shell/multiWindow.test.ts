// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildPaneUrl,
  defaultPane,
  defaultState,
  layoutGridClass,
  MAX_PANES,
  MULTI_WINDOW_STORAGE_KEY,
  normalizeState,
  readState,
  writeState,
} from './multiWindow';

const ORIGIN = 'https://nas.example:5186';
const DEVICE = 'http://127.0.0.1:3001';
const REMOTE = 'http://marc-pc.example:3001';

beforeEach(() => { localStorage.clear(); });

describe('buildPaneUrl', () => {
  it('显式带 d 与 embed，视图由窗格内的悬浮按钮决定', () => {
    const pane = defaultPane(0);
    const url = new URL(buildPaneUrl(pane, { origin: ORIGIN, currentDevice: DEVICE }));
    expect(url.searchParams.get('d')).toBe(DEVICE);
    expect(url.searchParams.get('embed')).toBe('1');
    expect(url.searchParams.has('view')).toBe(false);
    expect(url.pathname).toBe('/');
  });

  it('每个窗格可以连不同设备', () => {
    const pane = { ...defaultPane(0), device: REMOTE, sessionId: 's-1' };
    const url = new URL(buildPaneUrl(pane, { origin: ORIGIN, currentDevice: DEVICE }));
    expect(url.searchParams.get('d')).toBe(REMOTE);
    expect(url.pathname).toBe('/session/s-1');
  });

  it('会话为空时跟随主界面的当前会话', () => {
    const url = new URL(buildPaneUrl(defaultPane(0), { origin: ORIGIN, currentDevice: DEVICE, currentSessionId: 'current-42' }));
    expect(url.pathname).toBe('/session/current-42');
  });

  it('重建 iframe 时把窗格里选中的视图带过去', () => {
    expect(new URL(buildPaneUrl(defaultPane(1), { origin: ORIGIN, currentDevice: DEVICE, view: 'artifacts' })).searchParams.get('view')).toBe('artifacts');
    expect(new URL(buildPaneUrl(defaultPane(1), { origin: ORIGIN, currentDevice: DEVICE, view: 'files' })).searchParams.get('view')).toBe('files');
    const chat = new URL(buildPaneUrl(defaultPane(1), { origin: ORIGIN, currentDevice: DEVICE, view: 'chat' }));
    expect(chat.searchParams.get('view')).toBe('chat');
    expect(chat.searchParams.get('embed')).toBe('1');
  });

  it('弹出独立窗口时去掉 embed，显示完整外壳', () => {
    const url = new URL(buildPaneUrl(defaultPane(0), { origin: ORIGIN, currentDevice: DEVICE, embed: false }));
    expect(url.searchParams.has('embed')).toBe(false);
    expect(url.searchParams.get('d')).toBe(DEVICE);
  });

  it('侧栏开关只在内嵌窗格里生效', () => {
    const pane = { ...defaultPane(0), sidebar: true };
    const embedded = new URL(buildPaneUrl(pane, { origin: ORIGIN, currentDevice: DEVICE }));
    expect(embedded.searchParams.get('sidebar')).toBe('1');
    const popped = new URL(buildPaneUrl(pane, { origin: ORIGIN, currentDevice: DEVICE, embed: false }));
    expect(popped.searchParams.has('sidebar')).toBe(false);
  });

  it('没有网关时不伪造 d 参数，也不能被外部地址带跑', () => {
    const url = new URL(buildPaneUrl(defaultPane(0), { origin: ORIGIN, currentDevice: null }));
    expect(url.searchParams.has('d')).toBe(false);
    expect(url.origin).toBe(ORIGIN);
  });
});

describe('布局状态', () => {
  it('默认 2 窗，6 个窗格配置都可用', () => {
    const state = defaultState();
    expect(state.layout).toBe(2);
    expect(state.panes).toHaveLength(MAX_PANES);
    expect(state.panes[0].sessionId).toBe('');
    expect(state.panes[1].sidebar).toBe(false);
  });

  it('坏数据与旧版本的 view/path 字段都不会让工作区白屏', () => {
    expect(normalizeState(null).layout).toBe(2);
    const restored = normalizeState({ layout: 9, panes: [{ view: 'custom', path: 'https://evil.example', device: 'javascript:alert(1)', sidebar: true }] });
    expect(restored.layout).toBe(2);
    expect(restored.panes).toHaveLength(MAX_PANES);
    expect(restored.panes[0].device).toBe('');
    expect(restored.panes[0].sidebar).toBe(true);
    expect(restored.panes[0]).not.toHaveProperty('view');
    expect(restored.panes[0]).not.toHaveProperty('path');
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
