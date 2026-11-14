// 成果台三维模型的结构化操作。
//
// 为什么要在浏览器里改 glTF，而不是给每个模型单独做一个展示页：
// 成果台里的三维模型千差万别（STEP 装配体 / FCStd 文档 / 网格 / glTF），
// 但「能拆、能藏、能挪、能透明、能走行程」这几件事对它们是一样的。所以这里
// 只做一件事：**把 glTF 当成可以改的数据**，改完再喂回渲染器。
//
// 渲染器还是 model-viewer（成果台已经在用它，不要为了拆解再塞一个 3D 引擎
// 进来）。它只认 glTF/GLB，所以我们把「爆炸 / 隐藏 / 移动 / 透明 / 行程动画」
// 统统落到 glTF 节点与材质上，重新打包成 GLB，交给同一个 <model-viewer>。
//
// 这样做的代价是每次改动都要重新序列化 + 重新装载，所以：
//   - 拖滑块时必须去抖（见 ArtifactModelViewer）；
//   - 相机状态要自己保住（模型一重载，model-viewer 会重新取景）。
//
// 全部是纯函数，不碰 DOM，方便单测。

export type Vec3 = [number, number, number];
/** 四元数，顺序是 glTF 的 xyzw（不是数学里常见的 wxyz）。 */
export type Quat = [number, number, number, number];

export type GltfNode = {
  name?: string;
  children?: number[];
  mesh?: number;
  camera?: number;
  skin?: number;
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  matrix?: number[];
  [key: string]: unknown;
};

export type GltfPrimitive = {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
};

export type GltfMaterial = {
  name?: string;
  alphaMode?: string;
  doubleSided?: boolean;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    metallicFactor?: number;
    roughnessFactor?: number;
  };
  [key: string]: unknown;
};

export type GltfAccessor = {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
};

export type GltfBufferView = {
  buffer?: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
};

export type GltfAnimation = {
  name?: string;
  samplers: Array<{ input: number; output: number; interpolation?: string }>;
  channels: Array<{ sampler: number; target: { node?: number; path: string } }>;
};

export type GltfJson = {
  asset?: { version?: string; generator?: string };
  scene?: number;
  scenes?: Array<{ nodes?: number[]; name?: string }>;
  nodes?: GltfNode[];
  meshes?: Array<{ name?: string; primitives: GltfPrimitive[] }>;
  materials?: GltfMaterial[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: Array<{ byteLength: number; uri?: string }>;
  animations?: GltfAnimation[];
  [key: string]: unknown;
};

export type GlbDocument = {
  json: GltfJson;
  bin: Uint8Array<ArrayBuffer>;
};

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const FLOAT_COMPONENT = 5126;

/** 行程动画在 glTF 里的名字：model-viewer 按名字挑动画，名字必须对得上。 */
export const TRAVEL_ANIMATION_NAME = 'pilotv-travel';

/** 爆炸到 100% 时，零件离开原位的距离占模型半径的比例。 */
export const EXPLODE_SPREAD = 0.6;

export type Transform = { t: Vec3; r: Quat; s: Vec3 };

/** 场景根节点的父空间就是单位变换。 */
const IDENTITY_TRANSFORM: Transform = { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] };

export type ModelPart = {
  /** glTF 节点下标。 */
  index: number;
  name: string;
  /** 这个节点自己带网格（也就是「一个零件」）。只有节点才谈得上拆解。 */
  hasMesh: boolean;
  /** 父节点下标；场景根上是 null。 */
  parent: number | null;
  depth: number;
  /** 世界变换。 */
  world: Transform;
  /** 零件在世界坐标里的中心（网格包围盒中心；没有网格就用节点原点）。 */
  center: Vec3;
  /** 祖先里已经带网格的节点下标；有的话本节点跟着父零件一起动。 */
  ownerPart: number | null;
};

export type ModelBounds = {
  min: Vec3;
  max: Vec3;
  center: Vec3;
  radius: number;
};

export type Model3dState = {
  /** 爆炸程度 0–1。 */
  explode: number;
  /** 整体不透明度 0–1（1 = 不透明）。 */
  alpha: number;
  /** 藏起来的节点下标。 */
  hidden: number[];
  /** 手动挪动的零件：节点下标 → 世界坐标偏移。 */
  moves: Array<{ node: number; offset: Vec3 }>;
  /** 行程动画：让某个零件沿某条轴走一段再走回来。 */
  travel: { node: number; axis: Vec3; distance: number; duration: number } | null;
};

export function emptyModel3dState(): Model3dState {
  return { explode: 0, alpha: 1, hidden: [], moves: [], travel: null };
}

// ── 向量 / 四元数 ────────────────────────────────────────────────────────────

function vec3(value: number[] | undefined, fallback: Vec3): Vec3 {
  if (!value || value.length < 3) return [fallback[0], fallback[1], fallback[2]];
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return fallback;
  return [x, y, z];
}

function quat(value: number[] | undefined, fallback: Quat): Quat {
  if (!value || value.length < 4) return fallback;
  const x = Number(value[0]);
  const y = Number(value[1]);
  const z = Number(value[2]);
  const w = Number(value[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(w)) return fallback;
  return [x, y, z, w];
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** 用四元数旋转向量。 */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** 单位四元数的逆就是共轭。 */
function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

function quatFromColumns(r: number[]): Quat {
  // r 是旋转矩阵的列（glTF 的 matrix 是列主序）：
  // 列 0 = X 轴，列 1 = Y 轴，列 2 = Z 轴。
  const m00 = r[0], m10 = r[1], m20 = r[2];
  const m01 = r[3], m11 = r[4], m21 = r[5];
  const m02 = r[6], m12 = r[7], m22 = r[8];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}

/** glTF 的 matrix（列主序 16 个数）拆成 TRS。 */
function decomposeMatrix(matrix: number[]): Transform {  const sx = Math.hypot(matrix[0], matrix[1], matrix[2]) || 1;
  const sy = Math.hypot(matrix[4], matrix[5], matrix[6]) || 1;
  const sz = Math.hypot(matrix[8], matrix[9], matrix[10]) || 1;
  const columns = [
    matrix[0] / sx, matrix[1] / sx, matrix[2] / sx,
    matrix[4] / sy, matrix[5] / sy, matrix[6] / sy,
    matrix[8] / sz, matrix[9] / sz, matrix[10] / sz,
  ];
  return {
    t: [matrix[12], matrix[13], matrix[14]],
    r: quatFromColumns(columns),
    s: [sx, sy, sz],
  };
}

export function nodeTransform(node: GltfNode | undefined): Transform {
  if (!node) return { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] };
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    const matrix = node.matrix.map(value => Number(value) || 0);
    return decomposeMatrix(matrix);
  }
  return {
    t: vec3(node.translation, [0, 0, 0]),
    r: quat(node.rotation, [0, 0, 0, 1]),
    s: vec3(node.scale, [1, 1, 1]),
  };
}

/** 父变换 × 子变换（世界变换）。 */
export function composeTransform(parent: Transform, local: Transform): Transform {
  const scaled: Vec3 = [
    local.t[0] * parent.s[0],
    local.t[1] * parent.s[1],
    local.t[2] * parent.s[2],
  ];
  const rotated = quatRotate(parent.r, scaled);
  return {
    t: [parent.t[0] + rotated[0], parent.t[1] + rotated[1], parent.t[2] + rotated[2]],
    r: quatMultiply(parent.r, local.r),
    s: [parent.s[0] * local.s[0], parent.s[1] * local.s[1], parent.s[2] * local.s[2]],
  };
}

/**
 * 世界坐标里的位移，换算成父节点局部坐标里的位移。
 *
 * 世界位移 = R_父 · (S_父 ⊙ 局部位移)，所以反过来是
 * 局部位移 = S_父⁻¹ ⊙ (R_父⁻¹ · 世界位移)。
 * 父节点带缩放时不能直接把世界位移加到节点平移上——那会让零件沿着错的方向飞。
 */
export function worldOffsetToLocal(parent: Transform, offset: Vec3): Vec3 {
  const rotated = quatRotate(quatConjugate(parent.r), offset);
  return [
    parent.s[0] === 0 ? rotated[0] : rotated[0] / parent.s[0],
    parent.s[1] === 0 ? rotated[1] : rotated[1] / parent.s[1],
    parent.s[2] === 0 ? rotated[2] : rotated[2] / parent.s[2],
  ];
}

// ── GLB 读写 ─────────────────────────────────────────────────────────────────

/** 解析 GLB（二进制 glTF）。不是 GLB 就返回 null，调用方退回普通预览。 */
export function parseGlb(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): GlbDocument | null {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.byteLength < 12) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) return null;
  if (view.getUint32(4, true) !== 2) return null;
  const total = view.getUint32(8, true);
  const limit = Math.min(total, data.byteLength);
  let json: GltfJson | null = null;
  let bin = new Uint8Array(0);
  let offset = 12;
  while (offset + 8 <= limit) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (length < 0 || start + length > limit) break;
    if (type === CHUNK_JSON && !json) {
      try {
        json = JSON.parse(new TextDecoder().decode(data.subarray(start, start + length))) as GltfJson;
      } catch {
        return null;
      }
    } else if (type === CHUNK_BIN && bin.byteLength === 0) {
      bin = data.subarray(start, start + length);
    }
    offset = start + length;
  }
  if (!json) return null;
  return { json, bin };
}

/** 打包成 GLB。JSON 块用空格补齐、BIN 块用 0 补齐（规范要求）。 */
export function serializeGlb(doc: GlbDocument): Uint8Array<ArrayBuffer> {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(doc.json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunk = new Uint8Array(jsonBytes.length + jsonPad);
  jsonChunk.set(jsonBytes);
  for (let i = jsonBytes.length; i < jsonChunk.length; i += 1) jsonChunk[i] = 0x20;

  const binPad = (4 - (doc.bin.length % 4)) % 4;
  const binChunk = new Uint8Array(doc.bin.length + binPad);
  binChunk.set(doc.bin);

  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonChunk.length, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(jsonChunk, 20);
  const binHeader = 20 + jsonChunk.length;
  view.setUint32(binHeader, binChunk.length, true);
  view.setUint32(binHeader + 4, CHUNK_BIN, true);
  out.set(binChunk, binHeader + 8);
  return out;
}

/** 浅拷贝 JSON + 共享二进制块：每次改动都从原始模型重新算，不叠加。 */
export function cloneDocument(doc: GlbDocument): GlbDocument {
  return { json: JSON.parse(JSON.stringify(doc.json)) as GltfJson, bin: doc.bin };
}

// ── 零件识别 ─────────────────────────────────────────────────────────────────

/** 取 accessor 的包围盒。优先用 glTF 自带的 min/max，没有就去二进制块里扫。 */
function accessorBounds(doc: GlbDocument, accessorIndex: number): { min: Vec3; max: Vec3 } | null {
  const accessor = doc.json.accessors?.[accessorIndex];
  if (!accessor) return null;
  if (accessor.min && accessor.max && accessor.min.length >= 3 && accessor.max.length >= 3) {
    const min = vec3(accessor.min, [0, 0, 0]);
    const max = vec3(accessor.max, [0, 0, 0]);
    return { min, max };
  }
  if (accessor.componentType !== FLOAT_COMPONENT || accessor.type !== 'VEC3') return null;
  const view = doc.json.bufferViews?.[accessor.bufferView ?? -1];
  if (!view) return null;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? 12;
  const count = Math.min(accessor.count, 200000);
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i += 1) {
    const offset = base + i * stride;
    if (offset + 12 > doc.bin.length) break;
    const data = new DataView(doc.bin.buffer, doc.bin.byteOffset + offset, 12);
    const x = data.getFloat32(0, true);
    const y = data.getFloat32(4, true);
    const z = data.getFloat32(8, true);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    min = [Math.min(min[0], x), Math.min(min[1], y), Math.min(min[2], z)];
    max = [Math.max(max[0], x), Math.max(max[1], y), Math.max(max[2], z)];
  }
  if (!Number.isFinite(min[0])) return null;
  return { min, max };
}

/** 节点自己那份网格的包围盒中心（局部坐标）。 */
function meshCenter(doc: GlbDocument, meshIndex: number | undefined): Vec3 | null {
  if (meshIndex === undefined) return null;
  const mesh = doc.json.meshes?.[meshIndex];
  const primitive = mesh?.primitives?.[0];
  const accessorIndex = primitive?.attributes?.POSITION;
  if (accessorIndex === undefined) return null;
  const bounds = accessorBounds(doc, accessorIndex);
  if (!bounds) return null;
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

/** 场景根节点下标。 */
function sceneRoots(doc: GlbDocument): number[] {
  const sceneIndex = doc.json.scene ?? 0;
  const scene = doc.json.scenes?.[sceneIndex];
  return scene?.nodes ? [...scene.nodes] : [];
}

/**
 * 列出模型里的零件。
 *
 * 「零件」= 带网格的节点。装配体导出来的 glTF 一般一个零件一个节点；
 * 整块网格（STEP 转出来没拆开）就只有一个零件，拆解功能对它自然失效——
 * 这时要如实告诉用户，而不是摆一个按不动的按钮。
 */
export function collectParts(doc: GlbDocument): ModelPart[] {
  const nodes = doc.json.nodes ?? [];
  const parts: ModelPart[] = [];
  const byIndex = new Map<number, ModelPart>();

  const visit = (index: number, parent: number | null, depth: number, parentWorld: Transform, ownerPart: number | null) => {
    if (index < 0 || index >= nodes.length) return;
    const node = nodes[index];
    const local = nodeTransform(node);
    const world = composeTransform(parentWorld, local);
    const hasMesh = node.mesh !== undefined;
    const centerLocal = meshCenter(doc, node.mesh);
    const center = centerLocal
      ? (() => {
        const rotated = quatRotate(world.r, [
          centerLocal[0] * world.s[0],
          centerLocal[1] * world.s[1],
          centerLocal[2] * world.s[2],
        ]);
        return [world.t[0] + rotated[0], world.t[1] + rotated[1], world.t[2] + rotated[2]] as Vec3;
      })()
      : ([world.t[0], world.t[1], world.t[2]] as Vec3);
    const part: ModelPart = {
      index,
      name: node.name?.trim() || `零件 ${index + 1}`,
      hasMesh,
      parent,
      depth,
      world,
      center,
      ownerPart,
    };
    parts.push(part);
    byIndex.set(index, part);
    const nextOwner = hasMesh ? index : ownerPart;
    for (const child of node.children ?? []) {
      visit(child, index, depth + 1, world, nextOwner);
    }
  };

  const identity: Transform = IDENTITY_TRANSFORM;
  for (const root of sceneRoots(doc)) visit(root, null, 0, identity, null);
  // 有些导出把节点挂在 scenes 之外（没有 scene 字段），这里兜一遍，避免整棵树丢失。
  if (!parts.length) {
    for (let index = 0; index < nodes.length; index += 1) {
      if ((nodes[index].children ?? []).length === 0 && nodes[index].mesh !== undefined) {
        visit(index, null, 0, identity, null);
      }
    }
  }
  return parts;
}

/** 只留「零件」：带网格、且祖先里没有别的零件（否则它跟着父零件一起动）。 */
export function topLevelParts(parts: ModelPart[]): ModelPart[] {
  return parts.filter(part => part.hasMesh && part.ownerPart === null);
}

/** 零件网格包围盒的八个角（世界坐标）。 */
function worldCorners(doc: GlbDocument, part: ModelPart): Vec3[] {
  const meshIndex = doc.json.nodes?.[part.index]?.mesh;
  const primitive = meshIndex === undefined ? undefined : doc.json.meshes?.[meshIndex]?.primitives?.[0];
  const accessorIndex = primitive?.attributes?.POSITION;
  const bounds = accessorIndex === undefined ? null : accessorBounds(doc, accessorIndex);
  if (!bounds) {
    return [[part.center[0], part.center[1], part.center[2]]];
  }
  const corners: Vec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const rotated = quatRotate(part.world.r, [
          x * part.world.s[0],
          y * part.world.s[1],
          z * part.world.s[2],
        ]);
        corners.push([
          part.world.t[0] + rotated[0],
          part.world.t[1] + rotated[1],
          part.world.t[2] + rotated[2],
        ]);
      }
    }
  }
  return corners;
}

/** 模型整体包围盒（世界坐标）。 */
export function modelBounds(doc: GlbDocument, parts: ModelPart[]): ModelBounds {
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    for (const corner of worldCorners(doc, part)) {
      min = [Math.min(min[0], corner[0]), Math.min(min[1], corner[1]), Math.min(min[2], corner[2])];
      max = [Math.max(max[0], corner[0]), Math.max(max[1], corner[1]), Math.max(max[2], corner[2])];
    }
  }
  if (!Number.isFinite(min[0])) {
    min = [0, 0, 0];
    max = [0, 0, 0];
  }
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.hypot(max[0] - center[0], max[1] - center[1], max[2] - center[2]);
  return { min, max, center, radius: radius || 1 };
}

// ── 状态 → glTF ──────────────────────────────────────────────────────────────

/** 把世界位移写进节点：先拆掉 matrix（有 matrix 时平移字段是不生效的）。 */
function applyWorldOffset(doc: GlbDocument, part: ModelPart, parentWorld: Transform, offset: Vec3): void {
  const node = doc.json.nodes?.[part.index];
  if (!node) return;
  if (Array.isArray(node.matrix)) {
    const decomposed = decomposeMatrix(node.matrix.map(value => Number(value) || 0));
    node.translation = decomposed.t;
    node.rotation = decomposed.r;
    node.scale = decomposed.s;
    delete node.matrix;
  }
  const local = worldOffsetToLocal(parentWorld, offset);
  const current = vec3(node.translation, [0, 0, 0]);
  node.translation = [current[0] + local[0], current[1] + local[1], current[2] + local[2]];
}

/** 从场景里摘掉一个节点（连它的子树一起摘掉）。 */
function detachNode(doc: GlbDocument, index: number): void {
  const nodes = doc.json.nodes ?? [];
  for (const node of nodes) {
    if (!node.children) continue;
    node.children = node.children.filter(child => child !== index);
  }
  const sceneIndex = doc.json.scene ?? 0;
  const scene = doc.json.scenes?.[sceneIndex];
  if (scene?.nodes) scene.nodes = scene.nodes.filter(node => node !== index);
}

/** 给节点加一段「走出去再走回来」的行程动画。 */
function writeTravelAnimation(
  doc: GlbDocument,
  nodeIndex: number,
  base: Vec3,
  travelLocal: Vec3,
  duration: number,
): void {
  const bin = doc.bin;
  const timeBytes = new Float32Array([0, duration / 2, duration]);
  const values = new Float32Array(9);
  for (let i = 0; i < 3; i += 1) {
    values[i * 3] = base[0];
    values[i * 3 + 1] = base[1];
    values[i * 3 + 2] = base[2];
  }
  values[3] = base[0] + travelLocal[0];
  values[4] = base[1] + travelLocal[1];
  values[5] = base[2] + travelLocal[2];
  values[6] = base[0];
  values[7] = base[1];
  values[8] = base[2];

  const timeOffset = bin.length;
  const travelOffset = timeOffset + timeBytes.byteLength;
  const merged = new Uint8Array(travelOffset + values.byteLength);
  merged.set(bin, 0);
  merged.set(new Uint8Array(timeBytes.buffer, timeBytes.byteOffset, timeBytes.byteLength), timeOffset);
  merged.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), travelOffset);
  doc.bin = merged;

  const bufferViews = doc.json.bufferViews ?? (doc.json.bufferViews = []);
  const accessors = doc.json.accessors ?? (doc.json.accessors = []);
  const timeView = bufferViews.push({ buffer: 0, byteOffset: timeOffset, byteLength: timeBytes.byteLength }) - 1;
  const valueView = bufferViews.push({ buffer: 0, byteOffset: travelOffset, byteLength: values.byteLength }) - 1;
  const timeAccessor = accessors.push({
    bufferView: timeView,
    componentType: FLOAT_COMPONENT,
    count: 3,
    type: 'SCALAR',
    min: [0],
    max: [duration],
  }) - 1;
  const valueAccessor = accessors.push({
    bufferView: valueView,
    componentType: FLOAT_COMPONENT,
    count: 3,
    type: 'VEC3',
  }) - 1;

  const animations = doc.json.animations ?? (doc.json.animations = []);
  animations.push({
    name: TRAVEL_ANIMATION_NAME,
    samplers: [{ input: timeAccessor, output: valueAccessor, interpolation: 'LINEAR' }],
    channels: [{ sampler: 0, target: { node: nodeIndex, path: 'translation' } }],
  });

  const buffers = doc.json.buffers ?? (doc.json.buffers = []);
  if (!buffers[0]) buffers[0] = { byteLength: 0 };
  buffers[0].byteLength = merged.length;
}

/**
 * 把界面上的状态落到 glTF 上，返回一份可以重新打包的文档。
 *
 * 顺序有讲究：先爆炸与移动（它们改节点平移），再算行程动画（动画的目标值
 * 必须是移动之后的最终平移），最后才是隐藏与透明度。
 */
export function applyModelState(base: GlbDocument, state: Model3dState): GlbDocument {
  const doc = cloneDocument(base);
  const parts = collectParts(doc);
  const bounds = modelBounds(doc, parts);
  const byIndex = new Map(parts.map(part => [part.index, part]));

  const explodeAmount = Math.max(0, Math.min(1, state.explode));
  const moveByNode = new Map(state.moves.map(move => [move.node, move.offset]));

  for (const part of topLevelParts(parts)) {
    const offset: Vec3 = [0, 0, 0];
    if (explodeAmount > 0) {
      const away: Vec3 = [
        part.center[0] - bounds.center[0],
        part.center[1] - bounds.center[1],
        part.center[2] - bounds.center[2],
      ];
      const length = Math.hypot(away[0], away[1], away[2]);
      if (length > 1e-6) {
        const distance = bounds.radius * EXPLODE_SPREAD * explodeAmount;
        offset[0] += (away[0] / length) * distance;
        offset[1] += (away[1] / length) * distance;
        offset[2] += (away[2] / length) * distance;
      }
    }
    const manual = moveByNode.get(part.index);
    if (manual) {
      offset[0] += manual[0];
      offset[1] += manual[1];
      offset[2] += manual[2];
    }
    if (offset[0] === 0 && offset[1] === 0 && offset[2] === 0) continue;
    const parentWorld = part.parent === null
      ? IDENTITY_TRANSFORM
      : byIndex.get(part.parent)?.world ?? IDENTITY_TRANSFORM;
    applyWorldOffset(doc, part, parentWorld, offset);
  }

  // 行程动画：目标平移必须是「爆炸 + 移动」之后的最终值。
  if (state.travel && state.travel.duration > 0) {
    const part = byIndex.get(state.travel.node);
    if (part) {
      const node = doc.json.nodes?.[part.index];
      const base = vec3(node?.translation, [0, 0, 0]);
      const parentWorld = part.parent === null
        ? IDENTITY_TRANSFORM
        : byIndex.get(part.parent)?.world ?? IDENTITY_TRANSFORM;
      const axis = state.travel.axis;
      const worldOffset: Vec3 = [axis[0] * state.travel.distance, axis[1] * state.travel.distance, axis[2] * state.travel.distance];
      const local = worldOffsetToLocal(parentWorld, worldOffset);
      writeTravelAnimation(doc, part.index, base, local, state.travel.duration);
    }
  }

  // 隐藏：先摘节点，再谈透明。
  for (const index of state.hidden) {
    if (byIndex.has(index)) detachNode(doc, index);
  }

  const alpha = Math.max(0, Math.min(1, state.alpha));
  if (alpha < 1) {
    for (const material of doc.json.materials ?? []) {
      const pbr = material.pbrMetallicRoughness ?? (material.pbrMetallicRoughness = {});
      const base = Array.isArray(pbr.baseColorFactor) && pbr.baseColorFactor.length >= 4
        ? [...pbr.baseColorFactor]
        : [1, 1, 1, 1];
      base[3] = alpha;
      pbr.baseColorFactor = base.map(value => Number(value) || 0);
      material.alphaMode = 'BLEND';
    }
  }

  return doc;
}
