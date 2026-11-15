// 成果台的三维展示台。
//
// **所有三维成果都走这一个组件** —— 不要再给某个模型单独做一个展示页。
// 成果台里的模型千差万别（STEP 装配体 / FCStd / 网格 / glTF），但看模型的动作
// 是一样的：转一转、平移、放大、选零件、藏零件、挪零件、改颜色、调透明、
// 给某个零件写一条说明。所以这里给的是一个固定的看模型台子：
//
//   - 渲染与相机：three.js（见 threeStage.ts）。左键拖动旋转、右键或 Shift
//     拖动平移、滚轮缩放，都是 OrbitControls 自带的；
//   - 零件模式：查看 / 选零件 / 移零件 / 标注零件（见 MODES）；
//   - 颜色、透明度、隐藏、爆炸图、行程动画；
//   - 操作面板可以整个收成一个图标，全屏时自动收起 —— 只剩模型。
//
// 拆解能力取决于模型本身有没有零件结构：装配体导出来的 glTF 一个零件一个节点，
// 就能拆；一整块网格（STEP 没拆开）就只有一个零件，拆不动 —— 这时要如实说清楚，
// 不能摆一堆按了没反应的按钮。

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Box, Move3d, MousePointer2, PenLine } from 'lucide-react';
import { ThreeStage, type ColorMode, type StageMode, type StagePartInfo } from './threeStage';
import type { Vec3 } from './artifactStage3d';

export type ArtifactModelViewerHandle = {
  /** 相机回到默认视角。 */
  resetView: () => void;
  /** 自动旋转开关。 */
  setAutoRotate: (on: boolean) => void;
  /** 缩放倍率（1 = 适应屏幕）。 */
  setZoom: (zoom: number) => void;
};

type Props = {
  /** 一定要是成果台自己的 /viewer 口：所有三维成果从这一个口子出。 */
  src: string;
  alt: string;
  /** 把命令式句柄交出去：相机那套（自动旋转、复位、缩放）仍归外层管。 */
  viewerRef?: RefObject<ArtifactModelViewerHandle | null>;
  /** 标注／手绘在用时，三维不要抢手势。 */
  gesturesEnabled?: boolean;
  /** 全屏：只留模型，操作面板收成一个图标。 */
  fullscreen?: boolean;
  /** 在零件上写一条说明：把零件交给外层挂成标注。 */
  onAnnotatePart?: (target: { id: string; name: string; rect: { x: number; y: number; w: number; h: number } }) => void;
  /** 外部（例如点开一条零件标注）要求选中的零件。 */
  focusPart?: string | null;
  onError?: (message: string) => void;
};

const AXES: Array<{ value: Vec3; label: string }> = [
  { value: [1, 0, 0], label: 'X' },
  { value: [0, 1, 0], label: 'Y' },
  { value: [0, 0, 1], label: 'Z' },
];

/** 背景色的备选：一排都不刺眼的浅色，外加深色（深色背景看金属件更清楚）。 */
const BACKGROUNDS: Array<{ value: string; label: string }> = [
  { value: '#eef1f6', label: '浅灰' },
  { value: '#ffffff', label: '白' },
  { value: '#dfe5ee', label: '冷灰' },
  { value: '#c9d3e0', label: '蓝灰' },
  { value: '#2b3038', label: '深灰' },
  { value: '#141821', label: '深色' },
];

/**
 * 零件模式的说明。
 *
 * 「选零件」和「标注零件」要把左键从旋转里拿出来 —— 一边转画面一边点零件，
 * 手指是够不着的。
 */
const MODES: Array<{ value: StageMode; label: string; hint: string }> = [
  { value: 'view', label: '查看', hint: '拖动旋转 · 右键（或按住 Shift）平移 · 滚轮缩放' },
  { value: 'select', label: '选零件', hint: '左键点选零件，画面不会转走' },
  { value: 'move', label: '移零件', hint: '按住左键，拖着选中的零件走' },
  { value: 'annotate', label: '标注零件', hint: '点一个零件，给它写一条说明' },
];

type PartOverride = {
  color: string | null;
  opacity: number;
  hidden: boolean;
};

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function clampAmount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(-100, Math.round(value)));
}

export default function ArtifactModelViewer({
  src,
  alt,
  viewerRef,
  gesturesEnabled = true,
  fullscreen = false,
  onAnnotatePart,
  focusPart = null,
  onError,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<ThreeStage | null>(null);
  // 报错回调放引用里：父组件每次渲染都给新的函数也没关系，
  // 不然「载入模型」那个 effect 会跟着回调变来变去，反复重载。
  const onErrorRef = useRef(onError);
  const annotateRef = useRef(onAnnotatePart);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { annotateRef.current = onAnnotatePart; }, [onAnnotatePart]);

  const [parts, setParts] = useState<StagePartInfo[]>([]);
  const [hasTexture, setHasTexture] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [modelRadius, setModelRadius] = useState(1);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, PartOverride>>({});
  const [offsets, setOffsets] = useState<Record<string, Vec3>>({});
  const [colorMode, setColorMode] = useState<ColorMode>('palette');
  const [background, setBackground] = useState(BACKGROUNDS[0].value);
  const [explode, setExplode] = useState(0);
  const [alpha, setAlpha] = useState(1);
  const [axis, setAxis] = useState<Vec3>([1, 0, 0]);
  const [moveAmount, setMoveAmount] = useState(0);
  const [travelAmount, setTravelAmount] = useState(30);
  const [mode, setMode] = useState<StageMode>('view');
  const [panelOpen, setPanelOpen] = useState(true);

  // 三维层的回调建在渲染器上（那时这些值还不存在），只能走引用拿最新的。
  const axisRef = useRef<Vec3>([1, 0, 0]);
  const radiusRef = useRef(1);
  const selectedRef = useRef<string | null>(null);
  useEffect(() => { axisRef.current = axis; }, [axis]);
  useEffect(() => { radiusRef.current = modelRadius; }, [modelRadius]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const reportError = useCallback((text: string) => {
    setStatus('error');
    setMessage(text);
    onErrorRef.current?.(text);
  }, []);

  // 建渲染器。three 是在 React 之外活着的一层：这里建好，之后只往里发指令。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let stage: ThreeStage | null = null;
    try {
      stage = new ThreeStage(host, {
        onSelect: id => {
          selectedRef.current = id;
          setSelected(current => (current === id ? current : id));
        },
        onAnnotatePart: target => annotateRef.current?.(target),
        onPartMoved: (id, offset) => {
          setOffsets(current => ({ ...current, [id]: offset }));
          // 滑块跟着走：把位移投影到当前轴上，滑块才不至于和画面脱节。
          const direction = axisRef.current;
          const along = offset[0] * direction[0] + offset[1] * direction[1] + offset[2] * direction[2];
          const amount = clampAmount((along / (radiusRef.current || 1)) * 100);
          setMoveAmount(current => (current === amount ? current : amount));
          if (selectedRef.current !== id) {
            selectedRef.current = id;
            setSelected(id);
          }
        },
      });
    } catch (error) {
      reportError(error instanceof Error
        ? `三维画布没能创建：${error.message}`
        : '三维画布没能创建（浏览器可能没开硬件加速）');
      return undefined;
    }
    stageRef.current = stage;
    return () => {
      stageRef.current = null;
      stage.dispose();
    };
  }, [reportError]);

  // 取模型。取不到就如实说取不到 —— 空白的画面最让人以为模型本来就是空的。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let alive = true;
    setStatus('loading');
    setMessage('');
    setParts([]);
    setOverrides({});
    setOffsets({});
    setSelected(null);
    setExplode(0);
    setAlpha(1);
    setMoveAmount(0);
    void stage.load(src).then(result => {
      if (!alive) return;
      setParts(result.parts);
      setHasTexture(result.hasTexture);
      setEmpty(result.empty);
      setModelRadius(result.radius || 1);
      // 带贴图的模型按原材质渲染（贴图才是它长成这样的原因）；没贴图又有多件
      // 装配的，默认分色 —— 一整块灰看不出谁是谁。
      setColorMode(result.hasTexture || result.parts.length <= 1 ? 'material' : 'palette');
      setStatus('ready');
    }).catch(error => {
      if (!alive) return;
      reportError(error instanceof Error ? error.message : '三维模型读取失败');
    });
    return () => { alive = false; };
  }, [src, reportError]);

  useImperativeHandle(viewerRef, () => ({
    resetView: () => stageRef.current?.resetView(),
    setAutoRotate: (on: boolean) => stageRef.current?.setAutoRotate(on),
    setZoom: (zoom: number) => stageRef.current?.setZoom(zoom),
  }), []);

  useEffect(() => {
    stageRef.current?.setGesturesEnabled(gesturesEnabled);
  }, [gesturesEnabled]);

  useEffect(() => { stageRef.current?.setMode(mode); }, [mode]);
  useEffect(() => { stageRef.current?.setBackground(background); }, [background]);
  useEffect(() => { stageRef.current?.setColorMode(colorMode); }, [colorMode]);
  useEffect(() => { stageRef.current?.setExplode(explode); }, [explode]);
  useEffect(() => { stageRef.current?.setAlpha(alpha); }, [alpha]);

  // 逐零件的改动：颜色、透明度、隐藏。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    for (const part of parts) {
      const override = overrides[part.id];
      stage.setPartColor(part.id, override?.color ?? null);
      stage.setPartOpacity(part.id, override?.opacity ?? 1);
      stage.setPartHidden(part.id, override?.hidden ?? false);
    }
  }, [parts, overrides]);

  // 零件的位置：拖动和「挪动」滑块都改同一份数据，两边不会打架。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    for (const part of parts) {
      const offset = offsets[part.id];
      stage.setPartOffset(part.id, offset ?? [0, 0, 0]);
    }
  }, [parts, offsets]);

  // 外部要求选中的零件（例如点开一条零件标注）：选中它，并把镜头挪过去。
  useEffect(() => {
    if (!focusPart) return;
    const stage = stageRef.current;
    if (!stage) return;
    setSelected(focusPart);
    stage.setSelected(focusPart);
    stage.focusPart(focusPart);
  }, [focusPart, status]);

  // 全屏：面板收成一个图标（用户要的是「只显示模型」）。
  useEffect(() => { setPanelOpen(!fullscreen); }, [fullscreen]);

  const updateOverride = useCallback((id: string, patch: Partial<PartOverride>) => {
    setOverrides(current => {
      const base = current[id] ?? { color: null, opacity: 1, hidden: false };
      return { ...current, [id]: { ...base, ...patch } };
    });
  }, []);

  /** 「挪动」滑块：只改轴向的那一份，拖出来的其它方向保留。 */
  const applyMove = useCallback((amount: number) => {
    setMoveAmount(amount);
    if (!selected) return;
    const distance = (amount / 100) * modelRadius;
    setOffsets(current => {
      const base = current[selected] ?? [0, 0, 0];
      const next: Vec3 = [
        axis[0] ? distance : base[0],
        axis[1] ? distance : base[1],
        axis[2] ? distance : base[2],
      ];
      return { ...current, [selected]: next };
    });
  }, [axis, modelRadius, selected]);

  const demoTravel = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !selected) return;
    stage.playTravel(selected, axis, (travelAmount / 100) * modelRadius);
  }, [axis, modelRadius, selected, travelAmount]);

  const resetAll = useCallback(() => {
    const mode0 = hasTexture || parts.length <= 1 ? 'material' : 'palette';
    setOverrides({});
    setOffsets({});
    setExplode(0);
    setAlpha(1);
    setMoveAmount(0);
    setTravelAmount(30);
    setSelected(null);
    setColorMode(mode0);
    setBackground(BACKGROUNDS[0].value);
    stageRef.current?.setExplode(0);
    stageRef.current?.setAlpha(1);
    stageRef.current?.setColorMode(mode0);
    stageRef.current?.setBackground(BACKGROUNDS[0].value);
  }, [hasTexture, parts.length]);

  const selectedPart = useMemo(
    () => parts.find(part => part.id === selected) ?? null,
    [parts, selected],
  );
  const selectedOverride = selected ? overrides[selected] : undefined;
  const hasParts = parts.length > 1;
  const modeHint = MODES.find(item => item.value === mode)?.hint ?? '';

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" data-testid="artifact-model-canvas" aria-label={alt} />

      {status === 'loading' && (
        <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          正在载入三维模型…
        </p>
      )}

      {status === 'error' && (
        <div className="absolute inset-x-0 bottom-0 z-30 bg-destructive/90 p-2 text-xs text-destructive-foreground">
          {message}
        </div>
      )}

      {status === 'ready' && empty && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-4 text-center">
          <p className="max-w-sm rounded border border-border bg-background/95 p-3 text-xs leading-relaxed text-muted-foreground shadow">
            这份三维文件里没有实体几何（一个面都没有），所以是空的。
            多半是源文件只有草图／线框，或者是个空壳占位文件 —— 请在 CAD 里重新导出实体后再发布。
          </p>
        </div>
      )}

      {/* 面板收起时只留一个图标：全屏看模型时，屏幕上什么都不该多。 */}
      {!panelOpen && (
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          title="三维操作面板"
          aria-label="三维操作面板"
          className="pointer-events-auto absolute bottom-2 left-2 z-30 flex min-h-9 items-center gap-1 rounded-md border border-border bg-background/90 px-2 text-xs shadow backdrop-blur hover:bg-muted"
        >
          <Box className="h-3.5 w-3.5" aria-hidden />
          三维
        </button>
      )}

      {panelOpen && (
        <div className="pointer-events-none absolute inset-0 z-30">
          <div className="pointer-events-auto absolute bottom-2 left-2 flex max-h-[88%] w-72 flex-col gap-1.5 rounded-md border border-border bg-background/95 p-1.5 text-xs shadow-lg backdrop-blur">
            <div className="flex items-center gap-1">
              <span className="flex-1 px-2 text-left font-medium">三维操作</span>
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                title="收起三维操作面板"
                aria-label="收起三维操作面板"
                className="min-h-8 rounded px-2 hover:bg-muted"
              >
                收起
              </button>
            </div>

            {/* 零件模式：左键在「转视角」和「点零件」之间换。 */}
            <div role="group" aria-label="零件模式" className="flex items-center gap-1 px-1">
              {MODES.map(item => {
                const Icon = item.value === 'view'
                  ? MousePointer2
                  : item.value === 'select'
                    ? MousePointer2
                    : item.value === 'move'
                      ? Move3d
                      : PenLine;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setMode(item.value)}
                    aria-pressed={mode === item.value}
                    title={item.hint}
                    className="flex min-h-7 items-center gap-1 rounded border border-transparent px-1.5 hover:bg-muted aria-pressed:border-primary aria-pressed:bg-primary/10"
                  >
                    <Icon className="h-3 w-3" aria-hidden />
                    {item.label}
                  </button>
                );
              })}
            </div>
            <p className="px-1 text-[11px] leading-tight text-muted-foreground">{modeHint}</p>

            <div className="flex items-center gap-1 px-1">
              <span className="w-12 shrink-0">背景</span>
              {BACKGROUNDS.map(item => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setBackground(item.value)}
                  aria-pressed={background === item.value}
                  aria-label={`背景色：${item.label}`}
                  title={item.label}
                  className={`h-5 w-5 rounded-full ${background === item.value
                    ? 'ring-2 ring-neutral-900 ring-offset-1 ring-offset-background dark:ring-white'
                    : 'ring-1 ring-neutral-300 dark:ring-neutral-600'}`}
                  style={{ backgroundColor: item.value }}
                />
              ))}
              <input
                type="color"
                aria-label="自定义背景色"
                value={background}
                onChange={event => setBackground(event.target.value)}
                className="h-5 w-7 cursor-pointer rounded border border-border bg-transparent p-0"
              />
            </div>

            {parts.length > 1 && (
              <div className="flex items-center gap-1 px-1">
                <span className="w-12 shrink-0">配色</span>
                <button
                  type="button"
                  onClick={() => setColorMode('palette')}
                  aria-pressed={colorMode === 'palette'}
                  className="min-h-7 rounded border border-transparent px-2 hover:bg-muted aria-pressed:border-primary aria-pressed:bg-primary/10"
                >
                  分色
                </button>
                <button
                  type="button"
                  onClick={() => setColorMode('material')}
                  aria-pressed={colorMode === 'material'}
                  className="min-h-7 rounded border border-transparent px-2 hover:bg-muted aria-pressed:border-primary aria-pressed:bg-primary/10"
                >
                  原材质
                </button>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {colorMode === 'palette' ? '各零件不同色' : '按模型自带材质'}
                </span>
              </div>
            )}

            <label className="flex items-center gap-2 px-1">
              <span className="w-12 shrink-0">爆炸图</span>
              <input
                type="range"
                className="min-w-0 flex-1"
                aria-label="爆炸程度"
                min={0}
                max={100}
                step={1}
                disabled={!hasParts}
                value={Math.round(explode * 100)}
                onChange={event => setExplode(Number(event.target.value) / 100)}
              />
              <span className="w-9 shrink-0 text-right tabular-nums">{percent(explode)}</span>
            </label>

            <label className="flex items-center gap-2 px-1">
              <span className="w-12 shrink-0">整体透明</span>
              <input
                type="range"
                className="min-w-0 flex-1"
                aria-label="整体透明度"
                min={5}
                max={100}
                step={1}
                value={Math.round(alpha * 100)}
                onChange={event => setAlpha(Number(event.target.value) / 100)}
              />
              <span className="w-9 shrink-0 text-right tabular-nums">{percent(alpha)}</span>
            </label>

            <div className="min-h-0 flex-1 overflow-auto rounded border border-border/70">
              {parts.length === 0 && (
                <p className="p-2 text-[11px] leading-tight text-muted-foreground">
                  这份模型里没有可拆的零件。
                </p>
              )}
              {parts.length === 1 && (
                <p className="p-2 text-[11px] leading-tight text-muted-foreground">
                  这份模型只有一个整体，没有零件结构，拆不开（但可以整体藏起来、调颜色和透明度）。
                </p>
              )}
              {parts.map(part => {
                const override = overrides[part.id];
                const hidden = override?.hidden ?? false;
                return (
                  <div key={part.id} className="flex items-center gap-1 border-b border-border/40 px-1 py-0.5 last:border-b-0">
                    <span
                      aria-hidden="true"
                      className="h-3 w-3 shrink-0 rounded-full ring-1 ring-black/20"
                      style={{ backgroundColor: override?.color ?? part.color }}
                    />
                    <button
                      type="button"
                      onClick={() => setSelected(part.id === selected ? null : part.id)}
                      className={`min-h-7 min-w-0 flex-1 truncate rounded px-1 text-left hover:bg-muted ${selected === part.id ? 'bg-primary/10 text-primary' : ''}`}
                    >
                      {part.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => updateOverride(part.id, { hidden: !hidden })}
                      aria-pressed={hidden}
                      className="min-h-7 shrink-0 rounded px-1.5 hover:bg-muted aria-pressed:bg-destructive/15 aria-pressed:text-destructive"
                    >
                      {hidden ? '显示' : '隐藏'}
                    </button>
                  </div>
                );
              })}
            </div>

            {selectedPart && (
              <div className="flex flex-col gap-1.5 rounded border border-border/70 p-1.5">
                <div className="flex items-center gap-1">
                  <span className="px-1">方向</span>
                  {AXES.map(item => (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => setAxis(item.value)}
                      aria-pressed={axis[0] === item.value[0] && axis[1] === item.value[1] && axis[2] === item.value[2]}
                      className="min-h-7 w-7 rounded border border-transparent text-[11px] hover:bg-muted aria-pressed:border-primary aria-pressed:bg-primary/10"
                    >
                      {item.label}
                    </button>
                  ))}
                  <span className="ml-auto max-w-[9rem] truncate text-[11px] text-muted-foreground">
                    {selectedPart.name}
                  </span>
                </div>

                <label className="flex items-center gap-2">
                  <span className="w-12 shrink-0">颜色</span>
                  <input
                    type="color"
                    aria-label="零件颜色"
                    value={selectedOverride?.color ?? selectedPart.color}
                    onChange={event => updateOverride(selectedPart.id, { color: event.target.value })}
                    className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  <button
                    type="button"
                    onClick={() => updateOverride(selectedPart.id, { color: null })}
                    className="min-h-7 rounded border border-border px-1.5 hover:bg-muted"
                  >
                    跟随配色
                  </button>
                </label>

                <label className="flex items-center gap-2">
                  <span className="w-12 shrink-0">透明度</span>
                  <input
                    type="range"
                    className="min-w-0 flex-1"
                    aria-label="零件透明度"
                    min={5}
                    max={100}
                    step={1}
                    value={Math.round((selectedOverride?.opacity ?? 1) * 100)}
                    onChange={event => updateOverride(selectedPart.id, { opacity: Number(event.target.value) / 100 })}
                  />
                  <span className="w-9 shrink-0 text-right tabular-nums">
                    {percent(selectedOverride?.opacity ?? 1)}
                  </span>
                </label>

                <label className="flex items-center gap-2">
                  <span className="w-12 shrink-0">挪动</span>
                  <input
                    type="range"
                    className="min-w-0 flex-1"
                    aria-label="挪动距离"
                    min={-100}
                    max={100}
                    step={1}
                    value={moveAmount}
                    onChange={event => applyMove(clampAmount(Number(event.target.value)))}
                  />
                  <span className="w-9 shrink-0 text-right tabular-nums">{moveAmount}%</span>
                </label>

                <label className="flex items-center gap-2">
                  <span className="w-12 shrink-0">行程</span>
                  <input
                    type="range"
                    className="min-w-0 flex-1"
                    aria-label="行程大小"
                    min={0}
                    max={100}
                    step={1}
                    value={travelAmount}
                    onChange={event => setTravelAmount(Number(event.target.value))}
                  />
                  <span className="w-9 shrink-0 text-right tabular-nums">{travelAmount}%</span>
                </label>

                <button
                  type="button"
                  onClick={demoTravel}
                  className="min-h-8 rounded border border-border px-2 hover:bg-muted"
                >
                  演示行程
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={resetAll}
              className="min-h-8 rounded border border-border px-2 hover:bg-muted"
            >
              复位三维操作
            </button>

            {!gesturesEnabled && (
              <p className="px-1 text-[11px] leading-tight text-muted-foreground">
                正在标注，三维的拖动暂时让给标注工具。
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
