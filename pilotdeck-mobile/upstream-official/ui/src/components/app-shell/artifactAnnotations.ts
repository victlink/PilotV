// Reviewer notes on an artifact: read them with the artifact, write them through the
// console API. The store normalizes rectangles to 0-1 against the preview stage, so
// every coordinate that crosses this boundary has to be normalized here too.
//
// Ink notes carry `anchor.strokes` instead of a box. The store keeps anchor_json
// verbatim (artifacts_store.py add_annotation only ever adds keys), so no schema
// change was needed — but it also only ever reads `anchor.rect`, so a stroke note
// still sends a rect derived from its own bounding box. That keeps older consumers
// positioning the marker correctly instead of dropping the note for having no rect.

import { normalizeStrokes, strokesBounds, type InkStroke } from './artifactInk';

export type Rect = { x: number; y: number; w: number; h: number };

export type Anchor = {
  rect?: Rect | null;
  strokes?: InkStroke[] | null;
  t?: number | null;
  frame?: number | null;
} | null;

export type Annotation = {
  id: string;
  seq?: number | null;
  severity?: string | null;
  body?: string | null;
  surface?: string | null;
  status?: string | null;
  anchor?: Anchor;
  created_at?: string | null;
};

export type ArtifactDetail = {
  id: string;
  kind?: string | null;
  title?: string | null;
  file_name?: string | null;
  mime?: string | null;
  meta?: Record<string, unknown> | null;
  annotations?: Annotation[] | null;
};

const MIN_SIZE = 0.005;
const DRAG_PX = 6;

export function normalizeRect(rect: Rect): Rect {
  const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
  const x = clamp(Number(rect.x) || 0, 0, 1);
  const y = clamp(Number(rect.y) || 0, 0, 1);
  const round = (value: number) => Math.round(value * 10000) / 10000;
  return {
    x: round(x),
    y: round(y),
    w: round(Math.min(Math.max(Number(rect.w) || 0, MIN_SIZE), 1 - x)),
    h: round(Math.min(Math.max(Number(rect.h) || 0, MIN_SIZE), 1 - y)),
  };
}

export type DragPoints = { fromX: number; fromY: number; toX: number; toY: number };

/** Movement below the threshold is a click on a point, not a box. */
export function isDrag(points: DragPoints): boolean {
  return Math.hypot(points.toX - points.fromX, points.toY - points.fromY) >= DRAG_PX;
}

/** Drag in stage pixels becomes a rectangle normalized against the stage box. */
export function rectFromDrag(points: DragPoints, box: { left: number; top: number; width: number; height: number }): Rect {
  const left = Math.min(points.fromX, points.toX);
  const top = Math.min(points.fromY, points.toY);
  return normalizeRect({
    x: (left - box.left) / box.width,
    y: (top - box.top) / box.height,
    w: (Math.abs(points.toX - points.fromX)) / box.width,
    h: (Math.abs(points.toY - points.fromY)) / box.height,
  });
}

export function rectAt(x: number, y: number): Rect {
  return { x, y, w: MIN_SIZE, h: MIN_SIZE };
}

async function readJson(response: Response, what: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${what}（HTTP ${response.status}）`);
  return response.json();
}

export async function fetchArtifactDetail(artifactId: string, signal?: AbortSignal): Promise<ArtifactDetail> {
  const data = await readJson(await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}`, { signal }), '成果读取失败');
  return data as ArtifactDetail;
}

export async function createAnnotation(
  artifactId: string,
  input: { rect?: Rect | null; strokes?: InkStroke[] | null; body: string; severity?: string; t?: number | null },
): Promise<Annotation> {
  const body = (input.body || '').trim();
  if (!body) throw new Error('标注内容不能为空');
  const strokes = normalizeStrokes(input.strokes);
  const anchor: Anchor = {};
  // A stroke-only note needs a rect anyway: the marker and every consumer that
  // has never heard of ink read anchor.rect, and a null one makes the note
  // render nowhere.
  const rect = input.rect ?? (strokes.length ? strokesBounds(strokes) : null);
  if (rect) anchor.rect = normalizeRect(rect);
  if (strokes.length) anchor.strokes = strokes;
  if (typeof input.t === 'number' && Number.isFinite(input.t)) anchor.t = Math.max(0, input.t);
  if (!anchor.rect && !strokes.length) throw new Error('标注需要框选一块区域或画一笔');
  const payload = JSON.stringify({ body, severity: input.severity || 'minor', anchor });
  const data = await readJson(
    await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/annotations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
    }),
    '标注保存失败',
  ) as { annotation?: Annotation };
  return data.annotation as Annotation;
}

export async function setAnnotationStatus(artifactId: string, noteId: string, status: 'open' | 'resolved'): Promise<void> {
  await readJson(await fetch(
    `/api/artifacts/${encodeURIComponent(artifactId)}/annotations/${encodeURIComponent(noteId)}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) },
  ), '标注状态更新失败');
}

export async function deleteAnnotation(artifactId: string, noteId: string): Promise<void> {
  await readJson(await fetch(
    `/api/artifacts/${encodeURIComponent(artifactId)}/annotations/${encodeURIComponent(noteId)}`,
    { method: 'DELETE' },
  ), '标注删除失败');
}

export function annotationStrokes(note: Annotation): InkStroke[] {
  return normalizeStrokes(note.anchor?.strokes);
}

/**
 * Where a note's marker belongs. Rect wins when present; a stroke note falls
 * back to its own bounding box so hand-drawn notes are placed, not discarded.
 * Null means the store genuinely has no position for this note, and callers
 * have to surface it as unplaced rather than render it at a made-up spot.
 */
export function annotationRect(note: Annotation): Rect | null {
  const rect = note.anchor?.rect;
  if (rect && typeof rect.x === 'number') return rect;
  return strokesBounds(annotationStrokes(note));
}

/** Notes the store has no position for: visible in the list, nowhere on the stage. */
export function isUnanchored(note: Annotation): boolean {
  return annotationRect(note) === null;
}
