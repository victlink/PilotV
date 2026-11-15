// 成果台三维展示台的渲染层（three.js）。
//
// 为什么不再用 model-viewer：
//   - 左键选中零件：model-viewer 不给 picking；
//   - 逐零件改颜色／透明度：它只认 glTF 里的材质，改一个零件得重打包整个模型；
//   - 背景颜色、全屏只剩模型：它没有这些开关。
// 换成 three 之后这些都是运行时改对象属性 —— 不用重新序列化 glTF，视角也不会
// 在每次改动后跳回中间。
//
// 这一层是命令式的（不是 React 组件）：渲染循环、相机、拾取都活在 React 之外，
// React 只负责把「用户改了什么」翻译成这里的方法调用。这样拖滑块时不会每一帧
// 都重新渲染 React 树。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
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
  type PartGroup,
  type Vec3,
} from './artifactStage3d';

export type StagePartInfo = {
  id: string;
  name: string;
  vertexCount: number;
  textured: boolean;
  /** 当前生效的颜色。 */
  color: string;
};

export type StageLoadResult = {
  parts: StagePartInfo[];
  /** 模型里有没有贴图（有贴图就别乱分色，材质才是主角）。 */
  hasTexture: boolean;
  vertexCount: number;
  /** 模型整体的大小（包围球半径）：挪动、行程的距离都按它算。 */
  radius: number;
  /** 一个网格都没有：源文件是空的（只有草图／线框／空文档）。 */
  empty: boolean;
};

export type StageCallbacks = {
  /** 左键点到零件时回调；点到空白处回调 null。 */
  onSelect?: (id: string | null) => void;
};

export type ColorMode = 'material' | 'palette';

type MaterialHandle = {
  material: THREE.Material;
  originalColor: THREE.Color | null;
  hasMap: boolean;
};

type PartHandle = {
  id: string;
  name: string;
  /** 移动／隐藏作用在这个对象上（零件容器或网格本身）。 */
  container: THREE.Object3D;
  meshes: THREE.Mesh[];
  materials: MaterialHandle[];
  basePosition: THREE.Vector3;
  center: THREE.Vector3;
  radius: number;
  palette: string;
  textured: boolean;
  /** 用户指定的颜色；null 表示按当前配色模式来。 */
  color: string | null;
  /** 零件自身的不透明度（0–1）。 */
  opacity: number;
  hidden: boolean;
  /** 用户手动挪动的量（world 单位）。 */
  offset: THREE.Vector3;
  travel: { axis: THREE.Vector3; distance: number; start: number; duration: number } | null;
};

const DEFAULT_BACKGROUND = '#eef1f6';

export class ThreeStage {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private frame = 0;
  private observer: ResizeObserver | null = null;
  private disposed = false;

  private parts = new Map<string, PartHandle>();
  private order: string[] = [];
  private meshByKey = new Map<string, THREE.Mesh>();
  private objectByKey = new Map<string, THREE.Object3D>();

  private modelCenter = new THREE.Vector3();
  private modelRadius = 1;
  private modelBox = new THREE.Box3();
  private baseDistance = 10;
  private homeDirection = new THREE.Vector3(0.82, 0.58, 1).normalize();

  private background = DEFAULT_BACKGROUND;
  private colorMode: ColorMode = 'palette';
  private explode = 0;
  private alpha = 1;
  private zoom = 1;
  private autoRotate = false;
  private gesturesEnabled = true;
  private pointerDown: { x: number; y: number; button: number } | null = null;

  private keyLight: THREE.DirectionalLight;
  private ground: THREE.Mesh | null = null;

  constructor(container: HTMLElement, private callbacks: StageCallbacks = {}) {
    this.container = container;
    this.scene.background = new THREE.Color(DEFAULT_BACKGROUND);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // 贴图模型（Blender 导出那种）要靠色调映射才不至于曝掉：金属面在
    // 直接贴图下常常一片白，看不出形状。
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.touchAction = 'none';
    container.appendChild(this.renderer.domElement);

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 5000);
    this.camera.position.set(120, 90, 140);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.screenSpacePanning = true;
    this.controls.autoRotateSpeed = 2.2;
    this.controls.target.set(0, 0, 0);

    // 环境光：RoomEnvironment 生成一张 PMREM，PBR 材质（金属度／粗糙度／
    // 贴图）靠它才有立体感。CAD 那种单色材质也靠反射才不像一张纸片。
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    this.scene.environmentIntensity = 1;
    (room as unknown as { dispose?: () => void }).dispose?.();
    pmrem.dispose();

    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
    this.keyLight.position.set(1, 1.7, 1.1);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.scene.add(this.keyLight);

    const fill = new THREE.DirectionalLight(0xffffff, 0.7);
    fill.position.set(-1.4, 0.8, -0.9);
    this.scene.add(fill);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x2b3442, 0.55));

    this.attachEvents();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.loop();
  }

  // ---------------------------------------------------------------- 载入

  async load(url: string): Promise<StageLoadResult> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(await describeFailure(response));
    }
    const buffer = await response.arrayBuffer();
    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
      new GLTFLoader().parse(buffer, '', resolve as (gltf: { scene: THREE.Group }) => void,
        error => reject(new Error(error instanceof Error ? error.message : String(error))));
    });
    this.setModel(gltf.scene);
    return this.summarize();
  }

  private setModel(root: THREE.Group): void {
    // 换模型前先把上一个清掉：几何体、材质、贴图都占显存。
    for (const part of this.parts.values()) {
      part.container.removeFromParent();
    }
    this.parts.clear();
    this.order = [];
    this.meshByKey.clear();
    this.objectByKey.clear();
    this.disposeGround();

    this.scene.add(root);
    root.updateMatrixWorld(true);

    const analysis = analyzeScene(root);
    this.meshByKey = analysis.meshes;
    this.objectByKey = analysis.objects;
    const groups = analysis.groups;

    let minX = Infinity; let minY = Infinity; let minZ = Infinity;
    let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;

    const box = new THREE.Box3();

    groups.forEach((group, index) => {
      const container = this.objectByKey.get(containerKeyOf(group)) ?? this.objectByKey.get(group.meshes[0]?.key ?? '');
      if (!container) return;
      const meshes = group.meshes
        .map(mesh => this.meshByKey.get(mesh.key))
        .filter((mesh): mesh is THREE.Mesh => Boolean(mesh));
      if (!meshes.length) return;

      const materials: MaterialHandle[] = [];
      for (const mesh of meshes) {
        const cloned = Array.isArray(mesh.material)
          ? mesh.material.map(material => material.clone())
          : mesh.material.clone();
        mesh.material = cloned as THREE.Material | THREE.Material[];
        const list = Array.isArray(cloned) ? cloned : [cloned];
        for (const material of list) {
          materials.push({
            material,
            originalColor: (material as THREE.MeshStandardMaterial).color
              ? (material as THREE.MeshStandardMaterial).color.clone()
              : null,
            hasMap: Boolean((material as THREE.MeshStandardMaterial).map),
          });
        }
        mesh.userData.partId = group.id;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // 真实包围盒：取景按它算，用包围球会把长条形装配体放得很远。
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        if (mesh.geometry.boundingBox) {
          box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
        }
      }

      const center = new THREE.Vector3(group.center[0], group.center[1], group.center[2]);
      const handle: PartHandle = {
        id: group.id,
        name: group.name,
        container,
        meshes,
        materials,
        basePosition: container.position.clone(),
        center,
        radius: group.radius,
        palette: paletteColor(index),
        textured: group.textured,
        color: null,
        opacity: 1,
        hidden: false,
        offset: new THREE.Vector3(),
        travel: null,
      };
      this.parts.set(group.id, handle);
      this.order.push(group.id);

      const radius = Math.max(group.radius, 1e-4);
      minX = Math.min(minX, center.x - radius);
      minY = Math.min(minY, center.y - radius);
      minZ = Math.min(minZ, center.z - radius);
      maxX = Math.max(maxX, center.x + radius);
      maxY = Math.max(maxY, center.y + radius);
      maxZ = Math.max(maxZ, center.z + radius);
    });

    if (!this.parts.size) {
      this.modelCenter.set(0, 0, 0);
      this.modelRadius = 1;
      this.modelBox.makeEmpty();
      return;
    }

    // 包围盒优先（取景准），盒子太空时退回包围球算出来的范围。
    const bounds = new THREE.Box3();
    if (box.isEmpty()) {
      bounds.set(
        new THREE.Vector3(minX, minY, minZ),
        new THREE.Vector3(maxX, maxY, maxZ),
      );
    } else {
      bounds.copy(box);
    }
    this.modelBox.copy(bounds);
    this.modelCenter.copy(bounds.getCenter(new THREE.Vector3()));
    this.modelRadius = Math.max(
      1e-3,
      bounds.getBoundingSphere(new THREE.Sphere()).radius,
    );

    this.buildGround();
    this.applyColors();
    this.applyOpacity();
    this.resetView();
  }

  /** 载入结果摘要：给界面看的零件清单。 */
  private summarize(): StageLoadResult {
    const parts: StagePartInfo[] = [];
    let hasTexture = false;
    let vertexCount = 0;
    for (const id of this.order) {
      const part = this.parts.get(id);
      if (!part) continue;
      hasTexture = hasTexture || part.textured;
      vertexCount += part.meshes.reduce((sum, mesh) => {
        const position = mesh.geometry.getAttribute('position');
        return sum + (position?.count ?? 0);
      }, 0);
      parts.push({
        id: part.id,
        name: part.name,
        vertexCount: part.meshes.reduce((sum, mesh) => {
          const position = mesh.geometry.getAttribute('position');
          return sum + (position?.count ?? 0);
        }, 0),
        textured: part.textured,
        color: part.palette,
      });
    }
    return { parts, hasTexture, vertexCount, radius: this.modelRadius, empty: parts.length === 0 };
  }

  // ---------------------------------------------------------------- 状态

  setBackground(color: string): void {
    this.background = color;
    this.scene.background = new THREE.Color(color);
  }

  setColorMode(mode: ColorMode): void {
    this.colorMode = mode;
    this.applyColors();
  }

  setExplode(amount: number): void {
    this.explode = clamp01(amount);
    this.applyPositions();
  }

  setAlpha(alpha: number): void {
    this.alpha = Math.min(1, Math.max(0.02, alpha));
    this.applyOpacity();
  }

  setPartColor(id: string, color: string | null): void {
    const part = this.parts.get(id);
    if (!part) return;
    part.color = color;
    this.applyColors();
  }

  setPartOpacity(id: string, opacity: number): void {
    const part = this.parts.get(id);
    if (!part) return;
    part.opacity = Math.min(1, Math.max(0.02, opacity));
    this.applyOpacity();
  }

  setPartHidden(id: string, hidden: boolean): void {
    const part = this.parts.get(id);
    if (!part) return;
    part.hidden = hidden;
    part.container.visible = !hidden;
  }

  setPartOffset(id: string, offset: Vec3): void {
    const part = this.parts.get(id);
    if (!part) return;
    part.offset.set(offset[0], offset[1], offset[2]);
    this.applyPositions();
  }

  setAutoRotate(on: boolean): void {
    this.autoRotate = on;
    this.controls.autoRotate = on;
  }

  setZoom(zoom: number): void {
    this.zoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const target = this.controls.target;
    const direction = this.camera.position.clone().sub(target);
    if (direction.lengthSq() < 1e-9) direction.copy(this.homeDirection);
    direction.normalize();
    this.camera.position.copy(target).addScaledVector(direction, zoomDistance(this.baseDistance, this.zoom));
    this.controls.update();
  }

  setGesturesEnabled(enabled: boolean): void {
    this.gesturesEnabled = enabled;
    this.controls.enabled = enabled;
  }

  resetView(): void {
    const target = this.modelCenter.clone();
    this.baseDistance = this.fitDistance();
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(this.homeDirection, this.baseDistance);
    this.camera.near = Math.max(0.001, this.modelRadius / 500);
    this.camera.far = Math.max(100, this.modelRadius * 60);
    this.camera.updateProjectionMatrix();
    this.zoom = 1;
    this.controls.update();
  }

  /** 相机该站多远：按包围盒和默认视线方向算，模型正好铺满画面。 */
  private fitDistance(): number {
    if (this.modelBox.isEmpty()) {
      return fitDistance(this.modelRadius, this.camera.fov, this.camera.aspect);
    }
    const min = this.modelBox.min.clone().sub(this.modelCenter);
    const max = this.modelBox.max.clone().sub(this.modelCenter);
    return fitDistanceForBox(
      { min: [min.x, min.y, min.z], max: [max.x, max.y, max.z] },
      [this.homeDirection.x, this.homeDirection.y, this.homeDirection.z],
      this.camera.fov,
      this.camera.aspect,
    );
  }

  /** 演示行程：选中的零件沿某个方向走出去再走回来。 */
  playTravel(id: string, axis: Vec3, distance: number): void {
    const part = this.parts.get(id);
    if (!part) return;
    const direction = new THREE.Vector3(axis[0], axis[1], axis[2]);
    if (direction.lengthSq() < 1e-9) direction.set(1, 0, 0);
    direction.normalize();
    part.travel = {
      axis: direction,
      distance,
      start: performance.now(),
      duration: 2000,
    };
  }

  // ---------------------------------------------------------------- 渲染

  private applyColors(): void {
    for (const part of this.parts.values()) {
      for (const handle of part.materials) {
        const material = handle.material as THREE.MeshStandardMaterial;
        if (!material.color) continue;
        if (part.color) {
          material.color.set(part.color);
        } else if (this.colorMode === 'palette' && !handle.hasMap) {
          material.color.set(part.palette);
        } else if (handle.originalColor) {
          material.color.copy(handle.originalColor);
        }
        material.needsUpdate = true;
      }
    }
  }

  private applyOpacity(): void {
    for (const part of this.parts.values()) {
      for (const handle of part.materials) {
        const material = handle.material as THREE.MeshStandardMaterial;
        if (!('opacity' in material)) continue;
        const opacity = Math.min(1, Math.max(0.02, this.alpha * part.opacity));
        material.opacity = opacity;
        material.transparent = opacity < 0.999;
        material.depthWrite = opacity > 0.98;
        material.needsUpdate = true;
      }
    }
  }

  /** 爆炸位移：零件沿着「离模型中心的方向」散开。 */
  private explodeOffset(part: PartHandle): THREE.Vector3 {
    const direction = explodeDirection(
      [part.center.x, part.center.y, part.center.z],
      [this.modelCenter.x, this.modelCenter.y, this.modelCenter.z],
    );
    return new THREE.Vector3(
      direction[0] * this.modelRadius * this.explode * 0.75,
      direction[1] * this.modelRadius * this.explode * 0.75,
      direction[2] * this.modelRadius * this.explode * 0.75,
    );
  }

  private applyPositions(): void {
    for (const part of this.parts.values()) {
      part.container.position.copy(part.basePosition).add(this.explodeOffset(part)).add(part.offset);
    }
  }

  private buildGround(): void {
    this.disposeGround();
    if (!this.modelRadius) return;
    const size = this.modelRadius * 4;
    const material = new THREE.ShadowMaterial({ opacity: 0.18 });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(this.modelCenter.x, this.modelCenter.y - this.modelRadius, this.modelCenter.z);
    plane.receiveShadow = true;
    this.scene.add(plane);
    this.ground = plane;

    const shadow = this.keyLight.shadow;
    shadow.camera.left = -this.modelRadius * 1.6;
    shadow.camera.right = this.modelRadius * 1.6;
    shadow.camera.top = this.modelRadius * 1.6;
    shadow.camera.bottom = -this.modelRadius * 1.6;
    shadow.camera.near = 0.01;
    shadow.camera.far = this.modelRadius * 12;
    shadow.camera.updateProjectionMatrix();
    this.keyLight.position.set(
      this.modelCenter.x + this.modelRadius,
      this.modelCenter.y + this.modelRadius * 1.8,
      this.modelCenter.z + this.modelRadius,
    );
    this.keyLight.target.position.copy(this.modelCenter);
    this.keyLight.target.updateMatrixWorld();
    this.scene.add(this.keyLight.target);
  }

  private disposeGround(): void {
    if (!this.ground) return;
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
    this.ground.removeFromParent();
    this.ground = null;
  }

  private attachEvents(): void {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointercancel', this.onPointerCancel);
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.pointerDown = { x: event.clientX, y: event.clientY, button: event.button };
  };

  private onPointerCancel = (): void => {
    this.pointerDown = null;
  };

  private onPointerUp = (event: PointerEvent): void => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || down.button !== 0 || !this.gesturesEnabled) return;
    // 拖动过就是转视角，不是选零件。
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (moved > 5) return;
    this.callbacks.onSelect?.(this.pick(event));
  };

  /** 射线拾取：返回点到的零件 id，点空白处返回 null。 */
  private pick(event: PointerEvent): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets = this.order
      .map(id => this.parts.get(id))
      .filter((part): part is PartHandle => Boolean(part))
      .flatMap(part => part.meshes);
    const hits = this.raycaster.intersectObjects(targets, false);
    for (const hit of hits) {
      if (!isVisible(hit.object)) continue;
      const id = hit.object.userData.partId as string | undefined;
      if (id) return id;
    }
    return null;
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.baseDistance = this.fitDistance();
    // 窗口变了但用户没自己转过视角时，重新取景；用户已经动过相机就别乱动。
    const untouched = this.controls.target.distanceTo(this.modelCenter) < 1e-6;
    if (untouched) {
      this.camera.position.copy(this.modelCenter).addScaledVector(this.homeDirection, this.baseDistance);
      this.controls.target.copy(this.modelCenter);
    }
    this.controls.update();
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    const now = performance.now();
    for (const part of this.parts.values()) {
      if (!part.travel) continue;
      const t = (now - part.travel.start) / part.travel.duration;
      if (t >= 1) {
        part.travel = null;
        this.applyPositions();
        continue;
      }
      const progress = travelProgress(t);
      part.container.position.copy(part.basePosition)
        .add(this.explodeOffset(part))
        .add(part.offset)
        .addScaledVector(part.travel.axis, part.travel.distance * progress);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.observer = null;
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this.onPointerDown);
    dom.removeEventListener('pointerup', this.onPointerUp);
    dom.removeEventListener('pointercancel', this.onPointerCancel);
    this.controls.dispose();
    this.scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material;
      if (!material) return;
      const list = Array.isArray(material) ? material : [material];
      for (const item of list) {
        for (const value of Object.values(item as unknown as Record<string, unknown>)) {
          if (value && typeof value === 'object' && 'isTexture' in (value as { isTexture?: boolean })) {
            (value as THREE.Texture).dispose?.();
          }
        }
        item.dispose();
      }
    });
    this.renderer.dispose();
    dom.remove();
  }
}

function containerKeyOf(group: { id: string; meshes: MeshSummary[] }): string {
  return group.id.startsWith('node:') ? group.id.slice('node:'.length) : group.meshes[0]?.key ?? '';
}

/**
 * 把 three 的场景树拆成零件，并把「零件 → 场景对象」的对应关系一起交出来。
 *
 * 单独拎出来是为了能单测：三维层最阴的 bug 就是「零件算出来了，却没接到
 * 场景里的对象上」——界面上看着就是「模型是空的」，而代码里零件数明明不为零。
 */
export type SceneAnalysis = {
  groups: PartGroup[];
  /** 场景里的每个对象（按 uuid 索引）。 */
  objects: Map<string, THREE.Object3D>;
  /** 场景里的每个网格（按 uuid 索引）。 */
  meshes: Map<string, THREE.Mesh>;
};

export function analyzeScene(root: THREE.Object3D): SceneAnalysis {
  const objects = new Map<string, THREE.Object3D>();
  const meshes = new Map<string, THREE.Mesh>();
  const tree = buildTree(root, objects, meshes);
  return { groups: groupParts(tree), objects, meshes };
}

function buildTree(
  root: THREE.Object3D,
  objects: Map<string, THREE.Object3D>,
  meshes: Map<string, THREE.Mesh>,
): NodeSummary {
  const node: NodeSummary = { key: root.uuid, name: root.name || '', meshes: [], children: [] };
  objects.set(root.uuid, root);
  for (const child of root.children) {
    const summary = buildTree(child, objects, meshes);
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      meshes.set(mesh.uuid, mesh);
      const described = describeMesh(mesh);
      if (described) node.meshes.push(described);
    }
    node.children.push(summary);
  }
  return node;
}

function describeMesh(mesh: THREE.Mesh): MeshSummary | null {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position || !position.count) return null;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere;
  if (!sphere) return null;
  mesh.updateWorldMatrix(true, false);
  const world = sphere.clone().applyMatrix4(mesh.matrixWorld);
  const center = new THREE.Vector3().copy(world.center);
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const textured = materials.some(material => Boolean((material as THREE.MeshStandardMaterial).map));
  const parentName = mesh.parent?.name || '';
  return {
    key: mesh.uuid,
    name: mesh.name || parentName || '零件',
    vertexCount: position.count,
    textured,
    center: [center.x, center.y, center.z],
    radius: world.radius,
  };
}

function isVisible(object: THREE.Object3D): boolean {
  let node: THREE.Object3D | null = object;
  while (node) {
    if (!node.visible) return false;
    node = node.parent;
  }
  return true;
}

/** 后端转换失败时把 422 的正文读出来：FreeCAD 那边的真实原因就在里面。 */
async function describeFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const payload = JSON.parse(text) as { error?: string; hint?: string };
      detail = [payload.error, payload.hint].filter(Boolean).join(' ');
    } catch {
      detail = text.slice(0, 200);
    }
  } catch {
    detail = '';
  }
  return detail || `模型读取失败（HTTP ${response.status}）`;
}
