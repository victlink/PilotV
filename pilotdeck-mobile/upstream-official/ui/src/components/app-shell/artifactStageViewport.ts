/**
 * 成果画面的缩放／平移数学。单独抽出来是因为这部分不依赖 React，
 * 手感只能靠"数值对不对"来判断，写成纯函数才能测。
 *
 * 坐标约定：pan 是画面相对视口的位移，内容居中，所以内容比视口大的时候
 * 每一侧多出来的空间各占一半，平移上限就是 (内容 - 视口) / 2。
 */
export type StageViewport = { zoom: number; panX: number; panY: number };

/** 1 = 适应屏幕。再小没有意义（本来就能看全），再大数字上没有任何新信息。 */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

/** 双指捏合时记住的起始状态。 */
export type PinchStart = {
  distance: number;
  zoom: number;
  panX: number;
  panY: number;
  /** 起手时两指中点（视口坐标）。缩放要围着它走，中点才会跟手。 */
  centerX: number;
  centerY: number;
};

export type Point = { x: number; y: number };

export const clampZoom = (zoom: number): number => {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
};

/**
 * 平移范围：内容没有超出视口时必须锁死回中心，否则「适应」状态下
 * 还能把图拖走，只会让用户以为图不见了。
 */
export const clampPan = (
  viewport: StageViewport,
  content: { width: number; height: number },
  viewportSize: { width: number; height: number },
): StageViewport => {
  const limitX = Math.max(0, (content.width - viewportSize.width) / 2);
  const limitY = Math.max(0, (content.height - viewportSize.height) / 2);
  return {
    zoom: clampZoom(viewport.zoom),
    panX: Math.min(limitX, Math.max(-limitX, viewport.panX)),
    panY: Math.min(limitY, Math.max(-limitY, viewport.panY)),
  };
};

/**
 * 围着某个点缩放：这个点在屏幕上不能动。公式是把「视口坐标 → 内容坐标」
 * 的映射在新倍率下重算一次，保证内容上的同一个像素仍然落在手指底下。
 */
export const zoomAt = (viewport: StageViewport, factor: number, center: Point): StageViewport => {
  const zoom = clampZoom(viewport.zoom * factor);
  if (zoom === viewport.zoom) return viewport;
  return {
    zoom,
    panX: center.x - (zoom * (center.x - viewport.panX)) / viewport.zoom,
    panY: center.y - (zoom * (center.y - viewport.panY)) / viewport.zoom,
  };
};

/**
 * 双指捏合。中点也跟着走：手指整体平移时画面要平移，不能只是放大。
 */
export const pinchZoom = (start: PinchStart, distance: number, center: Point): StageViewport => {
  if (start.distance <= 0 || distance <= 0) {
    return { zoom: clampZoom(start.zoom), panX: start.panX, panY: start.panY };
  }
  const zoom = clampZoom((start.zoom * distance) / start.distance);
  return {
    zoom,
    panX: center.x - (zoom * (start.centerX - start.panX)) / start.zoom,
    panY: center.y - (zoom * (start.centerY - start.panY)) / start.zoom,
  };
};

export const panBy = (start: StageViewport, dx: number, dy: number): StageViewport => ({
  zoom: start.zoom,
  panX: start.panX + dx,
  panY: start.panY + dy,
});

/** 内容比视口小的时候不允许平移：适应屏幕的状态下画面就该是钉死的。 */
export const canPan = (viewport: StageViewport): boolean => viewport.zoom > MIN_ZOOM;

export const touchDistance = (points: Point[]): number => {
  if (points.length < 2) return 0;
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
};

export const touchMidpoint = (points: Point[]): Point => {
  if (points.length < 2) return points[0] ?? { x: 0, y: 0 };
  return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
};

/** 倍率显示用：1 倍不显示小数，1.5 倍要看得清。 */
export const formatZoom = (zoom: number): string => `${Math.round(zoom * 100) / 100}×`;
