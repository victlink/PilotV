// Freehand ink over an artifact stage.
//
// A stylus samples far faster than the page paints (often 120-240 Hz against a
// 60 Hz display), and coalesced events are the only way to see the samples the
// browser already collected between two frames — dropping them makes fast
// strokes come out as straight chords. So points are captured from
// getCoalescedEvents() and stored in the same 0-1 space as rectangles: the
// annotation anchor survives a resize, a rotate and a different screen.

export type InkPoint = { x: number; y: number; p: number };

export type InkStroke = { color: string; w: number; points: InkPoint[] };

export type StrokeBounds = { x: number; y: number; w: number; h: number };

const round = (value: number) => Math.round(value * 10000) / 10000;
const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

// Width is a fraction of the stage width, so a stroke keeps its visual weight
// when the stage is resized instead of turning into a hairline or a slab.
export const MIN_WIDTH = 0.0015;
export const MAX_WIDTH = 0.05;
const MIN_POINTS = 1;

export function normalizePoint(point: Partial<InkPoint> | null | undefined): InkPoint | null {
  if (!point) return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // Pressure is optional: mice and older pens report 0 or a constant. Treat a
  // constant as "no data" and fall back to a uniform width rather than
  // drawing a stroke that vanishes.
  const raw = Number(point.p);
  const p = Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(raw, 0.05), 1) : 0.5;
  return { x: round(clamp01(x)), y: round(clamp01(y)), p: round(p) };
}

export function normalizeStroke(stroke: Partial<InkStroke> | null | undefined): InkStroke | null {
  if (!stroke || !Array.isArray(stroke.points)) return null;
  const points = stroke.points.map(normalizePoint).filter((point): point is InkPoint => point !== null);
  if (points.length < MIN_POINTS) return null;
  const rawWidth = Number(stroke.w);
  const w = Number.isFinite(rawWidth) && rawWidth > 0
    ? Math.min(Math.max(rawWidth, MIN_WIDTH), MAX_WIDTH)
    : 0.004;
  const color = typeof stroke.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(stroke.color) ? stroke.color : '#e5484d';
  return { color, w: round(w), points };
}

export function normalizeStrokes(strokes: unknown): InkStroke[] {
  if (!Array.isArray(strokes)) return [];
  return strokes.map(normalizeStroke).filter((stroke): stroke is InkStroke => stroke !== null);
}

/** Bounding box of every stroke; also what a stroke-only note anchors on. */
export function strokesBounds(strokes: InkStroke[]): StrokeBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return {
    x: round(clamp01(minX)),
    y: round(clamp01(minY)),
    w: round(clamp01(maxX - minX) || MIN_WIDTH),
    h: round(clamp01(maxY - minY) || MIN_WIDTH),
  };
}

export function strokesPixelWidth(stroke: InkStroke, stageWidth: number): number {
  return Math.max(stroke.w * Math.max(stageWidth, 1), MIN_WIDTH * Math.max(stageWidth, 1), 1);
}

/** Pointer position in 0-1 stage space. */
export function pointFromClient(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number },
  pressure: number,
): InkPoint | null {
  if (!(box.width > 0) || !(box.height > 0)) return null;
  return normalizePoint({
    x: (clientX - box.left) / box.width,
    y: (clientY - box.top) / box.height,
    p: pressure,
  });
}

/**
 * Drop points closer than `tolerance` (in 0-1 stage space) to their predecessor.
 * A slow drag parks the pointer at one spot for hundreds of events; storing them
 * all bloats anchor_json for a stroke that renders identically.
 */
export function dedupePoints(points: InkPoint[], tolerance = 0.0015): InkPoint[] {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const last = out[out.length - 1];
    const point = points[i];
    if (Math.hypot(point.x - last.x, point.y - last.y) >= tolerance) out.push(point);
    // Pressure can change while the tip barely moves; keep the stronger one.
    else if (point.p > last.p) out[out.length - 1] = point;
  }
  return out;
}

/** Drop points that sit on the straight line between their neighbours. */
export function simplifyStroke(stroke: InkStroke, tolerance = 0.0025): InkStroke {
  const points = stroke.points;
  if (points.length < 3) return stroke;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop() as [number, number];
    let far = -1;
    let best = 0;
    for (let i = first + 1; i < last; i += 1) {
      const drop = perpendicularDistance(points[i], points[first], points[last]);
      if (drop > best) { best = drop; far = i; }
    }
    if (far !== -1 && best > tolerance) {
      keep[far] = 1;
      stack.push([first, far], [far, last]);
    }
  }
  return { ...stroke, points: points.filter((_, index) => keep[index] === 1) };
}

function perpendicularDistance(point: InkPoint, a: InkPoint, b: InkPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.min(Math.max(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0), 1);
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** Paint strokes onto a canvas context sized to `box` CSS pixels. */
export function paintStrokes(
  context: CanvasRenderingContext2D,
  strokes: InkStroke[],
  box: { width: number; height: number },
  scale = 1,
): void {
  context.save();
  context.scale(scale, scale);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    const base = strokesPixelWidth(stroke, box.width);
    const at = (point: InkPoint) => ({ x: point.x * box.width, y: point.y * box.height });
    const first = at(stroke.points[0]);
    if (stroke.points.length === 1) {
      // A tap has no direction to draw along, so it has to be a dot. Without
      // this a single-click stroke is invisible and looks like a dropped event.
      context.beginPath();
      context.arc(first.x, first.y, (base * stroke.points[0].p) / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    // Quadratic midpoint smoothing. lineWidth cannot vary along a single path,
    // so each segment is stroked separately at its own pressure.
    for (let i = 1; i < stroke.points.length; i += 1) {
      const previous = at(stroke.points[i - 1]);
      const current = at(stroke.points[i]);
      const next = i + 1 < stroke.points.length ? at(stroke.points[i + 1]) : current;
      context.beginPath();
      context.lineWidth = Math.max(base * stroke.points[i].p, 0.6);
      context.moveTo((previous.x + current.x) / 2, (previous.y + current.y) / 2);
      context.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
      context.stroke();
    }
  }
  context.restore();
}

/**
 * Flatten the stage (media plus ink) into a PNG for the chat composer. Returns
 * null when the browser refuses to rasterize — tainted canvas, mostly — so the
 * caller can fall back to sending text only instead of losing the annotation.
 */
export async function exportStagePng(
  surface: HTMLCanvasElement,
  strokes: InkStroke[],
  options: { background?: string; drawBackground?: (context: CanvasRenderingContext2D, width: number, height: number) => void } = {},
): Promise<Blob | null> {
  const width = surface.width;
  const height = surface.height;
  if (!(width > 0) || !(height > 0)) return null;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const context = out.getContext('2d');
  if (!context) return null;
  context.fillStyle = options.background || '#ffffff';
  context.fillRect(0, 0, width, height);
  options.drawBackground?.(context, width, height);
  paintStrokes(context, strokes, { width, height }, 1);
  return new Promise<Blob | null>(resolve => {
    out.toBlob(blob => resolve(blob), 'image/png');
  });
}
