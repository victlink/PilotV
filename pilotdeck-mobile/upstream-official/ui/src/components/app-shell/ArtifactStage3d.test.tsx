// @vitest-environment jsdom
// 成果台里三维分支的行为。
//
// 这里只验「外层怎么管三维」：模型走统一的 /viewer 口、工具条能收成图标、
// 全屏时只剩模型、三维零件标注能变成一条挂在零件上的说明。全屏这一条尤其
// 要盯：以前是「工具条进全屏、按钮留在外面」，现在要求全屏后只剩模型。

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useCallback, useState } from 'react';
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

// three 在 jsdom 里没有 WebGL，渲染层换成占位组件：这里要验的是外层怎么管它。
vi.mock('./ArtifactModelViewer', () => ({
  default: (props: {
    src: string;
    fullscreen?: boolean;
    focusPart?: string | null;
    onAnnotatePart?: (target: { id: string; name: string; rect: { x: number; y: number; w: number; h: number } }) => void;
  }) => (
    <div
      data-testid="model-viewer"
      data-src={props.src}
      data-fullscreen={String(Boolean(props.fullscreen))}
      data-focus={props.focusPart || ''}
    >
      <button
        type="button"
        onClick={() => props.onAnnotatePart?.({ id: 'p1', name: '机身', rect: { x: 0.1, y: 0.2, w: 0.03, h: 0.03 } })}
      >
        标注这个零件
      </button>
    </div>
  ),
}));

const artifact: Artifact = {
  id: 'a1',
  session_id: 's1',
  project_name: 'PilotV',
  session_name: '装配体',
  kind: 'model3d',
  file_name: 'assembly.step',
  source_path: 'design/assembly.step',
  preview_url: '/api/artifacts/a1/raw',
  created_at: '2026-11-15 10:00:00',
  mime: 'application/octet-stream',
} as Artifact;

let lastDraft: Draft = null;

function Harness() {
  // 草稿要用 state：ref 改了不会重渲染，成果台看不到新草稿，草稿条也就不会
  // 冒出来（这正是要验的东西）。
  const [draft, setDraft] = useState<Draft>(null);
  // onDraft 必须稳定：成果台在「换一份成果」时会用它清空草稿，回调一变就重跑。
  const onDraft = useCallback((value: Draft) => { setDraft(value); lastDraft = value; }, []);
  return (
    <ThemeProvider>
      <ArtifactStage
        artifact={artifact}
        annotations={[]}
        draft={draft}
        activeNoteId={null}
        draftBody=""
        draftError=""
        onDraft={onDraft}
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
  lastDraft = null;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ artifact_id: 'a1', text: '', bytes: 0 }),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('成果台的三维分支', () => {
  it('三维成果走统一的 /viewer 口', async () => {
    render(<Harness />);
    const viewer = await screen.findByTestId('model-viewer');
    expect(viewer.getAttribute('data-src')).toBe('/api/artifacts/a1/viewer');
  });

  it('成果台工具能收成一个图标，点它再展开', async () => {
    render(<Harness />);
    await screen.findByTestId('model-viewer');
    expect(screen.getByRole('button', { name: '自动旋转' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '收起工具' }));
    expect(screen.queryByRole('button', { name: '自动旋转' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '成果台工具' }));
    expect(screen.getByRole('button', { name: '自动旋转' })).toBeTruthy();
  });

  it('全屏：工具条收起来，只剩模型，并留一个退出按钮', async () => {
    render(<Harness />);
    await screen.findByTestId('model-viewer');
    expect(screen.getByRole('button', { name: '自动旋转' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '全屏' }));

    // 全屏后：工具条里的三维按钮没了，展示台知道自己在全屏（面板收起）。
    expect(screen.queryByRole('button', { name: '自动旋转' })).toBeNull();
    expect(screen.getByTestId('model-viewer').getAttribute('data-fullscreen')).toBe('true');
    expect(screen.getByRole('button', { name: '退出全屏' })).toBeTruthy();
    // 但工具还在：收成了一个图标，想调什么随时能点开。
    expect(screen.getByRole('button', { name: '成果台工具' })).toBeTruthy();
  });

  it('退出全屏：工具条回来', async () => {
    render(<Harness />);
    await screen.findByTestId('model-viewer');
    fireEvent.click(screen.getByRole('button', { name: '全屏' }));
    fireEvent.click(screen.getByRole('button', { name: '退出全屏' }));

    expect(screen.getByRole('button', { name: '自动旋转' })).toBeTruthy();
    expect(screen.getByTestId('model-viewer').getAttribute('data-fullscreen')).toBe('false');
  });

  it('在零件上写说明：草稿里带上零件本身', async () => {
    render(<Harness />);
    await screen.findByTestId('model-viewer');

    fireEvent.click(screen.getByRole('button', { name: '标注这个零件' }));

    expect(lastDraft?.part?.id).toBe('p1');
    expect(lastDraft?.part?.name).toBe('机身');
    expect(lastDraft?.rect?.x).toBeCloseTo(0.1);
    // 草稿条要写清楚是在给哪个零件写说明（jsdom 没有 innerText，用 textContent）。
    expect(document.body.textContent).toContain('零件 机身');
  });
});
