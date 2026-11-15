// @vitest-environment jsdom
// 成果台里三维分支的行为。
//
// 这里只验「外层怎么管三维」：模型走统一的 /viewer 口、全屏时只剩模型、
// 复位视角与自动旋转这些动作要送到展示台。全屏这一条尤其要盯：以前是
// 「工具条进全屏、按钮留在外面」，现在要求全屏后只剩模型。

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
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
  default: ({ src, fullscreen }: { src: string; fullscreen?: boolean }) => (
    <div data-testid="model-viewer" data-src={src} data-fullscreen={String(Boolean(fullscreen))} />
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

function Harness() {
  const draft = useRef<Draft | null>(null);
  return (
    <ThemeProvider>
      <ArtifactStage
        artifact={artifact}
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
    // 展示台是按需加载的（three 那一坨不塞进主包），要等它自己加载完。
    const viewer = await screen.findByTestId('model-viewer');
    expect(viewer.getAttribute('data-src')).toBe('/api/artifacts/a1/viewer');
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
  });

  it('退出全屏：工具条回来', async () => {
    render(<Harness />);
    await screen.findByTestId('model-viewer');
    fireEvent.click(screen.getByRole('button', { name: '全屏' }));
    fireEvent.click(screen.getByRole('button', { name: '退出全屏' }));

    expect(screen.getByRole('button', { name: '自动旋转' })).toBeTruthy();
    expect(screen.getByTestId('model-viewer').getAttribute('data-fullscreen')).toBe('false');
  });
});
