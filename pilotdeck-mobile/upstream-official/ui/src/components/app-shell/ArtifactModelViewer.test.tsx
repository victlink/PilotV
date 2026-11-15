// @vitest-environment jsdom
// 成果台三维展示台的界面测试。
//
// three 在这里整个 mock 掉：真正要验的是「面板上的操作有没有变成三维层的
// 指令」——选中零件、隐藏、改色、爆炸、背景、收起面板。渲染本身由
// artifactStage3d.test.ts 和浏览器里的人工验证兜底（jsdom 里没有 WebGL）。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import ArtifactModelViewer from './ArtifactModelViewer';

type Part = { id: string; name: string; vertexCount: number; textured: boolean; color: string };

const stage = vi.hoisted(() => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const state = {
    calls,
    instances: [] as Array<{ select: (id: string | null) => void }>,
    parts: [
      { id: 'p1', name: '机身', vertexCount: 100, textured: false, color: '#3b6ea5' },
      { id: 'p2', name: '机翼', vertexCount: 100, textured: false, color: '#e07b39' },
    ] as Part[],
    hasTexture: false,
    empty: false,
    error: null as Error | null,
  };

  class FakeThreeStage {
    constructor(public host: HTMLElement, public callbacks: { onSelect?: (id: string | null) => void }) {
      state.instances.push({ select: (id: string | null) => callbacks.onSelect?.(id) });
    }
    async load() {
      if (state.error) throw state.error;
      return {
        parts: state.parts,
        hasTexture: state.hasTexture,
        vertexCount: state.parts.length * 100,
        radius: 10,
        empty: state.empty,
      };
    }
    setBackground(value: string) { state.calls.push({ method: 'setBackground', args: [value] }); }
    setColorMode(value: string) { state.calls.push({ method: 'setColorMode', args: [value] }); }
    setExplode(value: number) { state.calls.push({ method: 'setExplode', args: [value] }); }
    setAlpha(value: number) { state.calls.push({ method: 'setAlpha', args: [value] }); }
    setPartColor(id: string, value: string | null) { state.calls.push({ method: 'setPartColor', args: [id, value] }); }
    setPartOpacity(id: string, value: number) { state.calls.push({ method: 'setPartOpacity', args: [id, value] }); }
    setPartHidden(id: string, value: boolean) { state.calls.push({ method: 'setPartHidden', args: [id, value] }); }
    setPartOffset(id: string, value: number[]) { state.calls.push({ method: 'setPartOffset', args: [id, value] }); }
    setAutoRotate(value: boolean) { state.calls.push({ method: 'setAutoRotate', args: [value] }); }
    setZoom(value: number) { state.calls.push({ method: 'setZoom', args: [value] }); }
    setGesturesEnabled(value: boolean) { state.calls.push({ method: 'setGesturesEnabled', args: [value] }); }
    resetView() { state.calls.push({ method: 'resetView', args: [] }); }
    playTravel(id: string, axis: number[], distance: number) { state.calls.push({ method: 'playTravel', args: [id, axis, distance] }); }
    dispose() { state.calls.push({ method: 'dispose', args: [] }); }
  }

  return { FakeThreeStage, state };
});

vi.mock('./threeStage', () => ({ ThreeStage: stage.FakeThreeStage }));

beforeEach(() => {
  stage.state.calls = [];
  stage.state.instances = [];
  stage.state.parts = [
    { id: 'p1', name: '机身', vertexCount: 100, textured: false, color: '#3b6ea5' },
    { id: 'p2', name: '机翼', vertexCount: 100, textured: false, color: '#e07b39' },
  ];
  stage.state.hasTexture = false;
  stage.state.empty = false;
  stage.state.error = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderViewer(props: Partial<ComponentProps<typeof ArtifactModelViewer>> = {}) {
  const view = render(
    <ArtifactModelViewer src="/api/artifacts/a1/viewer" alt="装配体" {...props} />,
  );
  // 等「正在载入…」消失：模型到了才算数（面板里有没有零件是另一回事）。
  await waitFor(() => expect(screen.queryByText('正在载入三维模型…')).toBeNull());
  return view;
}

describe('成果台的三维展示台', () => {
  it('模型装好了，零件清单就摆出来', async () => {
    await renderViewer();
    expect(screen.getByText('机身')).toBeTruthy();
    expect(screen.getByText('机翼')).toBeTruthy();
  });

  it('左键选中的零件要能改颜色、改透明度、挪动', async () => {
    await renderViewer();

    fireEvent.click(screen.getByText('机身'));
    await screen.findByLabelText('零件颜色');
    expect(screen.getByLabelText('零件透明度')).toBeTruthy();
    expect(screen.getByLabelText('挪动距离')).toBeTruthy();
  });

  it('颜色改动要真的落到那个零件上', async () => {
    await renderViewer();
    fireEvent.click(screen.getByText('机身'));
    const picker = await screen.findByLabelText('零件颜色');
    fireEvent.change(picker, { target: { value: '#ff0000' } });

    await waitFor(() => expect(stage.state.calls.some(call =>
      call.method === 'setPartColor' && call.args[0] === 'p1' && call.args[1] === '#ff0000')).toBe(true));
  });

  it('隐藏零件：被藏的那件要收到隐藏指令', async () => {
    await renderViewer();
    const row = screen.getByText('机翼').closest('div')!;
    fireEvent.click(row.querySelector('button[aria-pressed="false"]')!);

    await waitFor(() => expect(stage.state.calls.some(call =>
      call.method === 'setPartHidden' && call.args[0] === 'p2' && call.args[1] === true)).toBe(true));
  });

  it('爆炸滑块一动，三维层就收到爆炸程度', async () => {
    await renderViewer();
    fireEvent.change(screen.getByLabelText('爆炸程度'), { target: { value: '100' } });
    await waitFor(() => expect(stage.state.calls.some(call =>
      call.method === 'setExplode' && call.args[0] === 1)).toBe(true));
  });

  it('背景色可以换', async () => {
    await renderViewer();
    fireEvent.click(screen.getByRole('button', { name: '背景色：深色' }));
    await waitFor(() => expect(stage.state.calls.some(call =>
      call.method === 'setBackground' && call.args[0] === '#141821')).toBe(true));
  });

  it('多零件默认分色：各件颜色不一样', async () => {
    await renderViewer();
    expect(screen.getByRole('button', { name: '分色' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('操作面板可以整个隐藏，也能再叫回来', async () => {
    await renderViewer();
    fireEvent.click(screen.getByRole('button', { name: '隐藏操作面板' }));
    expect(screen.queryByText('机身')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '三维面板' }));
    await screen.findByText('机身');
  });

  it('全屏时只剩模型：操作面板不出现', async () => {
    await renderViewer({ fullscreen: true });
    expect(screen.queryByRole('button', { name: '隐藏操作面板' })).toBeNull();
    expect(screen.queryByRole('button', { name: '三维面板' })).toBeNull();
  });

  it('取不到模型时说人话，不留一块空白', async () => {
    const onError = vi.fn();
    stage.state.error = new Error('三维转换失败：这份 STEP 里没有实体几何');
    render(<ArtifactModelViewer src="/api/artifacts/a1/viewer" alt="装配体" onError={onError} />);

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(screen.getByText(/没有实体几何/)).toBeTruthy();
  });

  it('模型里一个面都没有时，说清楚是源文件空', async () => {
    stage.state.parts = [];
    stage.state.empty = true;
    await renderViewer();
    expect(screen.getByText(/没有实体几何/)).toBeTruthy();
  });

  it('只有一个零件时，拆不了就说清楚，不给按了没反应的东西', async () => {
    stage.state.parts = [{ id: 'p1', name: '整块', vertexCount: 100, textured: false, color: '#3b6ea5' }];
    await renderViewer();
    expect(screen.getByText(/只有一个整体/)).toBeTruthy();
    expect((screen.getByLabelText('爆炸程度') as HTMLInputElement).disabled).toBe(true);
  });
});
