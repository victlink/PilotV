import { afterEach, describe, expect, it } from 'vitest';
import {
  DEVICE_HEADER, DEFAULT_WEKNORA_PORT, activeBackendOrigin, getPilotVRuntime, keepDeviceInUrl,
  switchBackend, weknoraBaseUrl, withDeviceHeader, withDeviceParam, type PilotVRuntime,
} from './pilotvRuntime';

describe('网关注入的运行时信息', () => {
  afterEach(() => { delete window.__PILOTV__; });

  it('没有网关时退回页面自身 origin', () => {
    expect(getPilotVRuntime()).toBeNull();
    expect(activeBackendOrigin()).toBe(window.location.origin);
  });

  it('优先使用网关给出的后端', () => {
    window.__PILOTV__ = {
      backend: 'http://100.108.86.109:3001', device: { name: 'jx88', origin: 'http://100.108.86.109:3001' },
      source: 'query', unknownDevice: false, artifactsPerDevice: true,
      defaultBackend: 'http://127.0.0.1:3001', defaultName: '当前设备',
    };
    expect(activeBackendOrigin()).toBe('http://100.108.86.109:3001');
    expect(getPilotVRuntime()?.device?.name).toBe('jx88');
  });

  it('后端为空视为没有网关', () => {
    window.__PILOTV__ = { backend: '' } as never;
    expect(getPilotVRuntime()).toBeNull();
  });

  it('切换设备时留在 PilotV 自己的入口，只改 ?d=', () => {
    let assigned = '';
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        origin: original.origin,
        get href() { return original.href; },
        assign: (value: string) => { assigned = value; },
      },
    });
    switchBackend('http://100.108.86.109:3001');
    expect(assigned).toBe(`${window.location.origin}/?d=${encodeURIComponent('http://100.108.86.109:3001')}`);
    expect(assigned.startsWith(original.origin)).toBe(true);
    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });
});

describe('资料页要打开的 WeKnora 地址', () => {
  afterEach(() => { delete window.__PILOTV__; });

  it('优先用网关注入的地址，并去掉尾斜杠', () => {
    window.__PILOTV__ = {
      backend: 'http://127.0.0.1:3001', device: null, source: 'default', unknownDevice: false,
      artifactsPerDevice: false, defaultBackend: 'http://127.0.0.1:3001', defaultName: '当前设备',
      weknoraUrl: 'http://100.90.196.104:8080/',
    };
    expect(weknoraBaseUrl()).toBe('http://100.90.196.104:8080');
  });

  it('网关没注入时退回同主机 + 默认端口', () => {
    expect(weknoraBaseUrl()).toBe(`${window.location.protocol}//${window.location.hostname}:${DEFAULT_WEKNORA_PORT}`);
  });

  it('网关注入了 null 也不当成地址用', () => {
    window.__PILOTV__ = {
      backend: 'http://127.0.0.1:3001', device: null, source: 'default', unknownDevice: false,
      artifactsPerDevice: false, defaultBackend: 'http://127.0.0.1:3001', defaultName: '当前设备',
      weknoraUrl: null,
    };
    expect(weknoraBaseUrl()).toContain(`:${DEFAULT_WEKNORA_PORT}`);
  });
});

describe('应用内跳转后 ?d= 仍在地址栏', () => {
  const runtime = {
    backend: 'http://100.108.86.109:3001', device: { name: 'jx88', origin: 'http://100.108.86.109:3001' },
    source: 'query' as const, unknownDevice: false, artifactsPerDevice: true,
    defaultBackend: 'http://127.0.0.1:3001', defaultName: '当前设备',
  };

  afterEach(() => { delete window.__PILOTV__; delete history.__pilotvPatched; });

  it('pushState 之后补上 ?d=', () => {
    window.__PILOTV__ = runtime;
    keepDeviceInUrl();
    window.history.replaceState(null, '', '/p/general');
    window.history.pushState(null, '', '/p/other');
    expect(window.location.search).toBe('?d=http%3A%2F%2F100.108.86.109%3A3001');
    expect(window.location.pathname).toBe('/p/other');
  });

  it('replaceState 也会补上，且不会重复叠加', () => {
    window.__PILOTV__ = runtime;
    keepDeviceInUrl();
    window.history.replaceState(null, '', '/settings');
    window.history.replaceState(null, '', '/settings?d=other');
    expect(window.location.search).toBe(`?d=${encodeURIComponent(runtime.backend)}`);
  });

  it('重复调用只会包一层', () => {
    window.__PILOTV__ = runtime;
    keepDeviceInUrl();
    const first = window.history.pushState;
    keepDeviceInUrl();
    expect(window.history.pushState).toBe(first);
  });

  it('没有网关时不动 history', () => {
    const original = window.history.pushState;
    keepDeviceInUrl();
    expect(window.history.pushState).toBe(original);
  });
});

describe('逐标签页的设备路由', () => {
  afterEach(() => { delete window.__PILOTV__; });

  it('同源请求会带上当前标签页连的那台设备', () => {
    window.__PILOTV__ = { backend: 'http://100.72.0.111:3001' } as PilotVRuntime;
    const init = withDeviceHeader('/api/projects')!;
    expect(new Headers(init.headers).get(DEVICE_HEADER)).toBe('http://100.72.0.111:3001');
  });

  it('不带网关信息时不加头，原样透传', () => {
    const init = withDeviceHeader('/api/projects', { method: 'POST' });
    expect(init).toEqual({ method: 'POST' });
    expect(new Headers(init?.headers).has(DEVICE_HEADER)).toBe(false);
  });

  it('跨域请求不加这个头：网关不转发它，加了也没用', () => {
    window.__PILOTV__ = { backend: 'http://100.72.0.111:3001' } as PilotVRuntime;
    const init = withDeviceHeader('https://example.com/api');
    expect(new Headers(init?.headers).has(DEVICE_HEADER)).toBe(false);
  });

  it('已经带过的头不会被覆盖', () => {
    window.__PILOTV__ = { backend: 'http://100.72.0.111:3001' } as PilotVRuntime;
    const init = withDeviceHeader('/api/projects', { headers: { [DEVICE_HEADER]: 'http://100.108.86.109:3001' } })!;
    expect(new Headers(init.headers).get(DEVICE_HEADER)).toBe('http://100.108.86.109:3001');
  });

  it('WebSocket 地址带上设备，且不弄坏已有的 token 参数', () => {
    window.__PILOTV__ = { backend: 'http://100.108.86.109:3001' } as PilotVRuntime;
    const url = new URL(withDeviceParam('ws://127.0.0.1:5187/ws?token=abc'));
    expect(url.searchParams.get('token')).toBe('abc');
    expect(url.searchParams.get('d')).toBe('http://100.108.86.109:3001');
  });

  it('两个标签页各连一台设备，互不影响', () => {
    window.__PILOTV__ = { backend: 'http://100.72.0.111:3001' } as PilotVRuntime;
    const tabA = new Headers(withDeviceHeader('/api/projects')!.headers).get(DEVICE_HEADER);
    // 另一个标签页有自己独立的 JS 上下文，也就有一份独立的 __PILOTV__。
    (window as unknown as { __PILOTV__: PilotVRuntime }).__PILOTV__ = { backend: 'http://100.108.86.109:3001' } as PilotVRuntime;
    const tabB = new Headers(withDeviceHeader('/api/projects')!.headers).get(DEVICE_HEADER);
    expect([tabA, tabB]).toEqual(['http://100.72.0.111:3001', 'http://100.108.86.109:3001']);
  });
});
