// 成果台三维展示台的纯逻辑。
//
// 这里不碰 three、也不碰 DOM —— 只有「怎么把一棵场景树拆成零件」「怎么算相机
// 该站多远」「爆炸往哪边挪」这几件事。渲染在 threeStage.ts，界面在
// ArtifactModelViewer.tsx；把它们都写成纯函数是为了能单测：三维展示台最难
// 复现的 bug 都在「零件认错了」和「相机站错了」这两处。
//
// 为什么自己认零件，而不是直接用 glTF 的节点：
//   - CAD 转出来的 GLB 是一个零件一个节点（我们自己导的，语义清楚）；
//   - Blender 导出来的往往是一棵空节点树：对象 → 空节点 → 网格，名字挂在
//     中间那层上，直接按节点列清单用户看到的是一堆「Cube.001」；
//   - 更糟的是有人把整个装配体包在一个根节点里，按根节点列就只有「一个零件」。
// 所以规则是：**从网格往上找到「只含这一个网格」的最高祖先**，那一层就是零件。
// 这样 CAD 的单零件节点、单网格对象、被包起来的装配体都能落到对的地方。

export type Vec3 = [number, number, number];

/**
 * 多零件装配的默认配色。
 *
 * 一整块灰的装配体看不出谁是谁，所以零件一多就按这套颜色分。顺序是按
 * 「亮度差得开、彼此不像」挑的：深蓝 → 橙 → 青 → 紫 → 黄绿 → 砖红 → 天蓝 →
 * 粉 → 墨绿 → 芥末 → 靛 → 青柠。首尾两个深色挨在一起时颜色会靠得近，
 * 但 CAD 装配体一般不会刚好排到第 12 个零件。
 */
export const PART_PALETTE: string[] = [
  '#3b6ea5', '#e07b39', '#2f9e8f', '#8a63c4', '#9bbd2a', '#c2553f',
  '#4c8fd6', '#d2649a', '#3f7d4f', '#c2a03c',
  '#5a5fc7', '#7fc24a',
];

/** 第 i 个零件该用哪个颜色（多了就绕回来）。 */
export function paletteColor(index: number): string {
  if (!PART_PALETTE.length) return '#8a94a6';
  const safe = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  return PART_PALETTE[safe % PART_PALETTE.length];
}

/** 一个网格的摘要（world 坐标下的包围球）。 */
export type MeshSummary = {
  /** 唯一标识：用来把分组结果映射回 three 里的对象。 */
  key: string;
  name: string;
  vertexCount: number;
  /** 材质里带贴图（贴图模型要按原材质渲染，不能被分色盖掉）。 */
  textured: boolean;
  center: Vec3;
  radius: number;
};

/** 场景树里的一个节点摘要。 */
export type NodeSummary = {
  key: string;
  name: string;
  /** 直接挂在这个节点上的网格。 */
  meshes: MeshSummary[];
  children: NodeSummary[];
};

/** 一个「零件」：可以整体选中、隐藏、移动、改色的最小单位。 */
export type PartGroup = {
  id: string;
  name: string;
  meshes: MeshSummary[];
  vertexCount: number;
  textured: boolean;
  /** 零件包围球中心（world）。 */
  center: Vec3;
  radius: number;
};

function meshCount(node: NodeSummary): number {
  let total = node.meshes.length;
  for (const child of node.children) total += meshCount(child);
  return total;
}

function averageCenter(meshes: MeshSummary[]): Vec3 {
  if (!meshes.length) return [0, 0, 0];
  const sum: Vec3 = [0, 0, 0];
  for (const mesh of meshes) {
    sum[0] += mesh.center[0];
    sum[1] += mesh.center[1];
    sum[2] += mesh.center[2];
  }
  return [sum[0] / meshes.length, sum[1] / meshes.length, sum[2] / meshes.length];
}

function distance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 把场景树拆成零件。
 *
 * 规则见文件头的说明：从每个网格往上爬，停在「子树里只有这一个网格」的最高
 * 祖先。爬不上去（父节点下面还有别的网格）就以该网格自己为准。
 */
export function groupParts(root: NodeSummary): PartGroup[] {
  const parents = new Map<string, NodeSummary>();
  const index = (node: NodeSummary) => {
    for (const child of node.children) {
      parents.set(child.key, node);
      index(child);
    }
  };
  index(root);

  const groups = new Map<string, PartGroup>();
  const order: string[] = [];

  const visit = (node: NodeSummary) => {
    for (const mesh of node.meshes) {
      // 往上找「只含这一个网格」的最高祖先。
      let container = node;
      let parent = parents.get(node.key);
      while (parent && meshCount(parent) === 1) {
        container = parent;
        parent = parents.get(parent.key);
      }
      // 一个节点上挂了好几个网格（多材质/多 primitive）时，它们各自算一个零件：
      // 在 three 里它们本来就是分开的对象，能单独挑出来看。
      const id = container.meshes.length === 1
        ? `node:${container.key}`
        : `mesh:${mesh.key}`;
      let group = groups.get(id);
      if (!group) {
        group = {
          id,
          name: mesh.name || container.name || '零件',
          meshes: [],
          vertexCount: 0,
          textured: false,
          center: [0, 0, 0],
          radius: 0,
        };
        groups.set(id, group);
        order.push(id);
      }
      group.meshes.push(mesh);
      group.vertexCount += mesh.vertexCount;
      group.textured = group.textured || mesh.textured;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);

  for (const id of order) {
    const group = groups.get(id);
    if (!group) continue;
    const center = averageCenter(group.meshes);
    let radius = 0;
    for (const mesh of group.meshes) {
      radius = Math.max(radius, distance(center, mesh.center) + mesh.radius);
    }
    group.center = center;
    group.radius = radius;
    if (!group.name) group.name = `零件 ${order.indexOf(id) + 1}`;
  }

  return order.map(id => groups.get(id)).filter((group): group is PartGroup => Boolean(group));
}

/** 零件中心相对模型中心的方向（单位向量）。零件正好在中心上时没有方向。 */
export function explodeDirection(center: Vec3, modelCenter: Vec3): Vec3 {
  const dx = center[0] - modelCenter[0];
  const dy = center[1] - modelCenter[1];
  const dz = center[2] - modelCenter[2];
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!Number.isFinite(length) || length < 1e-9) return [0, 0, 0];
  return [dx / length, dy / length, dz / length];
}

/**
 * 相机该站多远，才能把半径为 radius 的模型完整装进画面。
 *
 * 竖直视场角和横直视场角要一起算：窗口很扁的时候横向才是瓶颈（模型左右
 * 两边会掉出画面）。再留一点余量，免得模型贴着边框。
 */
export function fitDistance(radius: number, fovDeg: number, aspect: number, margin = 1.18): number {
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : 1;
  const vertical = (Number.isFinite(fovDeg) ? fovDeg : 45) * Math.PI / 180;
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * safeAspect);
  const fov = Math.min(vertical, horizontal);
  const distance = safeRadius / Math.max(0.05, Math.sin(fov / 2));
  return distance * (Number.isFinite(margin) && margin > 0 ? margin : 1);
}

/** 缩放倍率 → 相机到目标的距离。倍率越大站得越近。 */
export function zoomDistance(baseDistance: number, zoom: number): number {
  const safeZoom = Number.isFinite(zoom) && zoom > 0.05 ? zoom : 1;
  return baseDistance / safeZoom;
}

/**
 * 按模型的包围盒取景，算出相机该站多远。
 *
 * 为什么不用包围球：球把「长条形的装配体」也当成球来装，相机就得站得很远，
 * 画面里模型只占中间一小块。包围盒 + 实际视线方向算出来才准。
 *
 * 做法：把包围盒八个角都摆到相机坐标系里，逐个要求它们落在视锥内
 * （左右看视场角 × 宽高比，上下看视场角），取最远的那个距离。
 */
export function fitDistanceForBox(
  box: { min: Vec3; max: Vec3 },
  direction: Vec3,
  fovDeg: number,
  aspect: number,
  margin = 1.06,
): number {
  const safeFov = (Number.isFinite(fovDeg) ? fovDeg : 45) * Math.PI / 180;
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const tan = Math.max(0.05, Math.tan(safeFov / 2));

  const dir = normalize(direction);
  // 相机自己的上方向：跟视线垂直的那一根。
  const worldUp: Vec3 = Math.abs(dir[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(dir, worldUp));
  const up = cross(right, dir);

  let distance = 0;
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) {
        const offset: Vec3 = [x, y, z];
        const forward = offset[0] * dir[0] + offset[1] * dir[1] + offset[2] * dir[2];
        const horizontal = Math.abs(offset[0] * right[0] + offset[1] * right[1] + offset[2] * right[2]);
        const vertical = Math.abs(offset[0] * up[0] + offset[1] * up[1] + offset[2] * up[2]);
        distance = Math.max(
          distance,
          forward + horizontal / (tan * safeAspect),
          forward + vertical / tan,
        );
      }
    }
  }
  return Math.max(1e-3, distance) * (Number.isFinite(margin) && margin > 0 ? margin : 1);
}

function normalize(v: Vec3): Vec3 {
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (!Number.isFinite(length) || length < 1e-9) return [0, 0, 1];
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * 行程动画的位移比例：0 → 0，0.5 → 1（一），1 → 0。
 *
 * 走出去再走回来，比走到头停在那儿好讲：讲解时「往返一次」比「顶到头」更像
 * 真实的行程演示。
 */
export function travelProgress(t: number): number {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  return Math.sin(Math.PI * clamped);
}

/** 把 [0,1] 的比例夹住，顺手挡掉 NaN。 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
