import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { artifactRawUrl, mediaType, type Artifact } from './artifactsMedia';
import {
  annotationRect,
  annotationStrokes,
  isDrag,
  rectAt,
  rectFromDrag,
  type Annotation,
  type Rect,
} from './artifactAnnotations';
import InkOverlay from './InkOverlay';
import { exportStagePng, type InkStroke } from './artifactInk';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  canPan,
  clampPan,
  clampZoom,
  formatZoom,
  panBy,
  pinchZoom,
  touchDistance,
  touchMidpoint,
  zoomAt,
  type PinchStart,
  type StageViewport,
} from './artifactStageViewport';

const MODEL_VIEWER_SRC = '/artifacts-static/vendor/model-viewer.min.js';
// Serves model-viewer from the sidecar (it is not on npm here); the viewer tag is
// custom, so it must be registered before any <model-viewer> renders.
let modelViewerLoader: Promise<void> | null = null;
function loadModelViewer(): Promise<void> {
  if (!modelViewerLoader) {
    modelViewerLoader = (async () => {
      if ((window as unknown as { customElements?: { get: (name: string) => unknown } }).customElements?.get('model-viewer')) return;
      await import(/* @vite-ignore */ MODEL_VIEWER_SRC);
    })().catch(error => { modelViewerLoader = null; throw error; });
  }
  return modelViewerLoader;
}

export type Draft = { rect?: Rect | null; strokes?: InkStroke[] | null; t?: number | null } | null;

/** 框选 keeps an exact region and a video timestamp; 手绘 takes pen or finger. */
export type Tool = 'box' | 'ink' | 'browse';

// 笔迹默认红色，但单一颜色在深色成果和截图上经常看不见，所以给一排可切换的
// 常用色：颜色只影响之后新画的笔，已经保存的笔迹各自带着自己的颜色。
const INK_COLORS: Array<{ value: string; label: string }> = [
  { value: '#e5484d', label: '红' },
  { value: '#f76b15', label: '橙' },
  { value: '#f5d90a', label: '黄' },
  { value: '#30a46c', label: '绿' },
  { value: '#0091ff', label: '蓝' },
  { value: '#1c2024', label: '黑' },
  { value: '#ffffff', label: '白' },
];
const INK_COLOR = INK_COLORS[0].value;
const INK_WIDTH = 0.005;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

type Props = {
  artifact: Artifact | null;
  annotations: Annotation[];
  draft: Draft;
  activeNoteId: string | null;
  draftBody: string;
  draftError: string;
  onDraft: (draft: Draft) => void;
  onDraftBody: (body: string) => void;
  onSaveDraft: () => void;
  onCancelDraft: () => void;
  onPickNote: (noteId: string) => void;
  onSendInk: (blob: Blob) => void;
  /** 浮动按键条右侧的翻页／刷新等控件，由外层按当前成果列表填。 */
  navigation?: ReactNode;
  /** 没有选中对话时这是一张草稿纸：没有成果可标注，也不该出现「保存标注」。 */
  sketchOnly?: boolean;
  sendLabel?: string;
};

const mergeRefs = <T,>(...refs: Array<{ current: T | null }>) => (node: T | null) => {
  refs.forEach(ref => { ref.current = node; });
};

const mediaWidth = (media: HTMLElement) => (
  media instanceof HTMLImageElement ? media.naturalWidth
    : media instanceof HTMLVideoElement ? media.videoWidth
      : media.clientWidth || 1);

const mediaHeight = (media: HTMLElement) => (
  media instanceof HTMLImageElement ? media.naturalHeight
    : media instanceof HTMLVideoElement ? media.videoHeight
      : media.clientHeight || 1);

export default function ArtifactStage({
  artifact, annotations, draft, activeNoteId, draftBody, draftError,
  onDraft, onDraftBody, onSaveDraft, onCancelDraft, onPickNote, onSendInk,
  navigation, sketchOnly = false, sendLabel = '手绘发到对话',
}: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ fromX: number; fromY: number } | null>(null);
  const [viewerError, setViewerError] = useState('');
  const [videoTime, setVideoTime] = useState(0);
  const [videoLength, setVideoLength] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [tool, setTool] = useState<Tool>('box');
  const [inkColor, setInkColor] = useState(INK_COLOR);
  const [sending, setSending] = useState(false);
  // 画面缩放和平移。只有图片／视频走这套：iframe 和三维模型自带手势，
  // 抢它们的手只会让两边都不灵。
  const [viewport, setViewport] = useState<StageViewport>({ zoom: MIN_ZOOM, panX: 0, panY: 0 });
  const pinchRef = useRef<PinchStart | null>(null);
  const panTouchRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  // A session with no artifact gets a sheet of paper instead of a media viewer.
  const blank = !artifact;
  const type = artifact ? mediaType(artifact) : 'image';
  const rawUrl = artifact ? artifactRawUrl(artifact) : '';
  const label = artifact ? (artifact.title || artifact.file_name || artifact.id) : '空白手绘页';
  const fill = !blank && (type === 'iframe' || type === 'model3d' || type === 'audio'
    || type === 'drawing' || type === 'unsupported');
  // 双指捏合在所有工具下都该能用：默认工具是框选，要求先切到浏览才能放大
  // 太反直觉，而且用户看成果时的第一反应就是「放大看细节」。
  const pinchable = !fill;
  // 单指平移只在浏览工具下接管，否则会和框选、手绘抢同一块触屏。
  const pannable = !fill && tool === 'browse';

  const savedStrokes = useMemo(() => annotations.flatMap(annotationStrokes), [annotations]);
  const draftStrokes = useMemo(() => draft?.strokes || [], [draft]);
  // 画布上要画的不只是已保存的笔：刚落下还没保存的草稿笔也算。
  // 只把 savedStrokes 交给 InkOverlay 时，落笔那一瞬间的墨迹会跟着 live stroke
  // 一起被清掉，而草稿笔迹又不会被补画回来 —— 空白页上表现为「画完什么都没有」。
  const visibleStrokes = useMemo(() => [...savedStrokes, ...draftStrokes], [savedStrokes, draftStrokes]);
  const unplaced = useMemo(() => annotations.filter(note => !annotationRect(note)), [annotations]);

  useEffect(() => {
    setVideoTime(0);
    setVideoLength(0);
    setVideoPlaying(false);
    setViewerError('');
    // 换一份成果就回到「适应屏幕」：上一份的倍率对这份没有意义，
    // 而且倍率留在那儿会让新内容被推到屏幕外，看起来像没加载出来。
    setViewport({ zoom: MIN_ZOOM, panX: 0, panY: 0 });
    // Model viewers and embedded documents keep their own gestures, so they open
    // in browse mode; blank paper exists to be drawn on, so it opens in ink
    // mode; everything else opens ready to annotate.
    setTool(blank
      ? 'ink'
      : artifact && (mediaType(artifact) === 'model3d' || mediaType(artifact) === 'iframe')
        ? 'browse'
        : 'box');
    onDraft(null);
  }, [blank, artifact?.id, onDraft]);

  // 图片和视频按 contain 缩进可用区域。
  // 为什么不用 CSS 的 max-h-full：百分比高度要等父级高度定下来，而父级高度又
  // 取决于图片自身，是个循环 —— 浏览器只能当它无效，于是图片按原始尺寸溢出，
  // 标注框却还按容器算，点 A 记到 B。这里直接量出可用区域，按比例定死像素尺寸，
  // 媒体盒子就和 stage 完全重合，坐标不会错位。
  useEffect(() => {
    if (fill) return;
    const scroller = scrollerRef.current;
    const media = mediaRef.current;
    if (!scroller || !media) return;
    const fit = () => {
      const ratio = mediaWidth(media) / mediaHeight(media);
      if (!Number.isFinite(ratio) || ratio <= 0) return;
      const availableWidth = Math.max(scroller.clientWidth - 8, 40);
      const availableHeight = Math.max(scroller.clientHeight - 8, 40);
      // 宽高各自都不能超：图比框「瘦」就按宽贴，图比框「胖」就按高贴。
      // zoom=1 时就是原来的「适应屏幕」；放大之后按倍率放大，画面就真的变大了。
      const fitted = ratio > availableWidth / availableHeight ? availableWidth : availableHeight * ratio;
      const width = fitted * viewport.zoom;
      media.style.width = `${Math.max(Math.floor(width), 40)}px`;
      media.style.height = `${Math.max(Math.floor(width / ratio), 40)}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(scroller);
    // 媒体也得盯着：图片是加载完才有原始尺寸的，那一下不会触发 scroller 的变化。
    observer.observe(media);
    return () => observer.disconnect();
  }, [artifact?.id, fill, videoLength, viewport.zoom]);

  useEffect(() => {
    if (type !== 'model3d' || tool === 'browse') return;
    let alive = true;
    void loadModelViewer().catch(() => { if (alive) setViewerError('三维渲染器没能加载'); });
    return () => { alive = false; };
  }, [type, tool]);

  const pointerPosition = (event: React.PointerEvent) => {
    const box = stageRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return null;
    return {
      box,
      x: Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1),
      y: Math.min(Math.max((event.clientY - box.top) / box.height, 0), 1),
    };
  };

  const stamp = () => (type === 'video' ? videoRef.current?.currentTime ?? 0 : null);

  /** TouchList 在这个 tsconfig 下没有迭代器声明，只有两个点，直接按索引取。 */
  const touchPoints = (touches: React.TouchList): Array<{ clientX: number; clientY: number }> => [
    { clientX: touches[0].clientX, clientY: touches[0].clientY },
    ...(touches[1] ? [{ clientX: touches[1].clientX, clientY: touches[1].clientY }] : []),
  ];

  /** 把触点换算成 scroller 的局部坐标，手势起点才能和 pan 对得上。 */
  const localPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const box = scrollerRef.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return { x: clientX - box.left, y: clientY - box.top };
  };

  /** 平移后要把画面拉回可视范围：放大之后总得留一条边能摸到。 */
  const settleViewport = useCallback((next: StageViewport): StageViewport => {
    const frame = scrollerRef.current;
    const media = mediaRef.current;
    // 量不到尺寸时不能夹取：那会把平移锁死在中心，画面看起来像卡住不动。
    if (!frame || !media || !frame.clientWidth || !frame.clientHeight) return next;
    return clampPan(next, {
      width: media.clientWidth * next.zoom,
      height: media.clientHeight * next.zoom,
    }, { width: frame.clientWidth, height: frame.clientHeight });
  }, []);

  const zoomBy = useCallback((factor: number, center?: { x: number; y: number }) => {
    setViewport(current => settleViewport(zoomAt(
      current,
      factor,
      center ?? {
        x: (scrollerRef.current?.clientWidth ?? 0) / 2,
        y: (scrollerRef.current?.clientHeight ?? 0) / 2,
      },
    )));
  }, [settleViewport]);

  const resetViewport = useCallback(() => {
    pinchRef.current = null;
    panTouchRef.current = null;
    setViewport({ zoom: MIN_ZOOM, panX: 0, panY: 0 });
  }, []);

  const onViewportTouchStart = useCallback((event: React.TouchEvent) => {
    if (!pinchable) return;
    const points = touchPoints(event.touches);
    if (points.length >= 2) {
      // 第二根手指落下就算捏合，把当前倍率和中点冻住作为基准。
      const center = touchMidpoint(points.map(point => localPoint(point.clientX, point.clientY)));
      pinchRef.current = {
        distance: touchDistance(points.map(point => localPoint(point.clientX, point.clientY))),
        zoom: viewport.zoom,
        panX: viewport.panX,
        panY: viewport.panY,
        centerX: center.x,
        centerY: center.y,
      };
      panTouchRef.current = null;
      return;
    }
    if (points.length === 1 && pannable && canPan(viewport)) {
      const point = localPoint(points[0].clientX, points[0].clientY);
      panTouchRef.current = { x: point.x, y: point.y, panX: viewport.panX, panY: viewport.panY };
    }
  }, [pinchable, pannable, viewport]);

  const onViewportTouchMove = useCallback((event: React.TouchEvent) => {
    if (!pinchable) return;
    const points = touchPoints(event.touches);
    const pinch = pinchRef.current;
    if (points.length >= 2 && pinch) {
      const local = points.map(point => localPoint(point.clientX, point.clientY));
      setViewport(current => settleViewport(pinchZoom(pinch, touchDistance(local), touchMidpoint(local))));
      return;
    }
    const pan = panTouchRef.current;
    if (points.length === 1 && pan) {
      const point = localPoint(points[0].clientX, points[0].clientY);
      setViewport(current => settleViewport(panBy(current, point.x - pan.x, point.y - pan.y)));
    }
  }, [pinchable, settleViewport]);

  const onViewportTouchEnd = useCallback(() => {
    pinchRef.current = null;
    panTouchRef.current = null;
  }, []);

  // 桌面上没有捏合：Ctrl/⌘ + 滚轮缩放，普通滚轮平移。
  const onViewportWheel = useCallback((event: React.WheelEvent) => {
    if (!pinchable) return;
    const center = localPoint(event.clientX, event.clientY);
    if (event.ctrlKey || event.metaKey) {
      setViewport(current => settleViewport(zoomAt(current, Math.exp(-event.deltaY / 240), center)));
      return;
    }
    if (!pannable || !canPan(viewport)) return;
    setViewport(current => settleViewport(panBy(current, -event.deltaX, -event.deltaY)));
  }, [pinchable, pannable, viewport, settleViewport]);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (tool !== 'box' || event.button !== 0) return;
    const position = pointerPosition(event);
    if (!position) return;
    dragRef.current = { fromX: event.clientX, fromY: event.clientY };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    onDraft({ rect: rectAt(position.x, position.y), t: stamp() });
  }, [tool, type, onDraft]);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const start = dragRef.current;
    if (!start) return;
    const position = pointerPosition(event);
    if (!position) return;
    const points = { fromX: start.fromX, fromY: start.fromY, toX: event.clientX, toY: event.clientY };
    if (!isDrag(points)) return;
    onDraft({ rect: rectFromDrag(points, position.box), t: stamp() });
  }, [type, onDraft]);

  const onPointerUp = useCallback((event: React.PointerEvent) => {
    const start = dragRef.current;
    dragRef.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    if (!start) return;
    const position = pointerPosition(event);
    if (!position) return;
    const points = { fromX: start.fromX, fromY: start.fromY, toX: event.clientX, toY: event.clientY };
    // A click that never became a drag replaces the draft instead of keeping a box.
    onDraft(isDrag(points)
      ? { rect: rectFromDrag(points, position.box), t: stamp() }
      : { rect: rectAt(position.x, position.y), t: stamp() });
  }, [type, onDraft]);

  const commitStroke = useCallback((stroke: InkStroke) => {
    // In ink mode every stroke joins one pending note, so the whole drawing is
    // saved or discarded as a unit and can be sent to the chat as one image.
    onDraft({ strokes: [...draftStrokes, stroke], t: stamp() });
  }, [draftStrokes, type, onDraft]);

  const undoStroke = useCallback(() => {
    const next = draftStrokes.slice(0, -1);
    onDraft(next.length ? { strokes: next, t: stamp() } : null);
  }, [draftStrokes, type, onDraft]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) { void video.play(); setVideoPlaying(true); } else { video.pause(); setVideoPlaying(false); }
  }, []);

  const seek = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = value;
    setVideoTime(value);
  }, []);

  const sendInkToChat = useCallback(async () => {
    const canvas = inkCanvasRef.current;
    const ink = visibleStrokes;
    if (!canvas || !ink.length) return;
    setSending(true);
    try {
      // The blank sheet has nothing behind the ink, so a transparent export
      // would arrive in chat as an image the agent cannot read strokes off.
      const blob = await exportStagePng(canvas, ink, { background: '#ffffff' });
      if (blob) onSendInk(blob);
      else setViewerError('这一页没法导出成图片，已保留笔迹');
    } finally {
      setSending(false);
    }
  }, [visibleStrokes, onSendInk]);

  const showDraftBar = Boolean(draft && ((draft.rect && !draft.strokes) || draft.strokes?.length));
  const draftIsInk = Boolean(draft?.strokes?.length);

  return <div className="flex min-h-0 flex-1 flex-col gap-2">
    <div ref={scrollerRef} data-testid="artifact-frame"
      className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded border border-border bg-muted/30 p-1 ${fill || blank ? 'pt-12' : ''}`}
      // 容器不滚动时必须禁止浏览器接管手势，否则双指会被页面级缩放吃掉。
      style={pinchable ? { touchAction: 'none' } : undefined}
      onTouchStart={onViewportTouchStart}
      onTouchMove={onViewportTouchMove}
      onTouchEnd={onViewportTouchEnd}
      onTouchCancel={onViewportTouchEnd}
      onWheel={onViewportWheel}>
      {/* 工具／翻页按键浮在成果上沿，不占版面：上方只留标题栏。
          pointer-events 由内层按键条自己接住，否则整条浮条会把框选和手绘吃掉 ——
          外层用 onPointerDown 停止冒泡，免得按一下工具先在成果上画一笔。 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-2 pt-2">
        <div role="group" aria-label="成果操作" onPointerDown={event => event.stopPropagation()}
          className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-full border border-border bg-background/90 px-1.5 py-1 shadow-sm backdrop-blur">
          {([['box', '框选'], ['ink', '手绘'], ['browse', '浏览']] as Array<[Tool, string]>)
            // 草稿纸上没有成果可框，框选在这时候只会画出一个删不掉的空框。
            .filter(([value]) => !(sketchOnly && value !== 'ink'))
            .map(([value, text]) => (
            <button key={value} type="button" aria-pressed={tool === value} className="min-h-9 rounded-full border border-transparent px-2.5 text-xs hover:bg-muted aria-pressed:border-primary aria-pressed:bg-primary/10"
              onClick={() => setTool(value)}>{text}</button>
          ))}
          {/* 颜色只在手绘时出现：框选和浏览都用不着它。放在浮条里是因为浮条已经
              接住了指针事件，色块不会再在成果上顺手画一笔。 */}
          {tool === 'ink' && <span role="group" aria-label="笔迹颜色" className="flex items-center gap-1 border-l border-border pl-1.5">
            {INK_COLORS.map(({ value, label }) => (
              <button key={value} type="button" aria-pressed={inkColor === value}
                aria-label={`笔迹颜色：${label}`} title={`笔迹颜色：${label}`}
                onClick={() => setInkColor(value)}
                className={`h-6 w-6 rounded-full ${inkColor === value
                  ? 'ring-2 ring-neutral-900 ring-offset-1 ring-offset-background dark:ring-white'
                  : 'ring-1 ring-neutral-300 dark:ring-neutral-600'}`}
                style={{ backgroundColor: value }} />
            ))}
          </span>}
          {!fill && <span role="group" aria-label="成果缩放" className="flex items-center gap-1 border-l border-border pl-1.5">
            <button type="button" onClick={() => zoomBy(1 / 1.4)} disabled={viewport.zoom <= MIN_ZOOM}
              aria-label="缩小" className="min-h-9 rounded-full px-2 text-xs hover:bg-muted disabled:opacity-40">−</button>
            <button type="button" onClick={resetViewport} disabled={viewport.zoom <= MIN_ZOOM}
              title="适应屏幕" className="min-h-9 rounded-full px-2 text-xs tabular-nums hover:bg-muted disabled:opacity-40">
              {formatZoom(viewport.zoom)}
            </button>
            <button type="button" onClick={() => zoomBy(1.4)} disabled={viewport.zoom >= MAX_ZOOM}
              aria-label="放大" className="min-h-9 rounded-full px-2 text-xs hover:bg-muted disabled:opacity-40">＋</button>
          </span>}
          {navigation}
          {artifact && <a className="shrink-0 rounded-full border border-transparent px-2.5 py-2 text-xs underline hover:bg-muted" href={rawUrl} target="_blank" rel="noopener noreferrer" download>下载</a>}
        </div>
      </div>
      {/* stage 必须正好贴合媒体本体。标注存的是 0–1 相对坐标，用滚动容器去归一化，
          图片比容器高时标注会整体错位（点 A 记到 B）。滚动与留白都放到 stage 外面。 */}
      <div ref={stageRef} className={`relative shrink-0 ${fill || blank ? 'h-full w-full' : ''}`}
        style={canPan(viewport) ? { transform: `translate(${viewport.panX}px, ${viewport.panY}px)` } : undefined}>
        {blank && <div className="h-full w-full rounded bg-white" />}
        {!blank && type === 'image' && <img ref={mediaRef as { current: HTMLImageElement | null }} src={rawUrl} alt={label} className="block object-contain" draggable={false} />}
        {!blank && type === 'video' && <video ref={mergeRefs(videoRef, mediaRef as { current: HTMLVideoElement | null })} src={rawUrl} className="block object-contain" playsInline
          onTimeUpdate={event => setVideoTime(event.currentTarget.currentTime)}
          onLoadedMetadata={event => setVideoLength(event.currentTarget.duration)}
          onPlay={() => setVideoPlaying(true)} onPause={() => setVideoPlaying(false)} />}
        {!blank && type === 'audio' && <audio src={rawUrl} controls className="w-full" />}
        {/* 页面成果靠自身滚动看下面的内容。之前那个 min-h-[420px] 在矮容器里
            会被 overflow-hidden 直接切掉，看上去就是「显示不完整」。

            sandbox 不是可选项：成果正文是用户上传 / 智能体生成的 HTML，而
            rawUrl 指向同源的 /api/artifacts/{id}/raw。不隔离，成果里的脚本
            就以 PilotV 的身份执行 —— 能调成果 API、能读同源会话数据。

            刻意不给 allow-same-origin：它和 allow-scripts 同时存在等于没沙箱
            （成果脚本可以从父页面把 sandbox 属性摘掉再 reload）。少了它文档
            落在「不透明源」，脚本照常跑但碰不到 PilotV 的源。
            服务端 artifacts_console.py 的 CSP sandbox 头是同一道锁的另一半，
            两边都要有 —— 任何一边单独被改回去都不至于失守。 */}
        {!blank && type === 'iframe' && <iframe src={rawUrl} title={label} className="h-full w-full border-0 bg-background"
          sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" />}
        {/* model-viewer 是自定义元素：className 传不进去（DOM 上没有 class 属性），
            只能用行内样式撑满，缺了它元素就停在 300x150 的默认尺寸。 */}
        {!blank && type === 'model3d' && <model-viewer src={rawUrl} alt={label} camera-controls disable-zoom={false}
          style={{ display: 'block', width: '100%', height: '100%', minHeight: 420 }} />}
        {!blank && (type === 'drawing' || type === 'unsupported') && <p className="p-4 text-sm text-muted-foreground">
          这个格式（{artifact.file_name || artifact.kind || '未知'}）暂时无法在页面里预览，可用上方「下载原文件」查看。
        </p>}
        {viewerError && <p role="alert" className="absolute inset-x-2 bottom-2 z-20 rounded bg-destructive/90 p-2 text-xs text-destructive-foreground">{viewerError}</p>}

        {/* Ink sits above the marker layer: numbered notes stay readable on top
            of a busy drawing via z-index, while the canvas wins hit-testing so a
            stroke can cross a marker instead of being swallowed by it. Live
            strokes are painted by InkOverlay itself until they commit. */}
        {tool === 'ink' && <div className="absolute inset-0 z-10">
          <InkOverlay strokes={visibleStrokes} color={inkColor} width={INK_WIDTH}
            onCanvas={canvas => { inkCanvasRef.current = canvas; }}
            onStroke={() => undefined}
            onCommit={commitStroke} label={`在 ${label} 上手绘标注`} />
        </div>}

        <div className={`absolute inset-0 ${tool === 'box' ? '' : 'z-20 pointer-events-none'}`}
          style={tool === 'box' ? { touchAction: 'none', cursor: 'crosshair' } : undefined}
          onPointerDown={tool === 'box' ? onPointerDown : undefined}
          onPointerMove={tool === 'box' ? onPointerMove : undefined}
          onPointerUp={tool === 'box' ? onPointerUp : undefined}>
          {annotations.map(note => {
            const rect = annotationRect(note);
            const resolved = note.status === 'resolved';
            const tint = resolved ? 'border-muted-foreground/60 bg-muted/60' : 'border-destructive bg-destructive/20';
            const picked = activeNoteId === note.id ? 'ring-2 ring-ring' : '';
            const label = `标注 ${note.seq ?? ''}：${note.body ?? ''}`;
            // A note with no rect anywhere still has to be visible — it exists,
            // it is in the list, and dropping it here is what made saved
            // annotations look like they had never been created.
            if (!rect) {
              const orphan = `absolute left-1 top-1 rounded border border-dashed border-destructive px-1 text-[9px] leading-none text-destructive ${picked}`;
              return tool === 'box'
                ? <button key={note.id} type="button" aria-label={`${label}（无位置）`} onClick={() => onPickNote(note.id)} className={orphan}>{note.seq ?? '?'} 无位置</button>
                : <span key={note.id} className={orphan}>{note.seq ?? '?'} 无位置</span>;
            }
            const box = { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${Math.max(rect.w * 100, 1.6)}%`, height: `${Math.max(rect.h * 100, 1.6)}%` };
            // Outside 框选 mode a marker must not be a <button>: the app stylesheet
            // forces `pointer-events: auto !important` on every button, so a
            // marker rendered as one silently swallows strokes on the ink canvas
            // and rotate/zoom gestures on the 3D viewer.
            return tool === 'box'
              ? <button key={note.id} type="button" aria-label={label} onClick={() => onPickNote(note.id)}
                className={`absolute rounded border-2 text-[10px] leading-none ${tint} ${picked}`} style={box}>
                <span className="absolute -left-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] text-destructive-foreground">{note.seq ?? '?'}</span>
              </button>
              : <span key={note.id} aria-label={label} className={`absolute rounded border-2 text-[10px] leading-none ${tint} ${picked}`} style={box}>
                <span className="absolute -left-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] text-destructive-foreground">{note.seq ?? '?'}</span>
              </span>;
          })}
          {draft?.rect && !draft.strokes && <div aria-hidden
            className="pointer-events-none absolute rounded border-2 border-primary bg-primary/20"
            style={{ left: `${draft.rect.x * 100}%`, top: `${draft.rect.y * 100}%`, width: `${Math.max(draft.rect.w * 100, 0.8)}%`, height: `${Math.max(draft.rect.h * 100, 0.8)}%` }} />}
        </div>

        {/* The editor rides on the stage instead of the side panel. On a phone
            the panel stacks under a full-height viewer and the save button sat
            below the fold, so a box got drawn and could never be committed.
            没有选中对话时是草稿纸：不写说明、不存标注，只有清空、撤销和发到新对话。 */}
        {showDraftBar && <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1 border-t border-border bg-background/95 p-2 backdrop-blur">
          {!sketchOnly && <>
            <label className="text-xs" htmlFor="artifact-note-draft">新标注（{draftIsInk ? `${draftStrokes.length} 笔` : '框选'}）</label>
            <input id="artifact-note-draft" className="w-full rounded border border-border bg-background p-2 text-sm"
              value={draftBody} placeholder="说明这里要怎么改" autoFocus
              onChange={event => onDraftBody(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onSaveDraft(); } }} />
          </>}
          <div className="flex flex-wrap gap-1">
            {!sketchOnly && <button type="button" className="min-h-11 rounded border border-border px-3 text-sm" onClick={() => { onSaveDraft(); }}>保存标注</button>}
            <button type="button" className="min-h-11 rounded border border-border px-3 text-sm" onClick={() => { onCancelDraft(); }}>{sketchOnly ? '清空' : '取消'}</button>
            {draftIsInk && <button type="button" className="min-h-11 rounded border border-border px-3 text-sm" disabled={sending || !inkCanvasRef.current}
              onClick={() => { void sendInkToChat(); }}>{sendLabel}</button>}
            {draftIsInk && draftStrokes.length > 1 && <button type="button" className="min-h-11 rounded border border-border px-3 text-sm" onClick={undoStroke}>撤销一笔</button>}
          </div>
          {draftError && <p role="alert" className="text-xs text-destructive">{draftError}</p>}
        </div>}
      </div>

      {unplaced.length > 0 && <p role="status" className="absolute right-2 top-14 z-20 rounded bg-background/90 px-2 py-1 text-[11px] text-muted-foreground">
        {unplaced.length} 条标注没有位置信息，已列在右侧
      </p>}
    </div>

    {type === 'video' && <div className="flex shrink-0 items-center gap-2 px-1 text-xs">
      <button type="button" className="min-h-9 rounded border border-border px-3" onClick={togglePlay}>{videoPlaying ? '暂停' : '播放'}</button>
      <input type="range" className="min-w-0 flex-1" aria-label="时间线" min={0} max={Math.max(videoLength, 0.1)} step={0.05}
        value={Math.min(videoTime, Math.max(videoLength, 0.1))} onChange={event => seek(Number(event.target.value))} />
      <span className="tabular-nums">{formatTime(videoTime)} / {formatTime(videoLength)}</span>
    </div>}
  </div>;
}