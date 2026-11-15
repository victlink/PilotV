// 成果台三维展示台的纯逻辑单测。
//
// 这里盯的是两件最容易出错、又最难在界面上看出来的事：
//   1. 零件认得对不对（CAD 单零件节点 / Blender 单网格对象 / 被包起来的装配体）；
//   2. 相机站得对不对（扁窗口下横向才是瓶颈，缩放倍率要真的把画面拉近）。

import { describe, expect, it } from 'vitest';
import {
  clamp01,
  explodeDirection,
  fitDistance,
  fitDistanceForBox,
  groupParts,
  paletteColor,
  travelProgress,
  zoomDistance,
  type MeshSummary,
  type NodeSummary,
} from './artifactStage3d';

function mesh(key: string, name: string, center: [number, number, number], overrides: Partial<MeshSummary> = {}): MeshSummary {
  return {
    key,
    name,
    vertexCount: 100,
    textured: false,
    center,
    radius: 1,
    ...overrides,
  };
}

describe('零件分组', () => {
  it('CAD 那种「一个零件一个节点」会分成多个零件', () => {
    const root: NodeSummary = {
      key: 'root',
      name: 'scene',
      meshes: [],
      children: [
        { key: 'n0', name: '机身', meshes: [mesh('m0', '机身', [0, 0, 0])], children: [] },
        { key: 'n1', name: '机翼', meshes: [mesh('m1', '机翼', [10, 0, 0])], children: [] },
      ],
    };
    const parts = groupParts(root);
    expect(parts.map(part => part.name)).toEqual(['机身', '机翼']);
  });

  it('Blender 那种「对象 → 空节点 → 网格」认的是对象那一层，不是网格', () => {
    const root: NodeSummary = {
      key: 'root',
      name: 'scene',
      meshes: [],
      children: [
        {
          key: 'empty',
          name: 'Cube',
          meshes: [],
          children: [{ key: 'meshNode', name: 'Cube.001', meshes: [mesh('m0', 'Cube.001', [0, 0, 0])], children: [] }],
        },
      ],
    };
    const parts = groupParts(root);
    expect(parts).toHaveLength(1);
    expect(parts[0].meshes.map(item => item.key)).toEqual(['m0']);
  });

  it('整个装配体被包在一个根节点里，也不会被当成一个零件', () => {
    const root: NodeSummary = {
      key: 'root',
      name: 'scene',
      meshes: [],
      children: [
        {
          key: 'assembly',
          name: 'Assembly',
          meshes: [],
          children: [
            { key: 'a', name: '零件A', meshes: [mesh('ma', '零件A', [0, 0, 0])], children: [] },
            { key: 'b', name: '零件B', meshes: [mesh('mb', '零件B', [5, 0, 0])], children: [] },
          ],
        },
      ],
    };
    const parts = groupParts(root);
    expect(parts).toHaveLength(2);
    expect(parts.map(part => part.name).sort()).toEqual(['零件A', '零件B']);
  });

  it('一个节点上挂了多个网格时，它们各自算一个零件', () => {
    const root: NodeSummary = {
      key: 'root',
      name: 'scene',
      meshes: [],
      children: [
        {
          key: 'multi',
          name: '多材质件',
          meshes: [mesh('m0', '件-0', [0, 0, 0]), mesh('m1', '件-1', [1, 0, 0])],
          children: [],
        },
      ],
    };
    const parts = groupParts(root);
    expect(parts).toHaveLength(2);
  });

  it('零件中心与半径由网格合起来算，爆炸才知道往哪边散', () => {
    const root: NodeSummary = {
      key: 'root',
      name: 'scene',
      meshes: [],
      children: [
        { key: 'a', name: 'A', meshes: [mesh('ma', 'A', [-4, 0, 0], { radius: 2 })], children: [] },
        { key: 'b', name: 'B', meshes: [mesh('mb', 'B', [6, 0, 0], { radius: 2 })], children: [] },
      ],
    };
    const parts = groupParts(root);
    expect(parts[0].center[0]).toBeCloseTo(-4);
    expect(parts[0].radius).toBeCloseTo(2);
    expect(parts[1].center[0]).toBeCloseTo(6);
  });

  it('带贴图的零件要标出来：贴图模型按原材质渲染，不能被分色盖掉', () => {
    const root: NodeSummary = {
      key: 'root',
      name: 'scene',
      meshes: [],
      children: [
        { key: 'a', name: 'A', meshes: [mesh('ma', 'A', [0, 0, 0], { textured: true })], children: [] },
      ],
    };
    expect(groupParts(root)[0].textured).toBe(true);
  });

  it('零件编号是稳定的：同一份文件每次打开都是同样的号', () => {
    const build = (): NodeSummary => ({
      key: 'root',
      name: 'scene',
      meshes: [],
      children: [
        { key: 'a', name: 'A', meshes: [mesh('ma', 'A', [0, 0, 0])], children: [] },
        { key: 'b', name: 'B', meshes: [mesh('mb', 'B', [5, 0, 0])], children: [] },
      ],
    });
    // 挂在零件上的标注靠这个号找回零件：用 uuid 的话下次就指不到人了。
    expect(groupParts(build()).map(part => part.id)).toEqual(['part:0', 'part:1']);
    expect(groupParts(build()).map(part => part.id)).toEqual(['part:0', 'part:1']);
  });
});

describe('爆炸方向', () => {
  it('零件在模型中心外侧，就朝那个方向散开', () => {
    const direction = explodeDirection([10, 0, 0], [0, 0, 0]);
    expect(direction[0]).toBeCloseTo(1);
    expect(direction[1]).toBeCloseTo(0);
  });

  it('零件正好在中心上时没有方向（不能因为除零而抖起来）', () => {
    expect(explodeDirection([0, 0, 0], [0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('相机', () => {
  it('窗口越扁，相机要站得越远（横向才是瓶颈）', () => {
    const square = fitDistance(10, 45, 1);
    const wide = fitDistance(10, 45, 3);
    const narrow = fitDistance(10, 45, 0.4);
    expect(narrow).toBeGreaterThan(square);
    // 窗口够宽时竖直方向才是瓶颈，横向再宽也省不出距离来。
    expect(wide).toBeLessThanOrEqual(square);
  });

  it('缩放倍率越大站得越近', () => {
    expect(zoomDistance(100, 2)).toBeCloseTo(50);
    expect(zoomDistance(100, 0.5)).toBeCloseTo(200);
  });

  it('按包围盒取景：盒子越大站得越远，扁窗口里横向不够就退远', () => {
    const small = fitDistanceForBox({ min: [-1, -1, -1], max: [1, 1, 1] }, [1, 0.6, 1], 45, 1);
    const big = fitDistanceForBox({ min: [-10, -10, -10], max: [10, 10, 10] }, [1, 0.6, 1], 45, 1);
    expect(big).toBeGreaterThan(small * 5);
    // 窗口扁成一条：横向成了瓶颈，相机必须退远才装得下。
    const narrow = fitDistanceForBox({ min: [-10, -10, -10], max: [10, 10, 10] }, [1, 0.6, 1], 45, 0.4);
    expect(narrow).toBeGreaterThan(big);
  });
});

describe('行程动画', () => {
  it('走出去再走回来：中间到头，两头归零', () => {
    expect(travelProgress(0)).toBeCloseTo(0);
    expect(travelProgress(0.5)).toBeCloseTo(1);
    expect(travelProgress(1)).toBeCloseTo(0);
  });
});

describe('小工具', () => {
  it('配色按顺序循环，零件多了也不会取空', () => {
    expect(paletteColor(0)).toBe(paletteColor(0));
    expect(paletteColor(0)).not.toBe(paletteColor(1));
    expect(paletteColor(99)).toBeTruthy();
  });

  it('比例夹在 0–1 之间，NaN 也算 0', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});
