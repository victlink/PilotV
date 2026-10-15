import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceSwitcher from './DeviceSwitcher';
import { DEVICE_API } from './deviceApi';
import { DEVICE_HIDDEN_KEY, DEVICE_KEY } from './deviceRegistry';

const PRESETS = [
  { name: 'marc-linux-pc', origin: 'http://100.72.0.111:3001' },
  { name: 'leo-mac-studio', origin: 'http://100.117.103.34:3001' },
  { name: 'jx88', origin: 'http://100.108.86.109:3001' },
];

// 模拟网关的设备清单接口。以前这里对所有地址都回同一份预置，改名和新增
// 写回去之后立刻被自己抹掉，测不到任何东西。现在按地址和方法分别处理。
interface ServerState { devices: typeof PRESETS; error?: string; noApi?: boolean; swallow?: boolean }

let server: ServerState = { devices: [...PRESETS] };

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.startsWith(DEVICE_API)) {
      if (server.noApi) return jsonResponse({}, false, 404);
      if (init?.method === 'POST') {
        if (server.error) return jsonResponse({ error: server.error }, false, 400);
        const body = JSON.parse(String(init.body));
        // swallow：网关把改名写进了文件，却没让清单生效——它照样回 200，
        // 这是「保存不了」最像的一种：请求成功、窗口关闭、名字纹丝不动。
        if (!server.swallow) {
          server.devices = server.devices.some(d => d.origin === body.origin)
            ? server.devices.map(d => (d.origin === body.origin ? { ...d, name: body.name } : d))
            : [...server.devices, { name: body.name, origin: body.origin }];
        }
        return jsonResponse({ devices: server.devices });
      }
      if (init?.method === 'DELETE') {
        const origin = new URL(target, 'http://x').searchParams.get('origin');
        server.devices = server.devices.filter(d => d.origin !== origin);
        return jsonResponse({ devices: server.devices });
      }
      return jsonResponse({ devices: server.devices, writable: true });
    }
    return jsonResponse({ devices: PRESETS });
  }));
}

beforeEach(() => {
  localStorage.clear();
  server = { devices: [...PRESETS] };
  installFetch();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function options() {
  return Array.from(screen.getByLabelText('选择设备').querySelectorAll('option')).map(option => option.textContent);
}

// 设备设置现在是设备列表的最后一项，不再是旁边的齿轮按钮。
const openDeviceSettings = () => fireEvent.change(screen.getByLabelText('选择设备'), {
  target: { value: '__device_settings__' },
});

describe('设备选择器', () => {
  it('预置三台设备在列表里可见，且默认选中当前地址', async () => {
    render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toEqual([
      '当前设备', 'marc-linux-pc', 'leo-mac-studio', 'jx88', '＋ 增加设备', '设备设置…',
    ]));
    expect((screen.getByLabelText('选择设备') as HTMLSelectElement).value).toBe(window.location.origin);
    // 主页面不再有独立的齿轮按钮，入口只有列表最后一项。
    expect(screen.queryByLabelText('设备设置')).toBeNull();
  });

  it('打开与取消都不改变当前选择', async () => {
    render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toContain('leo-mac-studio'));
    openDeviceSettings();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((screen.getByLabelText('选择设备') as HTMLSelectElement).value).toBe(window.location.origin);
    fireEvent.click(screen.getByText('取消'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByLabelText('选择设备') as HTMLSelectElement).value).toBe(window.location.origin);
  });

  it('在悬浮窗里改名后落盘，刷新仍用自定义名称', async () => {
    const view = render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toContain('leo-mac-studio'));
    openDeviceSettings();
    fireEvent.click(screen.getByLabelText('编辑设备 leo-mac-studio'));
    fireEvent.change(screen.getByLabelText('设备名称'), { target: { value: 'leo 的 Mac' } });
    fireEvent.click(screen.getByText('保存设备'));
    await waitFor(() => expect(view.container.textContent).toContain('leo 的 Mac'));

    expect(JSON.parse(localStorage.getItem(DEVICE_KEY) ?? '[]')).toEqual(
      expect.arrayContaining([{ name: 'leo 的 Mac', origin: 'http://100.117.103.34:3001' }]),
    );

    // 重新挂载＝刷新：预置文件仍会拉回，但名称以本机为准。
    cleanup();
    render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toContain('leo 的 Mac'));
    expect(options()).not.toContain('leo-mac-studio');
  });

  it('新增自定义名称的设备并写入本机列表', async () => {
    render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toContain('jx88'));
    openDeviceSettings();
    fireEvent.change(screen.getByLabelText('设备名称'), { target: { value: '会议室大屏' } });
    fireEvent.change(screen.getByLabelText('官方 UI 地址'), { target: { value: 'http://10.0.0.9:3001/' } });
    fireEvent.click(screen.getByText('保存设备'));
    await waitFor(() => expect(options()).toContain('会议室大屏'));
  });

  it('删除预置设备后刷新不会复活', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toContain('jx88'));
    openDeviceSettings();
    fireEvent.click(screen.getByLabelText('删除设备 jx88'));
    await waitFor(() => expect(view.container.textContent).not.toContain('jx88'));
    // 删除要落在服务端，而不是每个浏览器各藏一份。
    expect(server.devices.map(d => d.origin)).not.toContain('http://100.108.86.109:3001');

    cleanup();
    render(<DeviceSwitcher compact={false} />);
    // 换一个「浏览器」重新打开，靠服务端那份清单，不该再看到删掉的设备。
    await waitFor(() => expect(options()).not.toContain('jx88'));
  });

  it('存储不可用时给出提示，而不是静默失败', async () => {
    server.noApi = true;
    render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toContain('jx88'));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });
    openDeviceSettings();
    fireEvent.change(screen.getByLabelText('设备名称'), { target: { value: '会议室大屏' } });
    fireEvent.change(screen.getByLabelText('官方 UI 地址'), { target: { value: 'http://10.0.0.9:3001' } });
    fireEvent.click(screen.getByText('保存设备'));
    // 保存现在是走服务端的一串异步调用，报错要等它跑完才出现。
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('浏览器无法保存配置'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('选择设备＝切换后端，而不是跳去对方官方页面', () => {
  let assigned: string[];
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    assigned = [];
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const origin = window.location.origin;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin, href: `${origin}/`, assign: (value: string) => assigned.push(value) },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: { origin: 'http://localhost', href: 'http://localhost/' } });
    delete window.__PILOTV__;
  });

  it('停在 PilotV 入口，只把目标设备写进 ?d=', async () => {
    render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toContain('jx88'));
    fireEvent.change(screen.getByLabelText('选择设备'), { target: { value: 'http://100.108.86.109:3001' } });
    expect(assigned).toEqual([`${window.location.origin}/?d=${encodeURIComponent('http://100.108.86.109:3001')}`]);
    // 绝不能跳去对方机器的官方前端。
    expect(assigned.some(url => url.includes('100.108.86.109:3001/'))).toBe(false);
  });

  it('用户取消时不跳转，也不改当前选择', async () => {
    confirmSpy.mockReturnValue(false);
    render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toContain('jx88'));
    fireEvent.change(screen.getByLabelText('选择设备'), { target: { value: 'http://100.108.86.109:3001' } });
    expect(assigned).toEqual([]);
    expect((screen.getByLabelText('选择设备') as HTMLSelectElement).value).toBe(window.location.origin);
  });

  it('网关报告的当前后端就是下拉框选中的设备', async () => {
    window.__PILOTV__ = {
      backend: 'http://100.108.86.109:3001', device: { name: 'jx88', origin: 'http://100.108.86.109:3001' },
      source: 'query', unknownDevice: false, artifactsPerDevice: true,
      defaultBackend: 'http://127.0.0.1:3001', defaultName: 'marc-linux-pc',
    };
    render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toContain('jx88'));
    expect((screen.getByLabelText('选择设备') as HTMLSelectElement).value).toBe('http://100.108.86.109:3001');
    // 当前设备条目用网关给的默认后端，而不是页面自己的 origin。
    expect(options()).toContain('marc-linux-pc');
  });

  it('切到别的设备之后，本机条目依然在，可以切回去', async () => {
    window.__PILOTV__ = {
      backend: 'http://100.108.86.109:3001', device: { name: 'jx88', origin: 'http://100.108.86.109:3001' },
      source: 'query', unknownDevice: false, artifactsPerDevice: true,
      defaultBackend: 'http://127.0.0.1:3001', defaultName: '当前设备',
    };
    render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toContain('jx88'));
    const values = (screen.getByLabelText('选择设备') as HTMLSelectElement).querySelectorAll('option');
    expect([...values].some(option => option.value === 'http://127.0.0.1:3001')).toBe(true);
    expect(options()).toContain('当前设备');
  });

  it('服务端拒绝时显示它给出的原因，而不是假装存好了', async () => {
    server.error = '10.0.0.5 不是内网地址，网关只代理内网里的 PilotDeck';
    render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toContain('jx88'));
    openDeviceSettings();
    fireEvent.change(screen.getByLabelText('设备名称'), { target: { value: '外网机器' } });
    fireEvent.change(screen.getByLabelText('官方 UI 地址'), { target: { value: 'http://10.0.0.5:3001/' } });
    fireEvent.click(screen.getByText('保存设备'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('不是内网地址'));
    // 拒绝之后清单必须没变，否则用户会以为这台已经加上了。
    expect(options()).not.toContain('10.0.0.5');
  });

  it('网关没有管理接口时退回本地保存，不影响使用', async () => {
    server.noApi = true;
    render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toContain('jx88'));
    openDeviceSettings();
    fireEvent.change(screen.getByLabelText('设备名称'), { target: { value: '会议室大屏' } });
    fireEvent.change(screen.getByLabelText('官方 UI 地址'), { target: { value: 'http://192.168.9.9:3001/' } });
    fireEvent.click(screen.getByText('保存设备'));
    await waitFor(() => expect(options()).toContain('会议室大屏'));
  });

  it('服务端清单优先于本地缓存', async () => {
    localStorage.setItem(DEVICE_KEY, JSON.stringify([{ name: '本机私藏', origin: 'http://192.168.5.5:3001' }]));
    server.devices = [...PRESETS, { name: '别人加的', origin: 'http://100.72.9.9:3001' }];
    render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toContain('别人加的'));
    expect(options()).not.toContain('本机私藏');
  });

  it('服务端回 200 却没真的改名时，窗口留着并点名是哪台没生效', async () => {
    // 这正是线上遇到的症状：改名没存上，界面却当成功一样把窗口关了。
    server.swallow = true;
    render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toContain('jx88'));
    openDeviceSettings();
    fireEvent.click(screen.getByLabelText('编辑设备 jx88'));
    fireEvent.change(screen.getByLabelText('设备名称'), { target: { value: '会议室大屏' } });
    fireEvent.click(screen.getByText('保存设备'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    const alert = screen.getByRole('alert').textContent ?? '';
    expect(alert).toContain('没有接受');
    expect(alert).toContain('会议室大屏');
    expect(options()).toContain('jx88');
    expect(options()).not.toContain('会议室大屏');
    // 用户要照着原因改完再存一次，所以提示不能在他打字时消失。
    fireEvent.change(screen.getByLabelText('设备名称'), { target: { value: '会议室大屏 v2' } });
    expect(screen.getByRole('alert').textContent).toContain('没有接受');
    // 网关恢复正常后，改一次就存上了，窗口自己关掉。
    server.swallow = false;
    fireEvent.click(screen.getByText('保存设备'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(options()).toContain('会议室大屏 v2');
  });

  it('目标设备不在服务端清单时给出提示', async () => {
    window.__PILOTV__ = {
      backend: 'http://127.0.0.1:3001', device: null, source: 'default',
      unknownDevice: true, artifactsPerDevice: true,
      defaultBackend: 'http://127.0.0.1:3001', defaultName: '当前设备',
    };
    render(<DeviceSwitcher compact={false} />);
    await waitFor(() => expect(options()).toContain('jx88'));
    expect(screen.getByRole('alert').textContent).toContain('已回落到当前设备');
  });
});
