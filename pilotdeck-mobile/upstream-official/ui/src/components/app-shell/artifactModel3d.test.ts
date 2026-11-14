import { describe, expect, it } from 'vitest';
import {
  TRAVEL_ANIMATION_NAME,
  applyModelState,
  collectParts,
  emptyModel3dState,
  modelBounds,
  parseGlb,
  serializeGlb,
  topLevelParts,
  type GltfJson,
} from './artifactModel3d';

/**
 * 造一份两零件的装配体：part-a 在原点，part-b 在 X=10。
 *
 * 网格坐标是**节点局部坐标**（accessor 的 min/max 属于局部空间），所以这里
 * 零件自己的顶点就在它该在的地方，节点平移保持单位阵 —— 这正是成果台转换器
 * 导出来的样子（顶点用绝对坐标，一个零件一个节点）。
 */
function assemblyJson(): GltfJson {
  return {
    asset: { version: '2.0', generator: 'test' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { name: 'part-a', mesh: 0, translation: [0, 0, 0] },
      { name: 'part-b', mesh: 1, translation: [0, 0, 0] },
    ],
    meshes: [
      { name: 'part-a', primitives: [{ attributes: { POSITION: 0 } }] },
      { name: 'part-b', primitives: [{ attributes: { POSITION: 1 } }] },
    ],
    accessors: [
      { componentType: 5126, count: 1, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] },
      { componentType: 5126, count: 1, type: 'VEC3', min: [9, -1, -1], max: [11, 1, 1] },
    ],
    materials: [
      { name: 'cad', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.3, 0.34, 0.4, 1] } },
    ],
    buffers: [{ byteLength: 0 }],
    bufferViews: [],
  };
}

function assemblyGlb(): Uint8Array<ArrayBuffer> {
  return serializeGlb({ json: assemblyJson(), bin: new Uint8Array(0) });
}

describe('glTF 读写', () => {
  it('GLB 解析出来还能原样打包回去', () => {
    const parsed = parseGlb(assemblyGlb());
    expect(parsed).not.toBeNull();
    expect(parsed?.json.nodes?.map(node => node.name)).toEqual(['part-a', 'part-b']);
    // 再打一次包还能解析，说明 chunk 长度与对齐都对。
    expect(parseGlb(serializeGlb(parsed!))).not.toBeNull();
  });

  it('不是 GLB 的东西老实说不是，不硬解', () => {
    expect(parseGlb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
    expect(parseGlb(new Uint8Array(0))).toBeNull();
  });
});

describe('零件识别', () => {
  it('带网格的节点就是零件，中心按网格包围盒算', () => {
    const doc = parseGlb(assemblyGlb())!;
    const parts = collectParts(doc);
    expect(parts.map(part => part.name)).toEqual(['part-a', 'part-b']);
    // part-b 的网格中心在 X=10（节点也在 X=10，所以两者一致）。
    expect(parts[1].center[0]).toBeCloseTo(10);
    expect(topLevelParts(parts)).toHaveLength(2);
  });

  it('模型的包围盒与半径按世界坐标算', () => {
    const doc = parseGlb(assemblyGlb())!;
    const bounds = modelBounds(doc, collectParts(doc));
    expect(bounds.min[0]).toBeCloseTo(-1);
    expect(bounds.max[0]).toBeCloseTo(11);
    expect(bounds.center[0]).toBeCloseTo(5);
  });
});

describe('爆炸图', () => {
  it('零件沿着离开中心的方向散开，而且左右各走各的', () => {
    const doc = parseGlb(assemblyGlb())!;
    const exploded = applyModelState(doc, { ...emptyModel3dState(), explode: 1 });
    const a = exploded.json.nodes?.[0].translation as number[];
    const b = exploded.json.nodes?.[1].translation as number[];
    // part-a 在中心左边，爆炸后往 X 负方向走；part-b 往 X 正方向走。
    expect(a[0]).toBeLessThan(0);
    expect(b[0]).toBeGreaterThan(0);
    // 两者对称：离中心一样远。
    expect(a[0]).toBeCloseTo(-b[0]);
  });

  it('爆炸程度为 0 时一动不动', () => {
    const doc = parseGlb(assemblyGlb())!;
    const intact = applyModelState(doc, emptyModel3dState());
    expect(intact.json.nodes?.[0].translation).toEqual([0, 0, 0]);
    expect(intact.json.nodes?.[1].translation).toEqual([0, 0, 0]);
  });
});

describe('隐藏零件', () => {
  it('藏起来的零件从场景里摘掉，其他零件不受影响', () => {
    const doc = parseGlb(assemblyGlb())!;
    const hidden = applyModelState(doc, { ...emptyModel3dState(), hidden: [1] });
    expect(hidden.json.scenes?.[0].nodes).toEqual([0]);
    expect(hidden.json.nodes?.[1]).toBeDefined();
  });
});

describe('透明度', () => {
  it('透明度改的是材质的 alpha，并且材质切成 BLEND', () => {
    const doc = parseGlb(assemblyGlb())!;
    const faded = applyModelState(doc, { ...emptyModel3dState(), alpha: 0.4 });
    const material = faded.json.materials?.[0];
    expect(material?.pbrMetallicRoughness?.baseColorFactor?.[3]).toBeCloseTo(0.4);
    expect(material?.alphaMode).toBe('BLEND');
    // 不透明度是 1 时不动材质。
    const solid = applyModelState(doc, emptyModel3dState());
    expect(solid.json.materials?.[0].alphaMode).toBeUndefined();
  });
});

describe('移动零件', () => {
  it('挪动量是父节点局部坐标里的位移', () => {
    const doc = parseGlb(assemblyGlb())!;
    const moved = applyModelState(doc, {
      ...emptyModel3dState(),
      moves: [{ node: 1, offset: [3, 0, 0] }],
    });
    expect(moved.json.nodes?.[1].translation).toEqual([3, 0, 0]);
  });
});

describe('行程动画', () => {
  it('写进去的是一段「走出去再走回来」的动画', () => {
    const doc = parseGlb(assemblyGlb())!;
    const animated = applyModelState(doc, {
      ...emptyModel3dState(),
      travel: { node: 1, axis: [0, 1, 0], distance: 5, duration: 2 },
    });
    const animation = animated.json.animations?.[0];
    expect(animation?.name).toBe(TRAVEL_ANIMATION_NAME);
    expect(animation?.channels?.[0].target).toEqual({ node: 1, path: 'translation' });
    // 采样器的时间轴要有 min/max（glTF 规范要求），而且落在动画时长上。
    const input = animated.json.accessors?.[animation!.samplers[0].input];
    expect(input?.min).toEqual([0]);
    expect(input?.max).toEqual([2]);
    // 输出是三帧平移：原位 → 走完 → 回原位。
    const output = animated.json.accessors?.[animation!.samplers[0].output];
    expect(output?.count).toBe(3);
    const view = animated.json.bufferViews?.[output!.bufferView ?? 0];
    const values = new Float32Array(
      animated.bin.buffer,
      animated.bin.byteOffset + (view?.byteOffset ?? 0),
      9,
    );
    expect(values[0]).toBeCloseTo(0);
    expect(values[4]).toBeCloseTo(5);
    expect(values[7]).toBeCloseTo(0);
  });

  it('重新打出来的 GLB 还能解析，动画没把文件写坏', () => {
    const doc = parseGlb(assemblyGlb())!;
    const animated = applyModelState(doc, {
      ...emptyModel3dState(),
      travel: { node: 0, axis: [1, 0, 0], distance: 2, duration: 1.5 },
    });
    const roundTrip = parseGlb(serializeGlb(animated));
    expect(roundTrip).not.toBeNull();
    expect(roundTrip?.json.animations?.[0].name).toBe(TRAVEL_ANIMATION_NAME);
    expect(roundTrip?.json.buffers?.[0].byteLength).toBe(animated.bin.length);
  });
});

describe('状态是从原始模型重新算的', () => {
  it('同一个状态算两次结果一样（展示台每次都从原始模型重算，不会越叠越远）', () => {
    const doc = parseGlb(assemblyGlb())!;
    const state = { ...emptyModel3dState(), explode: 1 };
    const first = applyModelState(doc, state);
    const second = applyModelState(doc, state);
    expect(second.json.nodes?.[1].translation).toEqual(first.json.nodes?.[1].translation);
  });
});
