// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WeKnoraArea from './WeKnoraArea';

const BASE = 'http://docs.test:8080';
const HEALTH = `${BASE}/__pilotv_health`;

// 文案走 i18n，断言只认 data-state / iframe 这些跟语言无关的东西。
function state() {
  return screen.getByTestId('weknora-area').getAttribute('data-state');
}

beforeEach(() => {
  window.__PILOTV__ = {
    backend: 'http://127.0.0.1:3001', device: null, source: 'default', unknownDevice: false,
    artifactsPerDevice: false, defaultBackend: 'http://127.0.0.1:3001', defaultName: '当前设备',
    weknoraUrl: BASE,
  };
});

afterEach(() => {
  cleanup();
  delete window.__PILOTV__;
  vi.unstubAllGlobals();
});

describe('资料页', () => {
  it('探活通过才挂 iframe，地址取自网关注入', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<WeKnoraArea />);

    const frame = await waitFor(() => {
      const found = document.querySelector('iframe');
      if (!found) throw new Error('iframe 还没挂上');
      return found as HTMLIFrameElement;
    });
    expect(fetchMock).toHaveBeenCalledWith(HEALTH, expect.objectContaining({ cache: 'no-store' }));
    expect(frame.getAttribute('src')).toBe(`${BASE}/`);
    // 「在新标签打开」把用户从这个 iframe 里放出去，嵌坏了也有退路。
    expect(screen.getByRole('link').getAttribute('href')).toBe(BASE);
  });

  it('探活一过就把画面交出去，不再盖一层等 load 的转圈', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    render(<WeKnoraArea />);

    await waitFor(() => { if (state() !== 'ready') throw new Error('还没到 ready'); });
    // WeKnora 页面里有长连接时 load 事件可能一直不触发，所以不能再等 load。
    expect(document.querySelectorAll('.animate-spin').length).toBe(0);
    expect(document.querySelector('iframe')).toBeTruthy();
  });

  it('探活失败就说清楚是服务没起来，而不是丢一个报错页进去', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    render(<WeKnoraArea />);

    await waitFor(() => expect(state()).toBe('down'));
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('点重试会重新探活', async () => {
    let healthy = false;
    const fetchMock = vi.fn(async () => {
      if (!healthy) throw new TypeError('Failed to fetch');
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WeKnoraArea />);
    await waitFor(() => expect(state()).toBe('down'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    healthy = true;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(state()).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('探活返回非 2xx 同样算没起来', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));
    render(<WeKnoraArea />);
    await waitFor(() => expect(state()).toBe('down'));
  });

  it('探活卡住也不能一直转圈', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    // 用假时钟把生产里那 5 秒超时推到头：请求悬着不动，用户看到的也不能是永远转圈。
    vi.useFakeTimers();
    render(<WeKnoraArea />);
    expect(state()).toBe('probing');

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(state()).toBe('down');
    vi.useRealTimers();
  });
});