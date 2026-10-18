// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../contexts/ThemeContext';
import ArtifactStage, { type Draft } from './ArtifactStage';
import type { Artifact } from './artifactsMedia';

if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key }),
}));

// 文档类成果要真去读 /api/artifacts/<id>/text：这里给一份固定正文，
// 免得测试去碰真网络（jsdom 里相对地址的 fetch 只会失败）。
const putText = (text: string) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => ({ artifact_id: 'a1', text, bytes: text.length, changed: { edited: false, added: 0, removed: 0 } }),
}));

const artifact: Artifact = {
  id: 'a1',
  session_id: 's1',
  project_name: 'PilotV',
  session_name: '设计 logo',
  kind: 'image',
  file_name: 'logo.png',
  source_path: 'design/logo/logo.png',
  preview_url: '/api/artifacts/a1/raw',
  created_at: '2026-10-14 10:00:00',
  mime: 'image/png',
} as Artifact;

function Harness({ override }: { override?: Partial<Artifact> }) {
  const draft = useRef<Draft | null>(null);
  const [current, setCurrent] = useState<Artifact>({ ...artifact, ...override });
  return (
    // 文档编辑器沿用项目编辑器那套主题/字号设置，所以要 ThemeProvider；
    // 没有它连渲染都到不了，测的就不是成果台而是抛异常了。
    <ThemeProvider>
      <button type="button" onClick={() => setCurrent({ ...artifact, id: 'a2' })}>换一份</button>
      <ArtifactStage
        artifact={current}
        annotations={[]}
        draft={draft.current}
        activeNoteId={null}
        draftBody=""
        draftError=""
        onDraft={value => { draft.current = value; }}
        onDraftBody={() => {}}
        onSaveDraft={() => {}}
        onCancelDraft={() => {}}
        onPickNote={() => {}}
        onSendInk={() => {}}
      />
    </ThemeProvider>
  );
}

beforeEach(() => {
  putText('');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ArtifactStage zoom', () => {
  it('starts fitted, and the toolbar shows the current ratio', () => {
    render(<Harness />);

    expect(screen.getByRole('group', { name: '成果缩放' })).toBeTruthy();
    expect(screen.getByTitle('适应屏幕').textContent).toBe('1×');
  });

  it('zooms in and out around the middle of the frame with the buttons', async () => {
    render(<Harness />);

    const zoomLabel = screen.getByTitle('适应屏幕');
    const before = zoomLabel.textContent;

    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    await waitFor(() => expect(zoomLabel.textContent).not.toBe(before));
    const zoomedIn = Number(String(zoomLabel.textContent).replace('×', ''));
    expect(zoomedIn).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole('button', { name: '缩小' }));
    await waitFor(() => expect(zoomLabel.textContent).toBe(before));
  });

  it('never zooms below fit and never past the ceiling', async () => {
    render(<Harness />);
    const zoomLabel = screen.getByTitle('适应屏幕');

    // 适应屏幕时不能再缩小，按钮要禁用。
    expect((screen.getByRole('button', { name: '缩小' }) as HTMLButtonElement).disabled).toBe(true);

    const bigger = screen.getByRole('button', { name: '放大' });
    for (let index = 0; index < 20; index += 1) fireEvent.click(bigger);
    await waitFor(() => expect((bigger as HTMLButtonElement).disabled).toBe(true));
    expect(Number(String(zoomLabel.textContent).replace('×', ''))).toBeLessThanOrEqual(8);
  });

  it('returns to fit from the ratio button', async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    const zoomLabel = screen.getByTitle('适应屏幕');
    await waitFor(() => expect(zoomLabel.textContent).not.toBe('1×'));

    fireEvent.click(zoomLabel);
    await waitFor(() => expect(zoomLabel.textContent).toBe('1×'));
  });

  it('zooms on a two-finger pinch even though the box tool is active', async () => {
    render(<Harness />);
    const frame = screen.getByTestId('artifact-frame');
    const zoomLabel = screen.getByTitle('适应屏幕');

    // 两指相距 100 落手，再拉到 200 —— 画面应该跟着放大。
    fireEvent.touchStart(frame, { touches: [{ clientX: 100, clientY: 100 }, { clientX: 200, clientY: 100 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 50, clientY: 100 }, { clientX: 250, clientY: 100 }] });
    await waitFor(() => expect(Number(String(zoomLabel.textContent).replace('×', ''))).toBeGreaterThan(1));
    const zoomedIn = Number(String(zoomLabel.textContent).replace('×', ''));

    fireEvent.touchEnd(frame, { touches: [] });

    // 同一段手势反向合回去，画面回到适应屏幕。
    fireEvent.touchStart(frame, { touches: [{ clientX: 50, clientY: 100 }, { clientX: 250, clientY: 100 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 100, clientY: 100 }, { clientX: 200, clientY: 100 }] });
    await waitFor(() => expect(zoomLabel.textContent).toBe('1×'));
    expect(zoomedIn).toBeGreaterThan(1);
  });

  it('keeps the offset free while the frame size is unknown', async () => {
    render(<Harness />);
    const frame = screen.getByTestId('artifact-frame');
    const zoomLabel = screen.getByTitle('适应屏幕');

    // jsdom 量不到布局尺寸。真实浏览器里尺寸是有的，但媒体还没加载完时同样是 0；
    // 这时候夹取会把画面焊死在中心，比不夹更糟。
    fireEvent.wheel(frame, { ctrlKey: true, deltaY: -240, clientX: 100, clientY: 100 });
    await waitFor(() => expect(zoomLabel.textContent).not.toBe('1×'));
    expect(zoomLabel.textContent).not.toBe('1×');
  });

it('zooms with ctrl + wheel and pans with a plain wheel once enlarged', async () => {
    render(<Harness />);
    const zoomLabel = screen.getByTitle('适应屏幕');
    const frame = screen.getByTestId('artifact-frame');

    fireEvent.wheel(frame, { ctrlKey: true, deltaY: -240, clientX: 100, clientY: 100 });
    await waitFor(() => expect(zoomLabel.textContent).not.toBe('1×'));

    // 适应屏幕下普通滚轮不应该把画面推走。
    fireEvent.wheel(frame, { ctrlKey: true, deltaY: 240, clientX: 100, clientY: 100 });
    await waitFor(() => expect(zoomLabel.textContent).toBe('1×'));
  });

  it('keeps pinch available even while the box tool is selected', async () => {
    render(<Harness />);
    const frame = screen.getByTestId('artifact-frame');
    // 框选模式下容器也要禁止浏览器手势，否则双指会被页面级缩放吃掉。
    expect((frame as HTMLElement).style.touchAction).toBe('none');
  });

  it('leaves the embedded page and the 3D model their own gestures', () => {
    render(<Harness override={{ kind: 'iframe', mime: 'text/html', file_name: 'page.html' } as Partial<Artifact>} />);

    // iframe 内部自己滚动，成果页不抢：没有缩放条，也不会接管触摸。
    expect(screen.queryByRole('group', { name: '成果缩放' })).toBeNull();
    const frame = screen.getByTestId('artifact-frame');
    expect((frame as HTMLElement).style.touchAction).toBe('');
  });

  it('pans one-to-one with the finger instead of running away on every frame', async () => {
    render(<Harness />);
    const frame = screen.getByTestId('artifact-frame');

    // 用工具栏的＋放大：它围着画面正中缩放，平移量还是 0，后面好按数字对账。
    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    const stage = frame.querySelector(':scope > .relative.shrink-0') as HTMLElement;
    expect(stage).toBeTruthy();
    await waitFor(() => expect(stage.style.transform).not.toBe(''));

    fireEvent.touchStart(frame, { touches: [{ clientX: 200, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 190, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 180, clientY: 200 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: 170, clientY: 200 }] });

    // 三帧各往左挪 10px，画面就该正好挪 30px。早先这里把「从落手到此刻」的
    // 累计位移反复叠在已经推走的当前值上（10+20+30=60px），手还停在画面中间，
    // 图已经飞到边上卡住不动了。
    expect(stage.style.transform).toBe('translate(-30px, 0px)');
    fireEvent.touchEnd(frame, { touches: [] });
  });

  it('resets the ratio when another artifact is selected', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    const zoomLabel = screen.getByTitle('适应屏幕');
    await waitFor(() => expect(zoomLabel.textContent).not.toBe('1×'));

    fireEvent.click(screen.getByRole('button', { name: '换一份' }));
    // 换一份就回到适应屏幕，否则新内容会停在上一份的倍率上，看起来像没加载。
    await waitFor(() => expect(zoomLabel.textContent).toBe('1×'));
  });

  it('opens every artifact in browse mode, and goes back to it after switching', async () => {
    render(<Harness />);

    // 看成果是只读动作：一进来就带着一支随时会落下的笔不是好默认。
    expect(screen.getByRole('button', { name: '浏览' }).getAttribute('aria-pressed')).toBe('true');

    // 手选过框选之后换一份成果，必须回到浏览 —— 否则「换一份还带着笔」
    // 会让人以为新成果上已经有一处标注了。
    fireEvent.click(screen.getByRole('button', { name: '框选' }));
    expect(screen.getByRole('button', { name: '框选' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '换一份' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '浏览' }).getAttribute('aria-pressed')).toBe('true'));
  });

  it('opens the empty sheet in ink mode, because that sheet is for drawing', () => {
    render(
      <ArtifactStage
        artifact={null}
        annotations={[]}
        draft={null}
        activeNoteId={null}
        draftBody=""
        draftError=""
        onDraft={() => {}}
        onDraftBody={() => {}}
        onSaveDraft={() => {}}
        onCancelDraft={() => {}}
        onPickNote={() => {}}
        onSendInk={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: '手绘' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('成果台里的文档', () => {
  const markdown: Partial<Artifact> = { kind: 'doc', file_name: 'README.md', mime: 'text/markdown' };

  it('把 markdown 渲染出来，而不是塞进 iframe 显示源码', async () => {
    putText('# 设计说明\n\n正文。');
    render(<Harness override={markdown} />);

    // 浏览器不渲染 text/markdown：源码进 iframe 只会看到一堆 # 和 **。
    expect(await screen.findByRole('heading', { name: '设计说明' })).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('给可改的文档一个「编辑」入口，进编辑态换成保存／退出编辑', async () => {
    putText('# 设计说明');
    render(<Harness override={markdown} />);

    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    expect(await screen.findByRole('button', { name: '保存' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '退出编辑' })).toBeTruthy();
    // 编辑态下框选／手绘是废键（笔迹会整块盖住编辑器），收起来才对。
    expect(screen.queryByRole('button', { name: '框选' })).toBeNull();
    expect(screen.queryByRole('button', { name: '手绘' })).toBeNull();
  });

  it('图片不摆「编辑」：那不是能改的正文', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  });

  it('保存只写回成果台副本（PUT /text），并说清原项目文件没动', async () => {
    const requests: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      requests.push([url, init]);
      return Promise.resolve(init?.method === 'PUT'
        ? { ok: true, status: 200, json: async () => ({ bytes: 9, changed: { edited: true, added: 2, removed: 1 } }) }
        : { ok: true, status: 200, json: async () => ({ text: '# 标题\n', bytes: 9, changed: { edited: false, added: 0, removed: 0 } }) });
    }));
    render(<Harness override={markdown} />);

    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    fireEvent.click(await screen.findByRole('button', { name: '保存' }));

    await waitFor(() => expect(requests.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const [url, init] = requests.find(([, request]) => request?.method === 'PUT') as [string, RequestInit];
    expect(url).toBe('/api/artifacts/a1/text');
    expect(JSON.parse(String(init.body))).toEqual({ text: '# 标题\n' });
    // 保存的是成果台的副本：评审改的是「审这一版」，落到项目里要另走应用 AI 修改。
    expect(await screen.findByText(/已保存到成果台副本（原项目文件未改动）/)).toBeTruthy();
  });

  it('HTML 仍然在沙箱 iframe 里预览，且不给 allow-same-origin', async () => {
    putText('<p>hi</p>');
    render(<Harness override={{ kind: 'iframe', mime: 'text/html', file_name: 'page.html' } as Partial<Artifact>} />);

    const iframe = await waitFor(() => {
      const node = document.querySelector('iframe');
      expect(node).toBeTruthy();
      return node as HTMLIFrameElement;
    });
    expect(iframe.getAttribute('src')).toContain('/api/artifacts/a1/raw');
    // allow-same-origin 和 allow-scripts 同时存在等于没沙箱：成果脚本能从父页面
    // 把 sandbox 摘掉再 reload。少了它文档才落在「不透明源」。
    const sandbox = iframe.getAttribute('sandbox') || '';
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    // 可改的 HTML 照样给编辑入口。
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
  });

  // /text 会拒收一些文档（超过 2MB、后缀不在可编辑清单里）。这些以前是看得见的
  // —— 那时走的是 /raw 的 iframe。把这条旧路留着当兜底，成果才不会被「读不出正文」
  // 说得像是丢了。
  it('读不到正文时预览退回沙箱 iframe 显示原文件，而不是整块报错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 415, json: async () => ({ error: '.html 不在可直接编辑的文本类型里' }),
    }));
    render(<Harness override={{ kind: 'iframe', mime: 'text/html', file_name: 'page.html' } as Partial<Artifact>} />);

    expect((await screen.findByRole('alert')).textContent).toContain('下面显示的是原文件');
    const iframe = document.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toContain('/api/artifacts/a1/raw');
    // 兜底也不能变成漏气的那条路：allow-same-origin 照样不给。
    expect(iframe?.getAttribute('sandbox') || '').not.toContain('allow-same-origin');
  });

  // 就地编辑不进版本链，unified diff 是「在成果台里改了什么」唯一的记录。
  it('把相对发布时的改动摆出来', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        artifact_id: 'a1', text: '# 标题\n', bytes: 9,
        changed: { edited: true, added: 1, removed: 1, diff: '--- 发布时\n+++ 成果台内编辑\n-旧\n+新', truncated: false },
      }),
    }));
    render(<Harness override={markdown} />);

    expect(await screen.findByText(/相对发布时的改动/)).toBeTruthy();
    // diff 是文档正文，拼成文本节点而不是 innerHTML：谁写的标记都不在这里生效。
    expect(document.querySelector('details pre')?.textContent).toContain('+新');
  });
});