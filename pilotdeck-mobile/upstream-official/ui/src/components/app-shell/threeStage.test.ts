// @vitest-environment jsdom
// 三维层的「场景 → 零件」分析。
//
// 这里盯的是一个特别阴的坑：零件算出来了，却没接到场景里的对象上 ——
// 界面上看着就是「模型是空的」，而零件数明明不为零。所以要真的把
// three 的场景搭出来跑一遍，确认每个零件都能找回自己的网格。

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { analyzeScene } from './threeStage';

function part(name: string, x: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
  mesh.name = name;
  mesh.position.set(x, 0, 0);
  return mesh;
}

describe('场景分析', () => {
  it('CAD 那种「一个零件一个网格」会认成多个零件，而且都能接回场景', () => {
    const root = new THREE.Group();
    root.add(part('机身', 0), part('机翼', 10), part('尾翼', 20));
    root.updateMatrixWorld(true);

    const analysis = analyzeScene(root);
    expect(analysis.groups).toHaveLength(3);
    expect(analysis.meshes.size).toBe(3);
    for (const group of analysis.groups) {
      expect(group.meshes).toHaveLength(1);
      const mesh = analysis.meshes.get(group.meshes[0].key);
      expect(mesh).toBeTruthy();
      expect(mesh?.name).toBe(group.name);
    }
  });

  it('Blender 那种「对象 → 空节点 → 网格」认的是对象那一层', () => {
    const root = new THREE.Group();
    const object = new THREE.Group();
    object.name = '滤芯';
    object.add(part('滤芯.001', 0));
    root.add(object);
    root.updateMatrixWorld(true);

    const analysis = analyzeScene(root);
    expect(analysis.groups).toHaveLength(1);
    expect(analysis.groups[0].meshes).toHaveLength(1);
    expect(analysis.meshes.get(analysis.groups[0].meshes[0].key)?.name).toBe('滤芯.001');
  });

  it('空场景没有零件（这时界面要说清楚是空文件，不是加载失败）', () => {
    const root = new THREE.Group();
    root.updateMatrixWorld(true);
    expect(analyzeScene(root).groups).toHaveLength(0);
  });
});
