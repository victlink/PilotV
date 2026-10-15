import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DeviceSettingsDialog from './DeviceSettingsDialog';
import type { Device } from './deviceRegistry';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const devices: Device[] = [
  { name: 'marc-linux-pc', origin: 'http://100.72.0.111:3001' },
  { name: 'leo-mac-studio', origin: 'http://100.117.103.34:3001' },
  { name: 'jx88', origin: 'http://100.108.86.109:3001' },
];

function setup(overrides: Partial<React.ComponentProps<typeof DeviceSettingsDialog>> = {}) {
  const onCommit = vi.fn();
  const onClose = vi.fn();
  const view = render(<DeviceSettingsDialog devices={devices} presetOrigins={['http://100.72.0.111:3001']} onClose={onClose} onCommit={onCommit} {...overrides} />);
  return { onCommit, onClose, view };
}

function save(name: string, address: string) {
  fireEvent.change(screen.getByLabelText('设备名称'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('官方 UI 地址'), { target: { value: address } });
  fireEvent.click(screen.getByText('保存设备'));
}

describe('设备设置悬浮窗', () => {
  it('上层重渲染时不抢走正在输入的焦点', () => {
    // 输入法键盘跳来跳去的根因：焦点安排被写成了依赖 onClose，而 onClose 是父组件
    // 每次渲染都新建的内联箭头。上层每收到一条推送，焦点就被甩到「设备设置」按钮
    // 再抢回输入框，中文合成被打断，候选窗反复弹起。这里模拟那次重渲染。
    const view = render(
      <DeviceSettingsDialog devices={devices} onClose={() => {}} onCommit={() => {}} />);
    const address = screen.getByLabelText('官方 UI 地址') as HTMLInputElement;
    address.focus();
    view.rerender(
      <DeviceSettingsDialog devices={devices} onClose={() => {}} onCommit={() => {}} />);
    expect(document.activeElement).toBe(address);
    view.rerender(
      <DeviceSettingsDialog devices={[...devices]} onClose={() => {}} onCommit={() => {}} />);
    expect(document.activeElement).toBe(address);
  });

  it('独立挂到 body，不受侧栏布局影响', () => {
    const { view } = setup();
    const dialog = screen.getByRole('dialog');
    expect(view.container.contains(dialog)).toBe(false);
    expect(dialog.closest('[data-dialog-backdrop]')?.parentElement).toBe(document.body);
    expect(screen.getByText('设备设置')).toBeTruthy();
  });

  it('自定义名称新增设备，提交完整列表', () => {
    const { onCommit } = setup();
    save('会议室大屏', 'http://10.0.0.9:3001/');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toEqual([...devices, { name: '会议室大屏', origin: 'http://10.0.0.9:3001' }]);
    expect(onCommit.mock.calls[0][1]).toEqual([]);
  });

  it('列表里改名：只换名字，地址保持原样', () => {
    const { onCommit } = setup();
    fireEvent.click(screen.getByLabelText('编辑设备 leo-mac-studio'));
    expect((screen.getByLabelText('设备名称') as HTMLInputElement).value).toBe('leo-mac-studio');
    save('leo 的 Mac', 'http://100.117.103.34:3001');
    expect(onCommit.mock.calls[0][0]).toEqual([
      { name: 'marc-linux-pc', origin: 'http://100.72.0.111:3001' },
      { name: 'leo 的 Mac', origin: 'http://100.117.103.34:3001' },
      { name: 'jx88', origin: 'http://100.108.86.109:3001' },
    ]);
  });

  it('改名同时换地址时，旧地址一并记为移除', () => {
    const { onCommit } = setup();
    fireEvent.click(screen.getByLabelText('编辑设备 jx88'));
    save('jx88 新机', 'http://100.108.86.110:3001');
    expect(onCommit.mock.calls[0][0]).toEqual([
      { name: 'marc-linux-pc', origin: 'http://100.72.0.111:3001' },
      { name: 'leo-mac-studio', origin: 'http://100.117.103.34:3001' },
      { name: 'jx88 新机', origin: 'http://100.108.86.110:3001' },
    ]);
    expect(onCommit.mock.calls[0][1]).toEqual(['http://100.108.86.109:3001']);
  });

  it('删除需确认，确认后立即提交剩余列表与被删地址', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onCommit } = setup();
    fireEvent.click(screen.getByLabelText('删除设备 marc-linux-pc'));
    expect(onCommit).not.toHaveBeenCalled();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByLabelText('删除设备 marc-linux-pc'));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toEqual(devices.slice(1));
    expect(onCommit.mock.calls[0][1]).toEqual(['http://100.72.0.111:3001']);
  });

  it('非法地址不提交，错误就地提示', () => {
    const { onCommit } = setup();
    save('坏地址', 'http://100.72.0.111:3001/artifacts.html');
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('根地址');
  });

  it('取消与 ESC 都不提交任何改动', () => {
    const { onCommit, onClose } = setup();
    fireEvent.click(screen.getByText('取消'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('打开即可直接编辑指定设备', () => {
    const { onCommit } = setup({ mode: 'edit', origin: 'http://100.108.86.109:3001' });
    expect((screen.getByLabelText('设备名称') as HTMLInputElement).value).toBe('jx88');
    save('AI 工作站', 'http://100.108.86.109:3001');
    expect(onCommit.mock.calls[0][0][2]).toEqual({ name: 'AI 工作站', origin: 'http://100.108.86.109:3001' });
  });

  it('预置设备在列表里带标记', () => {
    setup();
    const marked = screen.getByText('预置').closest('li');
    expect(marked?.textContent).toContain('marc-linux-pc');
  });
});
