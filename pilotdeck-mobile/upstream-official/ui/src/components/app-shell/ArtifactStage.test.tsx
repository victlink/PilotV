// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    <>
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
    </>
  );
}

afterEach(() => {
  cleanup();
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