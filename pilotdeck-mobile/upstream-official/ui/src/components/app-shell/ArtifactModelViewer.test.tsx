// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ArtifactModelViewer from './ArtifactModelViewer';
import { parseGlb, serializeGlb, type GltfJson } from './artifactModel3d';

function assemblyJson(partCount: number): GltfJson {
  const nodes: GltfJson['nodes'] = [];
  const meshes: NonNullable<GltfJson['meshes']> = [];
  const accessors: NonNullable<GltfJson['accessors']> = [];
  const roots: number[] = [];
  for (let i = 0; i < partCount; i += 1) {
    roots.push(i);
    nodes.push({ name: `part-${i}`, mesh: i, translation: [i * 10, 0, 0] });
    meshes.push({ name: `part-${i}`, primitives: [{ attributes: { POSITION: i } }] });
    accessors.push({
      componentType: 5126,
      count: 1,
      type: 'VEC3',
      min: [i * 10 - 1, -1, -1],
      max: [i * 10 + 1, 1, 1],
    });
  }
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: roots }],
    nodes,
    meshes,
    accessors,
    materials: [{ name: 'cad', pbrMetallicRoughness: { baseColorFactor: [0.3, 0.34, 0.4, 1] } }],
    buffers: [{ byteLength: 0 }],
    bufferViews: [],
  };
}

function glbOf(partCount: number): Uint8Array<ArrayBuffer> {
  return serializeGlb({ json: assemblyJson(partCount), bin: new Uint8Array(0) });
}

let blobs: Blob[] = [];

function installFetch(partCount: number) {
  const bytes = glbOf(partCount);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }));
}

beforeEach(() => {
  blobs = [];
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => { blobs.push(blob); return `blob:model-${blobs.length}`; },
    revokeObjectURL: () => undefined,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function lastModel() {
  const blob = blobs[blobs.length - 1];
  if (!blob) return null;
  return parseGlb(await blob.arrayBuffer());
}

async function openPanel() {
  const toggle = await screen.findByRole('button', { name: /三维操作/ });
  fireEvent.click(toggle);
}

describe('成果台的三维展示台', () => {
  it('所有三维都走这一个组件：渲染器、控制条、零件清单都在', async () => {
    installFetch(2);
    render(<ArtifactModelViewer src="/api/artifacts/a1/viewer" alt="装配体" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /三维操作/ })).toBeTruthy());
    expect(document.querySelector('model-viewer')).toBeTruthy();

    await openPanel();
    await waitFor(() => expect(screen.getByText('part-0')).toBeTruthy());
    expect(screen.getByText('part-1')).toBeTruthy();
  });

  it('爆炸滑块一动，模型就重新打包一次，零件真的散开了', async () => {
    installFetch(2);
    render(<ArtifactModelViewer src="/api/artifacts/a1/viewer" alt="装配体" />);
    await openPanel();

    const slider = await screen.findByLabelText('爆炸程度');
    fireEvent.change(slider, { target: { value: '100' } });

    await waitFor(() => expect(blobs.length).toBeGreaterThan(0));
    const model = await lastModel();
    const translations = (model?.json.nodes ?? []).map(node => node.translation as number[]);
    expect(translations[0][0]).toBeLessThan(0);
    expect(translations[1][0]).toBeGreaterThan(0);
  });

  it('隐藏零件：被藏的那件从场景里摘掉', async () => {
    installFetch(2);
    render(<ArtifactModelViewer src="/api/artifacts/a1/viewer" alt="装配体" />);
    await openPanel();

    await screen.findByText('part-1');
    const row = screen.getByText('part-1').closest('div')!;
    fireEvent.click(row.querySelector('button[aria-pressed="false"]')!);

    await waitFor(() => expect(blobs.length).toBeGreaterThan(0));
    const model = await lastModel();
    expect(model?.json.scenes?.[0].nodes).toEqual([0]);
  });

  it('只有一个零件时，拆不了就说清楚，不给按了没反应的东西', async () => {
    installFetch(1);
    render(<ArtifactModelViewer src="/api/artifacts/a1/viewer" alt="一整块" />);
    await openPanel();

    await waitFor(() => expect(screen.getByText(/只有一个整体/)).toBeTruthy());
    expect((screen.getByLabelText('爆炸程度') as HTMLInputElement).disabled).toBe(true);
  });

  it('取不到模型时不白屏：还是把渲染器摆出来', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    render(<ArtifactModelViewer src="/api/artifacts/a1/viewer" alt="装配体" />);
    expect(document.querySelector('model-viewer')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /三维操作/ })).toBeNull());
  });
});
