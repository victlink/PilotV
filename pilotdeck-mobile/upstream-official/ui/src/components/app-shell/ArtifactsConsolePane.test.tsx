// @vitest-environment jsdom
import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ArtifactsConsolePane from './ArtifactsConsolePane';

// jsdom 既没有 ResizeObserver，也没有 canvas 后端；这里只补上形状，不测绘图本身。
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const artifact = (id: string, title: string) => ({
  id,
  run_id: 'session-1',
  title,
  file_name: `${id}.png`,
  kind: 'image',
  mime_type: 'image/png',
  status: 'ready',
  path: `/api/artifacts/${id}/raw`,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
});

const loadSessionArtifacts = vi.fn<(sessionId: string, signal?: AbortSignal) => Promise<unknown[]>>();
const attachInkAndSubmit = vi.fn(async (_blob: Blob, _text?: string) => true);

vi.mock('./artifactsMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./artifactsMedia')>()),
  loadSessionArtifacts: (sessionId: string, signal?: AbortSignal) =>
    loadSessionArtifacts(sessionId, signal),
}));

vi.mock('./artifactAnnotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./artifactAnnotations')>()),
  createAnnotation: vi.fn(),
  deleteAnnotation: vi.fn(),
  fetchArtifactDetail: vi.fn(async () => ({ annotations: [] })),
  setAnnotationStatus: vi.fn(),
}));

// jsdom 没有 canvas 后端，指针事件也算不出真实坐标，所以直接把一笔交出去，
// 再交一张有尺寸的画布给父组件：要验的是「画完 → 送到新对话」这条链路，
// 不是 InkOverlay 的手感，也不是 PNG 编码。画布收到的笔迹和当前笔色照样
// 记下来 —— 空白页「画完看不到」正是这条回灌链路断了。
vi.mock('./InkOverlay', () => ({
  // 名字必须是大写开头，否则 eslint 的 rules-of-hooks 会把这个替身当成普通函数。
  default: function InkOverlayMock({
    onCommit,
    onCanvas,
    strokes,
    color,
  }: {
    onCommit: (stroke: unknown) => void;
    onCanvas?: (canvas: HTMLCanvasElement | null) => void;
    strokes?: Array<{ color: string }>;
    color?: string;
  }) {
    useEffect(() => {
      onCanvas?.({ width: 800, height: 600 } as HTMLCanvasElement);
    }, [onCanvas]);
    return (
      <span>
        <span data-testid="fake-ink-count">{strokes?.length ?? 0}</span>
        <span data-testid="fake-ink-color">{strokes?.[strokes.length - 1]?.color ?? color ?? ''}</span>
        <button type="button" data-testid="fake-stroke" onClick={() => onCommit({
          color: color || '#000', w: 0.004, points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.3 }],
        })}>画一笔</button>
      </span>
    );
  },
}));

vi.mock('./artifactInk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./artifactInk')>()),
  exportStagePng: vi.fn(async () => new Blob(['png-bytes'], { type: 'image/png' })),
}));

vi.mock('./artifactFeedback', () => ({
  appendInkToComposer: vi.fn(),
  appendToComposer: vi.fn(),
  attachInkAndSubmit: (blob: Blob, text?: string) => attachInkAndSubmit(blob, text),
  buildComposerText: vi.fn(),
}));

afterEach(() => {
  cleanup();
  loadSessionArtifacts.mockReset();
  attachInkAndSubmit.mockReset();
});

describe('成果台浮动控制条', () => {
  it('把工具和翻页浮在成果上方，顶部只留标题栏，并且不再提示滑动翻页', async () => {
    loadSessionArtifacts.mockResolvedValue([
      artifact('a1', '第一张图'),
      artifact('a2', '第二张图'),
    ]);

    render(<ArtifactsConsolePane sessionId="session-1" />);

    const toolbar = await screen.findByRole('group', { name: '成果操作' });
    expect(within(toolbar).getByRole('button', { name: '框选' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: '手绘' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: '浏览' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: '上一步' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: '下一步' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: '刷新' })).toBeTruthy();
    expect(within(toolbar).getByText('1 / 2')).toBeTruthy();

    // 浮条叠在画面上沿，不占版面。
    expect(toolbar.parentElement?.className).toContain('absolute');
    expect(toolbar.parentElement?.className).toContain('pointer-events-none');

    // 标题栏是成果选择器，成果上方不再有第二排控件，也不再劝用户滑动翻页。
    expect(screen.getByLabelText('选择成果')).toBeTruthy();
    expect(screen.queryByText(/滑动/)).toBeNull();

    fireEvent.click(within(toolbar).getByRole('button', { name: '下一步' }));
    await waitFor(() => expect(within(toolbar).getByText('2 / 2')).toBeTruthy());
  });
});

describe('没有选中对话时的手绘页', () => {
  it('提供草稿纸和「发送到新对话」，并且不拉取任何会话成果', async () => {
    const onStartNewConversation = vi.fn();
    render(<ArtifactsConsolePane onStartNewConversation={onStartNewConversation} />);

    expect(screen.getByText(/没有选中对话/)).toBeTruthy();
    expect(loadSessionArtifacts).not.toHaveBeenCalled();

    const toolbar = screen.getByRole('group', { name: '成果操作' });
    // 草稿纸上只有手绘可用，框选会留下一个删不掉的空框。
    expect(within(toolbar).getByRole('button', { name: '手绘' })).toBeTruthy();
    expect(within(toolbar).queryByRole('button', { name: '框选' })).toBeNull();
    // 还没落笔时不该出现发送按钮。
    expect(screen.queryByRole('button', { name: /发送到新对话/ })).toBeNull();
  });

  it('画完后新建对话并把草图发进输入框通道', async () => {
    const onStartNewConversation = vi.fn();
    render(<ArtifactsConsolePane onStartNewConversation={onStartNewConversation} />);

    fireEvent.click(screen.getByTestId('fake-stroke'));

    const sendButton = await screen.findByRole('button', { name: '发送到新对话' });
    fireEvent.click(sendButton);

    await waitFor(() => expect(attachInkAndSubmit).toHaveBeenCalledTimes(1));
    expect(onStartNewConversation).toHaveBeenCalledTimes(1);
    const blob = attachInkAndSubmit.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toContain('png');
  });

  it('刚落笔的草稿笔迹留在画布上，不会因为没保存就消失', async () => {
    render(<ArtifactsConsolePane onStartNewConversation={vi.fn()} />);

    expect(screen.getByTestId('fake-ink-count').textContent).toBe('0');
    fireEvent.click(screen.getByTestId('fake-stroke'));
    await waitFor(() => expect(screen.getByTestId('fake-ink-count').textContent).toBe('1'));
    // 撤销之后画布才真的清空。
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    await waitFor(() => expect(screen.getByTestId('fake-ink-count').textContent).toBe('0'));
  });
});

describe('按文件类型筛选', () => {
  beforeEach(() => window.localStorage.clear());

  const doc = (id: string, title: string) => ({ ...artifact(id, title), kind: 'doc', file_name: `${id}.md` });
  const video = (id: string, title: string) => ({ ...artifact(id, title), kind: 'video', file_name: `${id}.mp4` });
  const model = (id: string, title: string) => ({ ...artifact(id, title), kind: 'model3d', file_name: `${id}.glb` });
  const mixed = () => [artifact('a1', '封面图'), doc('a2', '说明文档'), video('a3', '演示视频'), model('a4', '法兰模型')];
  const optionTexts = (label: string) =>
    within(screen.getByLabelText(label)).getAllByRole('option').map(option => option.textContent);

  it('只有一种类型时照样摆下拉：位置统一，不会看着像这个会话的筛选坏了', async () => {
    loadSessionArtifacts.mockResolvedValue([artifact('a1', '第一张图'), artifact('a2', '第二张图')]);

    render(<ArtifactsConsolePane sessionId="session-1" />);

    await screen.findByLabelText('按类型筛选');
    // 数量写在选项里，一眼能看出这个会话只有这一类。
    expect(optionTexts('按类型筛选')).toEqual(['全部类型（2）', '图片（2）']);
    expect(optionTexts('选择成果')).toHaveLength(2);
  });

  it('多种类型时给出带数量的类型下拉，筛完只列该类型并补上总数', async () => {
    loadSessionArtifacts.mockResolvedValue(mixed());

    render(<ArtifactsConsolePane sessionId="session-1" />);

    const filter = await screen.findByLabelText('按类型筛选');
    expect(optionTexts('按类型筛选')).toEqual(['全部类型（4）', '图片（1）', '网页 / 文档（1）', '视频（1）', '三维模型（1）']);

    fireEvent.change(filter, { target: { value: 'image' } });
    await waitFor(() => expect(optionTexts('选择成果')).toEqual(['1. 封面图']));

    // 筛着看的时候「1 / 1」会让人以为整个会话只有一份，所以把总数也写出来。
    expect(within(screen.getByRole('group', { name: '成果操作' })).getByText('1 / 1（共 4）')).toBeTruthy();
  });

  it('翻页只在筛出来的成果里走', async () => {
    loadSessionArtifacts.mockResolvedValue([
      artifact('a1', '封面图'), video('a2', '演示视频'), video('a3', '第二段视频'),
    ]);

    render(<ArtifactsConsolePane sessionId="session-1" />);

    fireEvent.change(await screen.findByLabelText('按类型筛选'), { target: { value: 'video' } });
    await waitFor(() => expect(optionTexts('选择成果')).toHaveLength(2));
    expect(within(screen.getByRole('group', { name: '成果操作' })).getByText('1 / 2（共 3）')).toBeTruthy();

    fireEvent.click(within(screen.getByRole('group', { name: '成果操作' })).getByRole('button', { name: '下一步' }));
    await waitFor(() => expect((screen.getByLabelText('选择成果') as HTMLSelectElement).value).toBe('a3'));
    expect(within(screen.getByRole('group', { name: '成果操作' })).getByText('2 / 2（共 3）')).toBeTruthy();
  });

  it('记住上次选的类型', async () => {
    loadSessionArtifacts.mockResolvedValue(mixed());

    const first = render(<ArtifactsConsolePane sessionId="session-1" />);
    fireEvent.change(await screen.findByLabelText('按类型筛选'), { target: { value: 'video' } });
    await waitFor(() => expect((screen.getByLabelText('按类型筛选') as HTMLSelectElement).value).toBe('video'));
    first.unmount();

    render(<ArtifactsConsolePane sessionId="session-1" />);
    const reopened = await screen.findByLabelText('按类型筛选') as HTMLSelectElement;
    expect(reopened.value).toBe('video');
    expect(optionTexts('选择成果')).toEqual(['1. 演示视频']);
  });

  it('记住的类型在这个会话没有对应成果时退回全部，不给一块空白画面', async () => {
    window.localStorage.setItem('pdconsole.artifacttype.v1', 'video');
    loadSessionArtifacts.mockResolvedValue([artifact('a1', '封面图'), doc('a2', '说明文档')]);

    render(<ArtifactsConsolePane sessionId="session-1" />);

    const filter = await screen.findByLabelText('按类型筛选');
    expect((filter as HTMLSelectElement).value).toBe('');
    expect(optionTexts('选择成果')).toHaveLength(2);
  });
});

describe('手绘笔迹颜色', () => {
  it('手绘时提供常用颜色，选中的颜色用于之后新画的笔', async () => {
    render(<ArtifactsConsolePane onStartNewConversation={vi.fn()} />);

    const palette = screen.getByRole('group', { name: '笔迹颜色' });
    expect(within(palette).getByRole('button', { name: '笔迹颜色：红' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(palette).getByRole('button', { name: '笔迹颜色：蓝' }));
    await waitFor(() => expect(within(palette).getByRole('button', { name: '笔迹颜色：蓝' }).getAttribute('aria-pressed')).toBe('true'));
    expect(within(palette).getByRole('button', { name: '笔迹颜色：红' }).getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByTestId('fake-stroke'));
    await waitFor(() => expect(screen.getByTestId('fake-ink-color').textContent).toBe('#0091ff'));
  });

  it('框选和浏览不显示颜色选择', async () => {
    loadSessionArtifacts.mockResolvedValue([artifact('a1', '第一张图')]);
    render(<ArtifactsConsolePane sessionId="session-1" />);

    const toolbar = await screen.findByRole('group', { name: '成果操作' });
    // 成果页默认停在框选，颜色只在手绘时出现。
    expect(within(toolbar).queryByRole('group', { name: '笔迹颜色' })).toBeNull();
    fireEvent.click(within(toolbar).getByRole('button', { name: '手绘' }));
    await waitFor(() => expect(within(toolbar).getByRole('group', { name: '笔迹颜色' })).toBeTruthy());
  });
});