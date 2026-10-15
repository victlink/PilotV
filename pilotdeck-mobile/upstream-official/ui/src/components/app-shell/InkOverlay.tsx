import { useCallback, useEffect, useRef } from 'react';
import {
  dedupePoints,
  paintStrokes,
  pointFromClient,
  simplifyStroke,
  normalizeStroke,
  type InkStroke,
} from './artifactInk';

// Palm rejection window. A palm resting on the screen reports touches for as
// long as it stays down, often for seconds, and a single stray finger across
// the canvas is enough to smear the ink. Real pens keep emitting pen events
// while the palm is down, so a pen seen this recently wins the surface.
const PEN_ACTIVITY_MS = 900;

type Props = {
  strokes: InkStroke[];
  color: string;
  width: number;
  onStroke: (stroke: InkStroke | null) => void;
  onCommit: (stroke: InkStroke) => void;
  /** Hands the canvas up so the parent can flatten it into a PNG for the chat. */
  onCanvas?: (canvas: HTMLCanvasElement | null) => void;
  disabled?: boolean;
  label?: string;
};

export default function InkOverlay({ strokes, color, width, onStroke, onCommit, onCanvas, disabled, label }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxRef = useRef<DOMRect | null>(null);
  const liveRef = useRef<InkStroke | null>(null);
  const pointerRef = useRef<number | null>(null);
  const lastPenRef = useRef(0);
  const committedRef = useRef<InkStroke[]>(strokes);
  committedRef.current = strokes;

  useEffect(() => {
    onCanvas?.(canvasRef.current);
    return () => onCanvas?.(null);
  }, [onCanvas]);

  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    paintStrokes(context, committedRef.current, { width: box.width, height: box.height }, pixelRatio());
  }, []);

  // The canvas keeps its own bitmap across resizes, so a CSS size change has to
  // re-measure and repaint or the ink sits at the old scale and stops lining up
  // with the pointer coordinates taken from getBoundingClientRect().
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const box = canvas.getBoundingClientRect();
      if (!(box.width > 0) || !(box.height > 0)) return;
      boxRef.current = box;
      const scale = pixelRatio();
      canvas.width = Math.round(box.width * scale);
      canvas.height = Math.round(box.height * scale);
      repaint();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [repaint]);

  useEffect(() => { repaint(); }, [strokes, repaint]);

  const sample = useCallback((event: React.PointerEvent, box: DOMRect) => {
    const live = liveRef.current;
    if (!live) return;
    const pressure = event.pressure > 0 ? event.pressure : 0.5;
    const point = pointFromClient(event.clientX, event.clientY, box, pressure);
    if (point) live.points.push(point);
    const context = canvasRef.current?.getContext('2d');
    if (context) {
      context.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height);
      paintStrokes(context, [...committedRef.current, live], { width: box.width, height: box.height }, pixelRatio());
    }
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (disabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Mouse only reports button 0 for the primary button; pens report 0 on
    // contact and -1 while hovering, so the check has to let the pen through.
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const now = Date.now();
    if (event.pointerType === 'pen') lastPenRef.current = now;
    // Ignore a finger or palm while a pen is actually being used.
    if (event.pointerType === 'touch' && now - lastPenRef.current < PEN_ACTIVITY_MS) return;
    if (pointerRef.current !== null) return;
    const box = canvas.getBoundingClientRect();
    if (!(box.width > 0) || !(box.height > 0)) return;
    boxRef.current = box;
    const point = pointFromClient(event.clientX, event.clientY, box, event.pressure || 0.5);
    if (!point) return;
    pointerRef.current = event.pointerId;
    canvas.setPointerCapture?.(event.pointerId);
    liveRef.current = { color, w: width, points: [point] };
    // Keep the browser from starting a text selection or a scroll gesture
    // halfway through a stroke; both cancel the pointer stream.
    event.preventDefault();
  }, [color, width, disabled]);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    if (pointerRef.current !== event.pointerId || !liveRef.current) return;
    const box = boxRef.current;
    if (!box) return;
    // A stylus reports far more samples than the screen refreshes. Reading only
    // the coalesced tail is what keeps a fast stroke smooth instead of faceted.
    const events = typeof event.nativeEvent.getCoalescedEvents === 'function'
      ? event.nativeEvent.getCoalescedEvents()
      : [];
    if (events.length > 1) {
      for (const entry of events) sample(entry as unknown as React.PointerEvent, box);
    } else {
      sample(event, box);
    }
    event.preventDefault();
  }, [sample]);

  const finish = useCallback((event: React.PointerEvent, cancelled: boolean) => {
    if (pointerRef.current !== event.pointerId) return;
    pointerRef.current = null;
    canvasRef.current?.releasePointerCapture?.(event.pointerId);
    const live = liveRef.current;
    liveRef.current = null;
    if (!live) return;
    const points = dedupePoints(live.points);
    const stroke = cancelled || points.length === 0 ? null : normalizeStroke(simplifyStroke({ ...live, points }));
    // Cancel still clears the ink that was on screen; only the store copy survives.
    onStroke(null);
    if (stroke) onCommit(stroke);
  }, [onCommit, onStroke]);

  const onPointerUp = useCallback((event: React.PointerEvent) => finish(event, false), [finish]);
  const onPointerCancel = useCallback((event: React.PointerEvent) => finish(event, true), [finish]);

  return <canvas
    ref={canvasRef}
    role="application"
    aria-label={label || '手绘标注画布'}
    data-testid="ink-canvas"
    className="absolute inset-0 h-full w-full"
    style={{ touchAction: 'none', cursor: disabled ? 'default' : 'crosshair' }}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerCancel}
  />;
}

function pixelRatio(): number {
  if (typeof window === 'undefined') return 1;
  return Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
}