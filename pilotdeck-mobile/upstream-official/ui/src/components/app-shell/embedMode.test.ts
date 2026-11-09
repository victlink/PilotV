// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isEmbeddedView, shouldOpenArtifacts } from './embedMode';

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

  it('不传参数时读当前页面 URL', () => {
    const original = window.location.href;
    window.history.replaceState(null, '', '/?embed=1&view=artifacts');
    expect(isEmbeddedView()).toBe(true);
    expect(shouldOpenArtifacts()).toBe(true);
    window.history.replaceState(null, '', original);
  });
});
