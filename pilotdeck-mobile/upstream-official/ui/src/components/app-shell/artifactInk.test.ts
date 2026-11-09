import { expect, it } from 'vitest';
import {
  dedupePoints,
  normalizePoint,
  normalizeStroke,
  normalizeStrokes,
  pointFromClient,
  simplifyStroke,
  strokesBounds,
  strokesPixelWidth,
  MAX_WIDTH,
  MIN_WIDTH,
  type InkStroke,
} from './artifactInk';

const stroke = (points: Array<[number, number, number?]>): InkStroke => ({
  color: '#e5484d',
  w: 0.004,
  points: points.map(([x, y, p]) => ({ x, y, p: p ?? 0.5 })),
});

it('keeps pointer positions inside the stage no matter where the drag leaves it', () => {
  expect(pointFromClient(-40, 500, { left: 0, top: 0, width: 100, height: 100 }, 0.6))
    .toEqual({ x: 0, y: 1, p: 0.6 });
  expect(pointFromClient(50, 25, { left: 10, top: 20, width: 100, height: 100 }, 0.4))
    .toEqual({ x: 0.4, y: 0.05, p: 0.4 });
});

it('refuses to normalize a point from a stage that has no size yet', () => {
  // A stage measured mid-layout reports 0x0; dividing by it would give NaN
  // coordinates that then get written into the anchor.
  expect(pointFromClient(10, 10, { left: 0, top: 0, width: 0, height: 0 }, 0.5)).toBeNull();
  expect(normalizePoint({ x: Number.NaN, y: 0.5, p: 0.5 })).toBeNull();
});

it('treats a pen that reports no pressure as a constant-width stroke', () => {
  // Browsers report 0 pressure for mouse and for a pen that has not been
  // calibrated. Reading that as pressure would collapse the stroke to zero
  // width and make it look like the event was dropped.
  expect(normalizePoint({ x: 0.5, y: 0.5, p: 0 })?.p).toBe(0.5);
  expect(normalizePoint({ x: 0.5, y: 0.5, p: 3 })?.p).toBe(1);
});

it('rejects strokes that could not be drawn', () => {
  expect(normalizeStroke({ color: '#fff', w: 0.004, points: [] })).toBeNull();
  expect(normalizeStroke(null)).toBeNull();
  expect(normalizeStrokes('not-a-list')).toEqual([]);
  expect(normalizeStrokes([stroke([[0.1, 0.1]]), { points: [] }])).toHaveLength(1);
});

it('falls back to a sane colour and width when the stored stroke is damaged', () => {
  const stored = normalizeStroke({ color: 'url(#evil)', w: 99, points: [{ x: 0.2, y: 0.2, p: 0.5 }] });
  expect(stored?.color).toBe('#e5484d');
  expect(stored?.w).toBe(MAX_WIDTH);
  const thin = normalizeStroke({ color: '#000000', w: 0.000001, points: [{ x: 0.2, y: 0.2, p: 0.5 }] });
  expect(thin?.w).toBe(MIN_WIDTH);
});

it('drops points parked on one spot while keeping pressure changes', () => {
  const points = dedupePoints([
    { x: 0.1, y: 0.1, p: 0.5 },
    { x: 0.1, y: 0.1, p: 0.5 },
    { x: 0.1, y: 0.1, p: 0.9 },
    { x: 0.2, y: 0.1, p: 0.5 },
  ]);
  expect(points).toHaveLength(2);
  expect(points[0].p).toBe(0.9);
});

it('simplifies a straight run without moving the points it keeps', () => {
  const flat = simplifyStroke(stroke([[0.1, 0.5], [0.2, 0.5], [0.3, 0.5], [0.4, 0.5]]));
  expect(flat.points.map(point => point.x)).toEqual([0.1, 0.4]);
  const bent = simplifyStroke(stroke([[0.1, 0.1], [0.5, 0.9], [0.9, 0.1]]));
  expect(bent.points).toHaveLength(3);
});

it('anchors a stroke-only note on the ink bounding box', () => {
  const bounds = strokesBounds([
    stroke([[0.2, 0.3], [0.6, 0.3]]),
    stroke([[0.4, 0.8]]),
  ]);
  expect(bounds).toEqual({ x: 0.2, y: 0.3, w: 0.4, h: 0.5 });
  expect(strokesBounds([])).toBeNull();
});

it('never reports a zero-area box for a single tap', () => {
  // A dot drawn in one tap still has to place its marker, and a 0x0 rect is
  // what made stroke notes disappear from the stage entirely.
  expect(strokesBounds([stroke([[0.7, 0.7]])])).toEqual({ x: 0.7, y: 0.7, w: MIN_WIDTH, h: MIN_WIDTH });
});

it('scales stroke width with the stage so a resize does not thin the ink', () => {
  const line = stroke([[0, 0], [1, 1]]);
  expect(strokesPixelWidth(line, 400)).toBeCloseTo(1.6);
  expect(strokesPixelWidth(line, 1200)).toBeCloseTo(4.8);
  expect(strokesPixelWidth(line, 0)).toBeGreaterThan(0);
});
