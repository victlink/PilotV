import { afterEach, expect, it, vi } from 'vitest';
import {
  annotationRect,
  annotationStrokes,
  createAnnotation,
  deleteAnnotation,
  fetchArtifactDetail,
  isDrag,
  isUnanchored,
  normalizeRect,
  rectFromDrag,
  setAnnotationStatus,
  type Annotation,
} from './artifactAnnotations';

afterEach(() => vi.unstubAllGlobals());

const DRAG_PX = 6;

it('clamps a dragged rectangle into the normalized range the store accepts', () => {
  expect(normalizeRect({ x: -0.2, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0, y: 0.9, w: 0.5, h: 0.1 });
  expect(normalizeRect({ x: 0.2, y: 0.3, w: 0, h: 0 })).toEqual({ x: 0.2, y: 0.3, w: 0.005, h: 0.005 });
});

it('treats only movement beyond the drag threshold as a box', () => {
  expect(isDrag({ fromX: 10, fromY: 10, toX: 14, toY: 13 })).toBe(false);
  expect(isDrag({ fromX: 10, fromY: 10, toX: 10, toY: 19 })).toBe(true);
});

it('turns a drag inside the stage into a normalized rectangle', () => {
  const rect = rectFromDrag(
    { fromX: 90, fromY: 50, toX: 10, toY: 20 },
    { left: 0, top: 0, width: 100, height: 100 },
  );
  expect(rect).toEqual({ x: 0.1, y: 0.2, w: 0.8, h: 0.3 });
});

it('reads the artifact with its annotations so resolved notes stay visible', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'art_1', file_name: 'a.png', mime: 'image/png', annotations: [] }),
  });
  vi.stubGlobal('fetch', fetchMock);
  const detail = await fetchArtifactDetail('art_1', new AbortController().signal);
  expect(detail.id).toBe('art_1');
  expect(fetchMock.mock.calls[0][0]).toBe('/api/artifacts/art_1');
});

it('posts a point note as a tiny rectangle on the artifact', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ annotation: { id: 'art_1-n1' } }) });
  vi.stubGlobal('fetch', fetchMock);
  await createAnnotation('art_1', { rect: { x: 0.5, y: 0.5, w: 0.005, h: 0.005 }, body: '这里不对' });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('/api/artifacts/art_1/annotations');
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body)).toEqual({
    body: '这里不对',
    severity: 'minor',
    anchor: { rect: { x: 0.5, y: 0.5, w: 0.005, h: 0.005 } },
  });
});

it('refuses to send an empty note instead of letting the store reject it later', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(createAnnotation('art_1', { rect: { x: 0, y: 0, w: 1, h: 1 }, body: '   ' }))
    .rejects.toThrow('不能为空');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('records the video timestamp so a note points at one frame', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ annotation: {} }) });
  vi.stubGlobal('fetch', fetchMock);
  await createAnnotation('art_1', { rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, body: '第 3 秒', t: 3 });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).anchor.t).toBe(3);
});

it('marks a note resolved and can delete it', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValue({ ok: true, json: async () => ({ annotation: {} }) })
    .mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
  await setAnnotationStatus('art_1', 'art_1-n1', 'resolved');
  expect(fetchMock.mock.calls[0][0]).toBe('/api/artifacts/art_1/annotations/art_1-n1');
  expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ status: 'resolved' });
  await deleteAnnotation('art_1', 'art_1-n1');
  expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
});

it('sends hand-drawn ink with a rect derived from its own bounds', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ annotation: {} }) });
  vi.stubGlobal('fetch', fetchMock);
  await createAnnotation('art_1', {
    strokes: [{ color: '#e5484d', w: 0.005, points: [{ x: 0.2, y: 0.3, p: 0.5 }, { x: 0.6, y: 0.8, p: 0.5 }] }],
    body: '这里要改',
  });
  const anchor = JSON.parse(fetchMock.mock.calls[0][1].body).anchor;
  expect(anchor.strokes).toHaveLength(1);
  // The store only ever reads anchor.rect, so a stroke note without one would
  // land in the database but never be placed on the stage again.
  expect(anchor.rect).toEqual({ x: 0.2, y: 0.3, w: 0.4, h: 0.5 });
});

it('refuses a note that has neither a region nor a stroke', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(createAnnotation('art_1', { body: '空标注' })).rejects.toThrow('框选');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('places a note from its strokes when the stored anchor has no rect', () => {
  const note: Annotation = {
    id: 'n1',
    anchor: { strokes: [{ color: '#fff', w: 0.004, points: [{ x: 0.4, y: 0.4, p: 0.5 }, { x: 0.9, y: 0.7, p: 0.5 }] }] },
  };
  expect(annotationRect(note)).toEqual({ x: 0.4, y: 0.4, w: 0.5, h: 0.3 });
  expect(annotationStrokes(note)).toHaveLength(1);
  expect(isUnanchored(note)).toBe(false);
});

it('prefers the stored rect over stroke bounds when a note has both', () => {
  const note: Annotation = {
    id: 'n1',
    anchor: {
      rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      strokes: [{ color: '#fff', w: 0.004, points: [{ x: 0.8, y: 0.8, p: 0.5 }] }],
    },
  };
  expect(annotationRect(note)).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
});

it('flags a note with no position instead of placing it at a made-up spot', () => {
  // This is the note that used to vanish from the stage while still sitting in
  // the list — callers get told so they can render it as unplaced.
  const note: Annotation = { id: 'n1', body: '整体都要改', anchor: null };
  expect(annotationRect(note)).toBeNull();
  expect(isUnanchored(note)).toBe(true);
});