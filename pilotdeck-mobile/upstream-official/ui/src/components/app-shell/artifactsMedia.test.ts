import { afterEach, expect, it, vi } from 'vitest';
import {
  artifactTypeFacets,
  artifactViewerUrl,
  compareGroup,
  isCadArtifact,
  isEditableDocument,
  isUnconvertible3d,
  loadSessionArtifacts,
  mediaType,
  ownsSession,
  scopeArtifacts,
  scopeCounts,
} from './artifactsMedia';
import type { Artifact } from './artifactsMedia';

const artifact = (extra: Partial<Artifact> = {}) =>
  ({ id: 'art_x', kind: 'model3d', file_name: 'part.glb', ...extra }) as Artifact;

afterEach(() => vi.unstubAllGlobals());

it('matches bare and qualified IDs in either direction without crossing channels', () => {
  expect(ownsSession('logo', 'web:logo')).toBe(true);
  expect(ownsSession('web:logo', 'logo')).toBe(true);
  expect(ownsSession('cli:logo', 'web:logo')).toBe(false);
});

it('loads a bare workspace session for the qualified selected conversation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ projects: [
    { sessions: [{ id: 'logo', artifacts: [{ id: 'art_logo' }] }] },
  ] }) }));
  expect(await loadSessionArtifacts('web:logo', new AbortController().signal)).toEqual([{ id: 'art_logo' }]);
});

it('asks the session query for the whole library, so old rounds do not fall off the window', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ projects: [] }) });
  vi.stubGlobal('fetch', fetchMock);
  await loadSessionArtifacts('web:logo', new AbortController().signal);
  const url = String(fetchMock.mock.calls[0][0]);
  expect(url).toContain('session=web%3Alogo');
  // 服务端的 limit 是「全库最近多少条」，默认 400 会把老成果挤掉。
  expect(url).toContain('limit=2000');
});

it('splits the workspace tree into session, project and all scopes', () => {
  const tree = [
    {
      name: 'project-1',
      displayName: 'PilotV',
      fullPath: '/vol3/1000/Work/00/PilotV',
      artifacts: [artifact({ id: 'direct-1' })],
      sessions: [
        { id: 'session-1', title: '当前对话', artifacts: [artifact({ id: 'a1' }), artifact({ id: 'a2' })] },
        { id: 'session-2', title: '另一个对话', artifacts: [artifact({ id: 'a3' })] },
      ],
    },
    {
      name: 'project-2',
      displayName: '别处',
      sessions: [{ id: 'session-3', title: '别的项目', artifacts: [artifact({ id: 'b1' })] }],
    },
  ];

  // 当前会话：带不带 web: 前缀都认同一个会话。
  expect(scopeArtifacts(tree, 'session', { sessionId: 'session-1' }).map(item => item.artifact.id)).toEqual(['a1', 'a2']);
  expect(scopeArtifacts(tree, 'session', { sessionId: 'web:session-1' }).map(item => item.artifact.id)).toEqual(['a1', 'a2']);
  // 本项目：跨会话，但不越到别的项目；项目直属的成果也算本项目的。
  expect(scopeArtifacts(tree, 'project', { projectName: 'project-1' }).map(item => item.artifact.id))
    .toEqual(['a1', 'a2', 'a3', 'direct-1']);
  // 全部对话：所有项目加起来。
  expect(scopeArtifacts(tree, 'all', {}).map(item => item.artifact.id)).toEqual(['a1', 'a2', 'a3', 'direct-1', 'b1']);
  // 跨会话时得带着归属，才知道这份成果是谁的。
  expect(scopeArtifacts(tree, 'all', {})[2].sessionTitle).toBe('另一个对话');
  expect(scopeCounts(tree, { sessionId: 'session-1', projectName: 'project-1' }))
    .toEqual({ session: 2, project: 4, all: 5 });
});

// 跨会话是翻档案：同一秒里批量发布的每一份都得在，不能只留最后一份。
// 折叠是会话内时间线的规矩，套到全库上会把真成果收没。
it('keeps every raw artifact in the cross-session scopes and orders them newest first', () => {
  const tree = [
    {
      name: 'project-1',
      displayName: 'PilotV',
      sessions: [
        { id: 'session-1', title: '当前对话', artifacts: [
          artifact({ id: 'a1', ts: '2026-10-01T00:00:00Z' }),
          artifact({ id: 'a2', ts: '2026-10-01T00:00:00Z' }),
          artifact({ id: 'a3', ts: '2026-10-01T00:00:00Z' }),
        ] },
        { id: 'session-2', title: '另一个对话', artifacts: [artifact({ id: 'b1', ts: '2026-10-02T00:00:00Z' })] },
      ],
    },
  ];

  // 最新的排前面；同一秒里的先后保持服务端给的样子。
  expect(scopeArtifacts(tree, 'project', { projectName: 'project-1' }).map(item => item.artifact.id))
    .toEqual(['b1', 'a1', 'a2', 'a3']);
  // 条数就是成果库里那份数：下拉上的数字和列表长度永远对得上。
  expect(scopeCounts(tree, { projectName: 'project-1' }).project).toBe(4);
});

it('keeps unassigned artifacts out of the project scope but inside the all scope', () => {  const tree = [
    { name: 'project-1', sessions: [{ id: 'session-1', artifacts: [artifact({ id: 'a1' })] }] },
    {
      name: '__unassigned__',
      displayName: '未归属',
      sessions: [{ id: '__unassigned__', title: '未归属', artifacts: [artifact({ id: 'x1' })] }],
    },
  ];
  expect(scopeArtifacts(tree, 'project', { projectName: 'project-1' }).map(item => item.artifact.id)).toEqual(['a1']);
  expect(scopeArtifacts(tree, 'all', {}).map(item => item.artifact.id)).toEqual(['a1', 'x1']);
});

it('treats STEP and IGES as 3D whatever kind the publisher declared', () => {
  expect(mediaType(artifact({ kind: 'drawing', file_name: 'bracket.STEP' }))).toBe('model3d');
  expect(mediaType(artifact({ kind: 'drawing', file_name: 'frame.stp' }))).toBe('model3d');
  expect(mediaType(artifact({ kind: 'model3d', file_name: 'frame.iges' }))).toBe('model3d');
  expect(mediaType(artifact({ kind: 'drawing', file_name: 'plan.dxf' }))).toBe('drawing');
  expect(mediaType(artifact({ kind: 'drawing', file_name: 'manual.pdf' }))).toBe('iframe');
  expect(mediaType(artifact({ kind: 'image', file_name: 'photo.png' }))).toBe('image');
});

it('points CAD artifacts at the converting viewer endpoint, not the raw STEP', () => {
  expect(isCadArtifact(artifact({ file_name: 'part.step' }))).toBe(true);
  expect(artifactViewerUrl(artifact({ file_name: 'part.step' })))
    .toBe('/api/artifacts/art_x/viewer');
  // model-viewer 只认 glTF/GLB，直接喂 STEP 只会得到一个空白的 300x150。
  expect(isCadArtifact(artifact({ file_name: 'part.glb' }))).toBe(false);
  expect(artifactViewerUrl(artifact({ file_name: 'part.glb' })))
    .toBe('/api/artifacts/art_x/raw');
});

it('encodes ids that need escaping when asking for the converted model', () => {
  expect(artifactViewerUrl(artifact({ id: 'art_a/b', file_name: 'p.igs' })))
    .toBe('/api/artifacts/art_a%2Fb/viewer');
});

// model-viewer 只认 glTF：网格格式同样得走转换口，否则页面上是一块空白。
it('routes mesh formats through the converting endpoint as well', () => {
  for (const name of ['part.stl', 'part.obj', 'mesh.ply']) {
    expect(isCadArtifact(artifact({ file_name: name }))).toBe(true);
    expect(artifactViewerUrl(artifact({ file_name: name })))
      .toBe('/api/artifacts/art_x/viewer');
    expect(mediaType(artifact({ kind: 'model3d', file_name: name }))).toBe('model3d');
  }
});

it('keeps unconvertible 3D formats out of the viewer but still downloadable', () => {
  for (const name of ['old.3ds', 'scene.dae', ['pack', '3mf'].join('.'), 'model.blend']) {
    expect(isUnconvertible3d(artifact({ file_name: name }))).toBe(true);
    // 不进 /viewer：没转换器，转了也只是拿回原文件再报错一次。
    expect(artifactViewerUrl(artifact({ file_name: name })))
      .toBe('/api/artifacts/art_x/raw');
    // 但仍是三维成果，页面要给「下载原文件」的路，不能退化成「不认识」。
    expect(mediaType(artifact({ kind: 'model3d', file_name: name }))).toBe('model3d');
  }
  expect(isUnconvertible3d(artifact({ file_name: 'part.step' }))).toBe(false);
});

it('reads compare_group out of meta, trimmed, and ignores junk declarations', () => {
  expect(compareGroup(artifact({ entry: { meta: { compare_group: ' logo ' } } }))).toBe('logo');
  expect(compareGroup(artifact({ entry: { meta: { compare_group: '   ' } } }))).toBe('');
  expect(compareGroup(artifact({ entry: { meta: { compare_group: 12 } } }))).toBe('');
  expect(compareGroup(artifact())).toBe('');
});

it('groups a mixed batch into fixed-order type facets with counts', () => {
  const items = [
    artifact({ id: '1', kind: 'image', file_name: 'cover.png' }),
    artifact({ id: '2', kind: 'image', file_name: 'shot.jpg' }),
    artifact({ id: '3', kind: 'doc', file_name: 'notes.md' }),
    artifact({ id: '4', kind: 'model3d', file_name: 'part.step' }),
    artifact({ id: '5', kind: 'video', file_name: 'demo.mp4' }),
  ];
  expect(artifactTypeFacets(items)).toEqual([
    { value: 'image', label: '图片', count: 2 },
    // markdown 自己一类：它得渲染，不能跟着纯文本一起以源码形式显示。
    { value: 'markdown', label: 'Markdown', count: 1 },
    { value: 'video', label: '视频', count: 1 },
    { value: 'model3d', label: '三维模型', count: 1 },
  ]);
  // 空的批次没有可筛的类型，调用方据此不必摆下拉。
  expect(artifactTypeFacets([])).toEqual([]);
});

// 浏览器不渲染 text/markdown：塞进 iframe 出来的是一堆 # 和 **。
it('keeps markdown out of the iframe bucket', () => {
  expect(mediaType(artifact({ kind: 'doc', file_name: 'README.md' }))).toBe('markdown');
  expect(mediaType(artifact({ kind: 'doc', file_name: 'report.markdown' }))).toBe('markdown');
  expect(mediaType(artifact({ kind: 'doc', mime: 'text/markdown', file_name: 'notes' }))).toBe('markdown');
  // 纯文本仍然是老样子（浏览器会照原样显示它）。
  expect(mediaType(artifact({ kind: 'doc', file_name: 'notes.txt' }))).toBe('iframe');
  expect(mediaType(artifact({ kind: 'doc', file_name: 'rows.csv' }))).toBe('iframe');
});

// 可编辑入口的后缀必须和后端 EDITABLE_EXT 对上：多一个必然吃 415，
// 少一个则是后端能改、前端看不出来能改。
it('offers in-place editing only for document bodies the console can rewrite', () => {
  for (const name of ['README.md', 'page.html', 'notes.txt', 'data.json']) {
    expect(isEditableDocument(artifact({ kind: 'doc', file_name: name }))).toBe(true);
  }
  // 代码文件靠 mime 进「文档」那一类（后缀本身不在纯文本清单里）：
  // 也就是说发布方得老实报 text/*，否则它们仍然落到「其他」。
  expect(isEditableDocument(artifact({ kind: 'doc', mime: 'text/css', file_name: 'main.css' }))).toBe(true);
  expect(isEditableDocument(artifact({ kind: 'doc', mime: 'text/javascript', file_name: 'app.js' }))).toBe(true);
  expect(isEditableDocument(artifact({ kind: 'doc', mime: 'text/yaml', file_name: 'ci.yml' }))).toBe(true);
  for (const name of ['plan.pdf', 'photo.png', 'demo.mp4', 'part.step', 'sheet.csv', 'log.log']) {
    expect(isEditableDocument(artifact({ kind: 'doc', file_name: name }))).toBe(false);
  }
  // SVG 是文本，但成果台按图显示它，别在图上摆一个编辑器。
  expect(isEditableDocument(artifact({ kind: 'image', file_name: 'logo.svg' }))).toBe(false);
});
