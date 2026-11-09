import { describe, expect, it } from 'vitest';
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
} from './artifactStageViewport';

const fitted = { zoom: MIN_ZOOM, panX: 0, panY: 0 };

describe('clampZoom', () => {
  it('never zooms out past fit or in past the ceiling', () => {
    expect(clampZoom(0.2)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
    expect(clampZoom(2.5)).toBe(2.5);
  });
});

describe('zoomAt', () => {
  it('keeps the content under the center point still', () => {
    const center = { x: 400, y: 300 };
    const zoomed = zoomAt(fitted, 2, center);
    expect(zoomed.zoom).toBe(2);

    // 中心点指向的内容坐标在放大前后必须一致，否则缩放会「甩」。
    const before = (center.x - fitted.panX) / fitted.zoom;
    const after = (center.x - zoomed.panX) / zoomed.zoom;
    expect(after).toBeCloseTo(before, 6);
  });

  it('leaves the viewport alone when the zoom is already clamped', () => {
    expect(zoomAt({ ...fitted, zoom: MAX_ZOOM }, 2, { x: 10, y: 10 })).toEqual({ zoom: MAX_ZOOM, panX: 0, panY: 0 });
  });
});

describe('pinchZoom', () => {
  const start = {
    distance: 100,
    zoom: 1,
    panX: 0,
    panY: 0,
    centerX: 300,
    centerY: 200,
  };

  it('scales by the ratio between the start and current finger distance', () => {
    expect(pinchZoom(start, 200, { x: 300, y: 200 }).zoom).toBe(2);
    expect(pinchZoom(start, 50, { x: 300, y: 200 }).zoom).toBe(MIN_ZOOM);
  });

  it('drags the picture along with a moving midpoint', () => {
    const same = pinchZoom(start, 100, { x: 300, y: 200 });
    expect(same.panX).toBeCloseTo(0, 6);
    expect(same.panY).toBeCloseTo(0, 6);

    // 起手时屏幕 300 处的那个内容点，中点移到 350 之后必须还落在 350。
    // 画面要让内容跟手，相对视口就是往回让位，pan 变负。
    const moved = pinchZoom(start, 200, { x: 350, y: 200 });
    expect((350 - moved.panX) / moved.zoom).toBeCloseTo(300, 6);
    expect(moved.panX).toBeCloseTo(-250, 6);
  });

  it('returns to a fitted picture when the fingers come back together', () => {
    // 第一步：分开到 200，中点右移 —— 画面被放大到 2 倍。
    const zoomed = pinchZoom(start, 200, { x: 350, y: 200 });
    // 第二步：合回原距离 100，中点回到起手位置。
    const restored = pinchZoom(
      { distance: 200, zoom: zoomed.zoom, panX: zoomed.panX, panY: zoomed.panY, centerX: 350, centerY: 200 },
      100,
      { x: 300, y: 200 },
    );
    expect(restored.zoom).toBe(MIN_ZOOM);
    expect(restored.panX).toBeCloseTo(0, 6);
    expect(restored.panY).toBeCloseTo(0, 6);
  });

  it('ignores a degenerate pinch instead of dividing by zero', () => {
    expect(pinchZoom(start, 0, { x: 0, y: 0 })).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });
});

describe('panBy', () => {
  it('adds the finger delta to the current offset', () => {
    expect(panBy({ zoom: 2, panX: 10, panY: -5 }, 30, 12)).toEqual({ zoom: 2, panX: 40, panY: 7 });
  });
});

describe('clampPan', () => {
  const viewportSize = { width: 800, height: 600 };

  it('pins a fitted picture to the centre', () => {
    expect(clampPan({ zoom: 2, panX: 900, panY: 900 }, { width: 800, height: 600 }, viewportSize))
      .toEqual({ zoom: 2, panX: 0, panY: 0 });
  });

  it('allows scrolling exactly to the edge of the overflow', () => {
    // 内容 1600x1200 装进 800x600，每侧多出 400/300。
    const clamped = clampPan({ zoom: 2, panX: 9999, panY: -9999 }, { width: 1600, height: 1200 }, viewportSize);
    expect(clamped.panX).toBe(400);
    expect(clamped.panY).toBe(-300);
  });
});

describe('canPan', () => {
  it('only pans once the picture is actually bigger than the frame', () => {
    expect(canPan(fitted)).toBe(false);
    expect(canPan({ ...fitted, zoom: 1.2 })).toBe(true);
  });
});

describe('touch helpers', () => {
  it('measures the finger distance and midpoint', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 30, y: 40 };
    expect(touchDistance([a, b])).toBe(50);
    expect(touchMidpoint([a, b])).toEqual({ x: 15, y: 20 });
  });

  it('degrades gracefully with fewer than two touches', () => {
    expect(touchDistance([{ x: 3, y: 4 }])).toBe(0);
    expect(touchMidpoint([])).toEqual({ x: 0, y: 0 });
    expect(touchMidpoint([{ x: 3, y: 4 }])).toEqual({ x: 3, y: 4 });
  });
});

describe('formatZoom', () => {
  it('rounds to a readable ratio', () => {
    expect(formatZoom(1)).toBe('1×');
    expect(formatZoom(1.254)).toBe('1.25×');
  });
});