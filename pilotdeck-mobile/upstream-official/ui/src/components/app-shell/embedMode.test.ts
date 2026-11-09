// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { isEmbeddedView, readPaneView, shouldOpenArtifacts, shouldShowEmbeddedSidebar, syncEmbeddedPaneView } from './embedMode';

const ORIGINAL_HREF = window.location.href;
afterEach(() => { window.history.replaceState(null, '', ORIGINAL_HREF); });

describe('iframe 内嵌开关', () => {
  it('只有 embed=1 才开启精简模式', () => {
    expect(isEmbeddedView('?embed=1')).toBe(true);
    expect(isEmbeddedView('?d=http%3A%2F%2Fnas%3A3001&embed=1')).toBe(true);
    expect(isEmbeddedView('?embed=0')).toBe(false);
    expect(isEmbeddedView('')).toBe(false);
  });

  it('成果台深链与其它参数可以共存', () => {
    expect(shouldOpenArtifacts('?view=artifacts&embed=1')).toBe(true);
    expect(shouldOpenArtifacts('?view=chat')).toBe(false);
    expect(shouldOpenArtifacts('')).toBe(false);
  });

  it('只有内嵌窗格才允许重新展开侧栏', () => {
    expect(shouldShowEmbeddedSidebar('?embed=1&sidebar=1')).toBe(true);
    expect(shouldShowEmbeddedSidebar('?embed=1')).toBe(false);
    expect(shouldShowEmbeddedSidebar('?sidebar=1')).toBe(false);
  });

  it('不传参数时读当前页面 URL', () => {
    const original = window.location.href;
    window.history.replaceState(null, '', '/?embed=1&view=artifacts');
    expect(isEmbeddedView()).toBe(true);
    expect(shouldOpenArtifacts()).toBe(true);
    window.history.replaceState(null, '', original);
  });
});

describe('窗格视图与 URL 同步', () => {
  it('右侧悬浮按钮的三种视图都能从 URL 还原', () => {
    expect(readPaneView('?view=chat')).toBe('chat');
    expect(readPaneView('?view=files')).toBe('files');
    expect(readPaneView('?view=artifacts')).toBe('artifacts');
    expect(readPaneView('?view=unknown')).toBe('chat');
    expect(readPaneView('')).toBe('chat');
  });

  it('内嵌窗格切换视图时保留设备、侧栏和会话路径', () => {
    window.history.replaceState(null, '', '/session/s-1?d=http%3A%2F%2Fnas%3A3001&embed=1&sidebar=1');
    syncEmbeddedPaneView('artifacts');
    expect(window.location.pathname).toBe('/session/s-1');
    expect(window.location.search).toContain('view=artifacts');
    expect(window.location.search).toContain('embed=1');
    expect(window.location.search).toContain('sidebar=1');
    expect(window.location.search).toContain('d=http%3A%2F%2Fnas%3A3001');
    syncEmbeddedPaneView('chat');
    expect(window.location.search).toContain('view=chat');
    syncEmbeddedPaneView('files');
    expect(window.location.search).toContain('view=files');
    expect(new URLSearchParams(window.location.search).getAll('view')).toEqual(['files']);
  });

  it('独立浏览器窗口也保存自己的视图', () => {
    window.history.replaceState(null, '', '/session/popup?window=popup-1&view=chat');
    syncEmbeddedPaneView('files');
    expect(window.location.search).toContain('view=files');
    expect(window.location.search).toContain('window=popup-1');
  });

  it('非内嵌页面不会被改写', () => {
    window.history.replaceState(null, '', '/?d=http%3A%2F%2Fnas%3A3001');
    expect(syncEmbeddedPaneView('artifacts')).toBeNull();
    expect(window.location.search).not.toContain('view');
  });
});
