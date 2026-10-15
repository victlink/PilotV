// 网关注入的运行时信息。没有网关时（比如直接用 vite preview）全部退回浏览器默认值，
// 前端因此不需要为两种部署方式写两套逻辑。

export interface PilotVRuntime {
  /** 当前这次会话实际连接的后端 origin。 */
  backend: string;
  /** 命中设备清单时的设备信息。 */
  device: { name: string; origin: string } | null;
  /** backend 是从 ?d= 来的还是来自记住的选择。 */
  source: 'query' | 'header' | 'cookie' | 'default';
  /** ?d= 指了一台网关不认识的设备，已经回落到默认后端。 */
  unknownDevice: boolean;
  /** 成果台是否跟着当前设备走。 */
  artifactsPerDevice: boolean;
  /** 部署 PilotV 这台机器自己的后端。 */
  defaultBackend: string;
  defaultName: string;
  /** 「资料」页 iframe 要打开的 WeKnora 地址；null 表示这次没注入（例如没走网关）。 */
  weknoraUrl?: string | null;
}

declare global {
  interface Window {
    __PILOTV__?: PilotVRuntime
    /** installDeviceRouting 只装一次，避免反复打补丁。 */
    __pilotvRoutingInstalled?: boolean
  }
}

/** 逐请求告诉网关「这个标签页连的是哪台设备」。 */
export const DEVICE_HEADER = 'X-PilotV-Device';

const FALLBACK: PilotVRuntime = {
  backend: '',
  device: null,
  source: 'default',
  unknownDevice: false,
  artifactsPerDevice: false,
  defaultBackend: '',
  defaultName: '当前设备',
  weknoraUrl: null,
};

/** 网关注入的 WeKnora 地址。 */
export const DEFAULT_WEKNORA_PORT = 8080;

/**
 * 「资料」页要 iframe 的 WeKnora 地址。
 *
 * 网关按「打开前端的这台机器 + WeKnora 端口」拼好再注入，这样局域网 IP 和
 * tailscale 地址都跟着当前入口走，不用在前端打包时写死主机。没走网关时退回
 * 同主机默认端口——本机开发（vite preview）下 WeKnora 也在同一个 origin 家族里。
 */
export function weknoraBaseUrl(): string {
  const injected = getPilotVRuntime()?.weknoraUrl;
  if (typeof injected === 'string' && injected.trim()) return injected.trim().replace(/\/+$/, '');
  if (typeof window === 'undefined') return '';
  return `${window.location.protocol}//${window.location.hostname}:${DEFAULT_WEKNORA_PORT}`;
}

/** 读取网关注入的信息；旧缓存页面或未部署网关时返回 null。 */
export function getPilotVRuntime(): PilotVRuntime | null {
  if (typeof window === 'undefined') return null;
  const runtime = window.__PILOTV__;
  if (!runtime || typeof runtime.backend !== 'string' || !runtime.backend) return null;
  return { ...FALLBACK, ...runtime };
}

/** 当前正在使用的后端 origin。 */
export function activeBackendOrigin(): string {
  return getPilotVRuntime()?.backend || window.location.origin;
}

/**
 * 在 PilotV 自己这个 origin 上切换后端。
 * 走 ?d= 是为了让地址可收藏、可分享；网关会把它记进 Cookie。
 */
export function switchBackend(origin: string): void {
  const target = new URL(window.location.origin);
  target.search = `d=${encodeURIComponent(origin)}`;
  target.hash = '';
  window.location.assign(target.toString());
}

/**
 * 让 ?d= 在应用内跳转之后仍然留在地址栏里。
 *
 * 前端路由是 pushState 驱动的，它既不会带上 ?d=，也不会去问网关。
 * 不补这一段的话，点几下之后地址就退回 /p/xxx，收藏和分享都会指错设备。
 * 必须在路由接管 history 之后再包一层，所以只能在挂载之后调用。
 */
export function keepDeviceInUrl(): void {
  const runtime = getPilotVRuntime();
  if (!runtime || history.__pilotvPatched) return;

  const decorate = (method: 'pushState' | 'replaceState') => {
    const original = history[method];
    history[method] = function patchedHistoryMethod(
      this: History,
      state: unknown,
      unused: string,
      url?: string | URL | null,
    ) {
      const result = original.call(this, state, unused, url);
      try {
        const backend = getPilotVRuntime()?.backend;
        if (!backend) return result;
        const target = new URL(String(url || window.location.href), window.location.origin);
        if (target.searchParams.get('d') === backend) return result;
        target.searchParams.set('d', backend);
        original.call(history, state, '', `${target.pathname}${target.search}${target.hash}`);
      } catch {
        // 换不动就算了：设备本身已经记在 Cookie 里，功能不会坏。
      }
      return result;
    } as History[typeof method];
  };

  decorate('pushState');
  decorate('replaceState');
  history.__pilotvPatched = true;
}

declare global {
  interface History { __pilotvPatched?: boolean }
}
/**
 * 给同源请求补上「当前标签页连的是哪台设备」。
 *
 * 原本网关靠 Cookie 判断设备，而 Cookie 是整个浏览器共享的：两个标签页各开
 * 一台设备时，后打开的那个会把前一个的 Cookie 改掉，两边一起串到同一台机器。
 * 改成每个请求都带一个头之后，路由信息就只存在于各自标签页的 JS 上下文里，
 * 互不干扰。网关那边头优先于 Cookie。
 *
 * WebSocket 构造器没法加头（浏览器不允许），所以那边改用 URL 上的 ?d=，
 * 见 withDeviceParam。
 */
export function withDeviceHeader(input: RequestInfo | URL, init?: RequestInit): RequestInit | undefined {
  const backend = getPilotVRuntime()?.backend;
  if (!backend || typeof window === 'undefined') return init;
  // 跨域请求不加这个头：那不是网关转发的路径，加了也没有意义。
  if (typeof input !== 'string' && !(input instanceof URL)) return init;
  const url = typeof input === 'string' ? input : input.toString();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith(window.location.origin)) return init;
  const headers = new Headers(init?.headers || {});
  if (headers.has(DEVICE_HEADER)) return init;
  headers.set(DEVICE_HEADER, backend);
  return { ...init, headers };
}

/**
 * 给 WebSocket 地址带上设备标记。
 * 连接和 shell 终端都用它，否则标签页切了设备之后长连接还挂在旧后端上。
 */
export function withDeviceParam(url: string): string {
  const backend = getPilotVRuntime()?.backend;
  if (!backend) return url;
  try {
    const target = new URL(url, window.location.origin);
    target.searchParams.set('d', backend);
    return target.toString();
  } catch {
    return url;
  }
}

/** 装上这两处补丁。要尽早调用，最好在任何请求发出之前。 */
export function installDeviceRouting(): void {
  if (typeof window === 'undefined' || window.__pilotvRoutingInstalled) return;
  window.__pilotvRoutingInstalled = true;

  const originalFetch = window.fetch?.bind(window);
  if (originalFetch) {
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      originalFetch(input, withDeviceHeader(input, init))) as typeof window.fetch;
  }

  const OriginalXhr = window.XMLHttpRequest;
  if (OriginalXhr) {
    class DeviceAwareXhr extends OriginalXhr {
      open(method: string, url: string | URL, ...rest: unknown[]) {
        const backend = getPilotVRuntime()?.backend;
        try {
          if (backend) this.setRequestHeader(DEVICE_HEADER, backend);
        } catch {
          // 某些状态下调 setRequestHeader 会抛，忽略即可，请求照样发得出去。
        }
        return super.open(method, url, ...(rest as [boolean, string?, string?]));
      }
    }
    window.XMLHttpRequest = DeviceAwareXhr as unknown as typeof XMLHttpRequest;
  }
}
