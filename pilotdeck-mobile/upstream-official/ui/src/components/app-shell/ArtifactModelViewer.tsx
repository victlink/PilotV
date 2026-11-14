// 成果台的三维展示台。
//
// **所有三维成果都走这一个组件** —— 不要再给某个模型单独做一个展示页。
// 成果台里的模型千差万别（STEP 装配体 / FCStd / 网格 / glTF），但看模型的动作
// 是一样的：转一转、平移、放大、全屏讲一遍、拆开看内部、把某个零件挪开、
// 调透明看里面的东西、演示一下行程。所以这里给的是一个固定的看模型台子：
//
//   - 旋转 / 平移 / 缩放：交给 model-viewer 的 camera-controls
//     （左键转、右键或 Shift 拖动平移、滚轮缩放，都是它自带的）
//   - 全屏：外层 ArtifactStage 负责（连工具条一起进全屏，按钮不会留在外面）
//   - 拆解 / 隐藏 / 移动零件 / 透明度 / 行程动画：改 glTF 再喂回渲染器
//     （见 artifactModel3d.ts）
//
// 拆解能力取决于模型本身有没有零件结构：装配体导出来的 glTF 一个零件一个节点，
// 就能拆；一整块网格（STEP 没拆开）就只有一个零件，拆不动 —— 这时要如实说清楚，
// 不能摆一堆按了没反应的按钮。

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  TRAVEL_ANIMATION_NAME,
  applyModelState,
  collectParts,
  emptyModel3dState,
  modelBounds,
  parseGlb,
  serializeGlb,
  topLevelParts,
  type GlbDocument,
  type Model3dState,
  type Vec3,
} from './artifactModel3d';

type Props = {
  /** 一定要是成果台自己的 /viewer 口：所有三维成果从这一个口子出。 */
  src: string;
  alt: string;
  /** 把 <model-viewer> 元素交出去：相机那套（自动旋转、复位、视场角）仍归外层管。 */
  viewerRef?: RefObject<HTMLElement | null>;
  /** 标注／手绘在用时，三维不要抢手势。 */
  gesturesEnabled?: boolean;
  onError?: (message: string) => void;
};

const AXES: Array<{ value: Vec3; label: string }> = [
  { value: [1, 0, 0], label: 'X' },
  { value: [0, 1, 0], label: 'Y' },
  { value: [0, 0, 1], label: 'Z' },
];

/** 拖滑块时不要每动一下就重新打包一次 GLB：模型一重载，视角就得重新找回来。 */
const REBUILD_DELAY_MS = 120;

type ModelViewerElement = HTMLElement & {
  cameraOrbit?: string;
  cameraTarget?: string;
  fieldOfView?: string;
  autoRotate?: boolean;
  rotationPerSecond?: string;
  animationName?: string;
  autoplay?: boolean;
  play?: () => void;
  resetTurntableRotation?: () => void;
  getCameraTarget?: () => { x: number; y: number; z: number };
};

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export default function ArtifactModelViewer({ src, alt, viewerRef, gesturesEnabled = true, onError }: Props) {
  const elementRef = useRef<HTMLElement | null>(null);
  const [base, setBase] = useState<GlbDocument | null>(null);
  const [state, setState] = useState<Model3dState>(emptyModel3dState);
  const [modelUrl, setModelUrl] = useState(src);
  const [structured, setStructured] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [axis, setAxis] = useState<Vec3>([1, 0, 0]);
  const [moveAmount, setMoveAmount] = useState(0);
  const [travelAmount, setTravelAmount] = useState(20);
  // 行程动画要能「再演示一次」：同样的状态也得重新装载一次模型才会重播。
  const [playNonce, setPlayNonce] = useState(0);
  const playedNonce = useRef(0);
  const cameraOrbit = useRef<string | null>(null);
  const pendingTarget = useRef<{ x: number; y: number; z: number } | null>(null);
  const blobUrl = useRef<string | null>(null);

  // 换一份成果就回到初始状态：上一份的爆炸程度对这份没有意义。
  useEffect(() => {
    setState(emptyModel3dState());
    setDirty(false);
    setStructured(false);
    setSelected(null);
    setMoveAmount(0);
    setTravelAmount(20);
    setPlayNonce(0);
    playedNonce.current = 0;
    setModelUrl(src);
  }, [src]);

  // 取一次模型。解析不了（不是 GLB、或者根本取不到）就退回普通预览：
  // 「能看」比「能拆」重要，不能因为拆不动就不给看。
  useEffect(() => {
    let alive = true;
    fetch(src)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then(buffer => {
        if (!alive) return;
        const doc = parseGlb(buffer);
        if (!doc) return;
        setBase(doc);
        setStructured(true);
      })
      .catch(() => { /* 取不到就还是原来那个 src，model-viewer 自己会报错 */ });
    return () => { alive = false; };
  }, [src]);

  const parts = useMemo(() => (base ? collectParts(base) : []), [base]);
  const partList = useMemo(() => (base ? topLevelParts(parts) : []), [base, parts]);
  const bounds = useMemo(() => (base ? modelBounds(base, parts) : null), [base, parts]);

  // 状态变了就重新打包一次 GLB，喂回同一个渲染器。
  useEffect(() => {
    if (!base || !dirty) return;
    const timer = window.setTimeout(() => {
      // 重装模型前先把当前目标点记下来：model-viewer 重新取景时目标点会按
      // 新的包围盒重算，用户平移过的视角就丢了（模型看着「跳」回中间）。
      const el = elementRef.current as ModelViewerElement | null;
      const target = el?.getCameraTarget?.();
      if (target) pendingTarget.current = { x: target.x, y: target.y, z: target.z };
      const doc = applyModelState(base, state);
      const bytes = serializeGlb(doc);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
      const previous = blobUrl.current;
      blobUrl.current = url;
      setModelUrl(url);
      if (previous) URL.revokeObjectURL(previous);
    }, REBUILD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [base, dirty, state, playNonce]);

  useEffect(() => () => {
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
  }, []);

  const setViewer = useCallback((node: HTMLElement | null) => {
    elementRef.current = node;
    if (viewerRef) (viewerRef as { current: HTMLElement | null }).current = node;
  }, [viewerRef]);

  // 相机状态要自己保住：模型一重新装载，model-viewer 就重新取景，
  // 用户转好的角度会丢。camera-change 记下来，load 之后还回去。
  useEffect(() => {
    const el = elementRef.current as ModelViewerElement | null;
    if (!el) return;
    const onCameraChange = () => {
      const orbit = el.cameraOrbit;
      if (typeof orbit === 'string' && orbit) cameraOrbit.current = orbit;
    };
    const onLoad = () => {
      if (cameraOrbit.current) {
        try { el.cameraOrbit = cameraOrbit.current; } catch { /* 元素还没升级完 */ }
      }
      // 目标点也要还回去：平移过的视角丢了，用户会以为模型自己跳回去了。
      const target = pendingTarget.current;
      if (target) {
        pendingTarget.current = null;
        try { el.cameraTarget = `${target.x} ${target.y} ${target.z}`; } catch { /* 同上 */ }
      }
      if (playNonce !== playedNonce.current) {
        playedNonce.current = playNonce;
        try {
          el.animationName = TRAVEL_ANIMATION_NAME;
          el.autoplay = true;
          el.play?.();
        } catch { /* 动画还没准备好 */ }
      } else {
        try { el.autoplay = false; } catch { /* 同上 */ }
      }
    };
    el.addEventListener('camera-change', onCameraChange);
    el.addEventListener('load', onLoad);
    return () => {
      el.removeEventListener('camera-change', onCameraChange);
      el.removeEventListener('load', onLoad);
    };
  }, [modelUrl, playNonce]);

  const update = useCallback((next: Partial<Model3dState>) => {
    setDirty(true);
    setState(current => ({ ...current, ...next }));
  }, []);

  const toggleHidden = useCallback((index: number) => {
    setState(current => {
      const hidden = current.hidden.includes(index)
        ? current.hidden.filter(value => value !== index)
        : [...current.hidden, index];
      setDirty(true);
      return { ...current, hidden };
    });
  }, []);

  const resetAll = useCallback(() => {
    setState(emptyModel3dState());
    setDirty(false);
    setSelected(null);
    setMoveAmount(0);
    setTravelAmount(20);
    setPlayNonce(0);
    playedNonce.current = 0;
    setModelUrl(src);
  }, [src]);

  const selectedPart = selected === null ? null : parts.find(part => part.index === selected) ?? null;
  const radius = bounds?.radius ?? 1;

  const applyMove = useCallback((amount: number) => {
    setMoveAmount(amount);
    if (selected === null) return;
    const offset: Vec3 = [axis[0] * amount * radius, axis[1] * amount * radius, axis[2] * amount * radius];
    setState(current => {
      const moves = current.moves.filter(move => move.node !== selected);
      if (amount === 0) return { ...current, moves };
      return { ...current, moves: [...moves, { node: selected, offset }] };
    });
    setDirty(true);
  }, [axis, radius, selected]);

  const demoTravel = useCallback(() => {
    if (selected === null) return;
    const distance = (travelAmount / 100) * radius;
    update({
      travel: { node: selected, axis, distance, duration: 2 },
      // 演示行程时把「挪开」的距离先归零：动画里已经带着这段位移了，
      // 再叠一份手动位移，零件会跑到两倍远的地方去。
      moves: state.moves.filter(move => move.node !== selected),
    });
    setMoveAmount(0);
    setPlayNonce(value => value + 1);
  }, [axis, radius, selected, state.moves, travelAmount, update]);

  const hasParts = partList.length > 1;

  return (
    <div className="relative h-full w-full">
      <model-viewer
        ref={setViewer}
        src={modelUrl}
        alt={alt}
        camera-controls
        disable-zoom={false}
        shadow-intensity="0.9"
        shadow-softness="0.7"
        style={{ display: 'block', width: '100%', height: '100%', minHeight: 420 }}
      />

      {structured && (
        <div className="pointer-events-none absolute inset-0 z-30">
          <div className="pointer-events-auto absolute bottom-2 left-2 flex max-h-[85%] w-64 flex-col gap-1.5 rounded-md border border-border bg-background/95 p-1.5 text-xs shadow-lg backdrop-blur">
            <button
              type="button"
              onClick={() => setPanelOpen(value => !value)}
              aria-expanded={panelOpen}
              className="flex min-h-8 items-center justify-between rounded px-2 text-left hover:bg-muted"
            >
              <span>三维操作</span>
              <span aria-hidden="true">{panelOpen ? '收起' : '展开'}</span>
            </button>

            {panelOpen && (
              <>
                <p className="px-1 text-[11px] leading-tight text-muted-foreground">
                  左键拖动旋转 · 右键（或按住 Shift）拖动平移 · 滚轮缩放
                </p>

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
                    value={Math.round(state.explode * 100)}
                    onChange={event => update({ explode: Number(event.target.value) / 100 })}
                  />
                  <span className="w-9 shrink-0 text-right tabular-nums">{percent(state.explode)}</span>
                </label>

                <label className="flex items-center gap-2 px-1">
                  <span className="w-12 shrink-0">透明度</span>
                  <input
                    type="range"
                    className="min-w-0 flex-1"
                    aria-label="整体透明度"
                    min={5}
                    max={100}
                    step={1}
                    value={Math.round(state.alpha * 100)}
                    onChange={event => update({ alpha: Number(event.target.value) / 100 })}
                  />
                  <span className="w-9 shrink-0 text-right tabular-nums">{percent(state.alpha)}</span>
                </label>

                <div className="min-h-0 flex-1 overflow-auto rounded border border-border/70">
                  {partList.length === 0 && (
                    <p className="p-2 text-[11px] leading-tight text-muted-foreground">
                      这份模型里没有可拆的零件。
                    </p>
                  )}
                  {partList.length === 1 && (
                    <p className="p-2 text-[11px] leading-tight text-muted-foreground">
                      这份模型只有一个整体，没有零件结构，拆不开（但可以整体藏起来）。
                    </p>
                  )}
                  {partList.map(part => {
                    const hidden = state.hidden.includes(part.index);
                    return (
                      <div key={part.index} className="flex items-center gap-1 border-b border-border/40 px-1 py-0.5 last:border-b-0">
                        <button
                          type="button"
                          onClick={() => setSelected(part.index === selected ? null : part.index)}
                          className={`min-h-7 min-w-0 flex-1 truncate rounded px-1 text-left hover:bg-muted ${selected === part.index ? 'bg-primary/10 text-primary' : ''}`}
                        >
                          {part.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleHidden(part.index)}
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
                      <span className="ml-auto truncate text-[11px] text-muted-foreground">{selectedPart.name}</span>
                    </div>

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
                        onChange={event => applyMove(Number(event.target.value))}
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
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
