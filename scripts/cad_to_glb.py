#!/usr/bin/env python3
"""CAD（STEP / IGES）与网格（STL / OBJ / PLY）→ glTF 二进制，供成果台的三维预览用。

只在隔离 venv（.artifacts-data/venvs/cad）里跑：这个脚本 import OCP
（OpenCASCADE 绑定，连带 libvtk）和 VTK，而成果台主进程不该被这么重的东西拖住。
所以调用方 artifacts_cad.py 是**子进程**方式调本文件，而不是 import。

model-viewer 只认 glTF/GLB，STEP/IGES/STL/OBJ/PLY 不转换就是一块空白。
CAD 走 OCCT 读 B-rep 再网格化，网格文件走 VTK 直接读顶点，最后都写成 GLB。
成果台只在需要时调一次并缓存结果。

用法：
    python cad_to_glb.py <in.step> <out.glb> [--deflection 0.0015] [--max-triangles N]

成功时 stdout 打印一行 JSON 统计（三角形数、面数、包围盒），失败时 stderr
打印原因并以非零码退出。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time

# OCP 是重依赖。装不上不该让整个转换器不可用：本机装了 FreeCAD 时，
# 所有格式都能走 FreeCAD 那条路（见 _freecad_export_obj），OCP 只作备选。
try:
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.IGESControl import IGESControl_Reader
    from OCP.STEPControl import STEPControl_Reader
    from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    from OCP.TopLoc import TopLoc_Location
    HAS_OCP = True
except ImportError:  # 隔离 venv 没装 OCP：靠 FreeCAD 也能转
    HAS_OCP = False

CAD_EXT = {".step", ".stp", ".iges", ".igs", ".fcstd"}
# 网格格式：里面已经是三角面，只是 model-viewer 不认。走 VTK 读进 glb。
MESH_EXT = {".stl", ".obj", ".ply"}
# FreeCAD 文档不是一个能被 OCCT 直接读的 B-rep：它是个 zip（Document.xml +
# 每个对象一份 BREP）。所以 .fcstd 只能交给 FreeCAD 自己打开。
FCSTD_EXT = {".fcstd"}

# freecadcmd 不在 PATH 里是常态（Windows 安装器给你装在用户目录，且不勾选
# PATH）。按常见位置找一遍，允许用 FREECAD_CMD 指定。
FREECAD_CANDIDATES = (
    os.environ.get("FREECAD_CMD") or "",
    r"C:\Program Files\FreeCAD 1.1\bin\freecadcmd.exe",
    r"C:\Program Files\FreeCAD 1.0\bin\freecadcmd.exe",
    r"C:\Program Files\FreeCAD 0.21\bin\freecadcmd.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\FreeCAD 1.1\bin\freecadcmd.exe"),
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\FreeCAD 1.0\bin\freecadcmd.exe"),
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\FreeCAD 0.21\bin\freecadcmd.exe"),
    "/usr/bin/freecadcmd",
    "/usr/local/bin/freecadcmd",
    "/opt/freecad/bin/freecadcmd",
    "/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd",
)

# 在 FreeCAD 进程里跑的导出脚本：读任意受支持的格式，网格化后写成 OBJ。
#
# 为什么用 OBJ 当中间格式，而不是直接导 glTF：FreeCAD 的 glTF 导出在不同
# 版本里时有时无，而 OBJ 是 Mesh 工作台的老接口，1.0/1.1 都稳定。OBJ 解析
# 在下面用纯 Python 做（read_obj_file），不需要 VTK —— 本机就是没有 VTK。
#
# 路径一律走环境变量传：freecadcmd 只吃一个脚本参数，而中文路径当成命令行
# 参数传进去会静默崩溃。这个仓库里中文模型名是常态。
_FREECAD_EXPORT_SCRIPT = r'''
import os
import FreeCAD
import Import
import Mesh
import MeshPart

src = os.environ["FC_SRC"]
out = os.environ["FC_OUT"]

doc = FreeCAD.newDocument("cad2glb")
ext = os.path.splitext(src)[1].lower()

if ext == ".fcstd":
    # FCStd 是一个完整文档：直接打开它，别再 insert 一遍。
    FreeCAD.closeDocument(doc.Name)
    doc = FreeCAD.openDocument(src)
else:
    Import.insert(src, doc.Name)

shapes = []
# 验证用的文档里混着「不是零件」的辅助几何：服务包络（一个 740×880×800 的
# 空盒，六块板围出来的）、包络检查体。它们本该出现在审计里，但塞进预览会把
# 整台机器糊成一块灰砖 —— 用户点开只看见一个方块，会以为装配体没做出来。
#
# 只按自己的 label 筛是不够的：包络是个容器（App::Part），它下面六块板叫
# Box / Box001，名字里根本看不出是包络。所以还要看祖先，并且只取叶子对象 ——
# 容器自己的 Shape 是子对象的聚合，跟着一起导出会让每个零件被画两遍。
import re
skip = re.compile(os.environ.get("FC_SKIP_LABELS", r"(?i)(not_parts|not_production|envelope|包络)"))

def label_of(obj):
    return (getattr(obj, "Label", "") or "") + " " + (getattr(obj, "Name", "") or "")

def hits(obj, depth=0):
    if skip.search(label_of(obj)):
        return True
    if depth >= 8:
        return False
    # InList 是「谁包含我」；向上爬就能认出手下这批 Box 属于包络容器。
    for parent in getattr(obj, "InList", None) or []:
        if hits(parent, depth + 1):
            return True
    return False

for obj in doc.Objects:
    if hits(obj):
        continue
    # 有 Group 的是容器（App::Part、Part::Compound、组）：零件由子对象表示，
    # 容器自身再导一遍就是重复渲染。
    if getattr(obj, "Group", None):
        continue
    shape = getattr(obj, "Shape", None)
    if shape is None:
        continue
    try:
        if shape.isNull() or not shape.Faces:
            continue
    except Exception:
        continue
    copy = shape.copy()
    # 对象自己的 Placement 不在 Shape 里；不叠上去，装配体会散成一堆原地零件。
    try:
        placement = getattr(obj, "Placement", None)
        if placement is not None and not placement.isIdentity():
            copy.transformShape(placement.toMatrix())
    except Exception:
        pass
    shapes.append(copy)

if not shapes:
    raise SystemExit("文件里没有可显示的实体（只有草图、线框或空文档）")

combined = Mesh.Mesh()
facets = 0
defl = float(os.environ.get("FC_DEFLECTION", "0.08"))
for shape in shapes:
    # Relative=True：折线偏差按模型自身尺寸取比例。CAD 文件单位五花八门
    # （mm / m / inch 都见过），写死绝对值要么糊要么爆。
    piece = MeshPart.meshFromShape(Shape=shape, LinearDeflection=defl,
                                   AngularDeflection=0.3, Relative=True)
    if piece.CountFacets:
        combined.addMesh(piece)
        facets += piece.CountFacets

if not combined.CountFacets:
    raise SystemExit("网格化后没有任何三角面")

combined.write(out)
print("facets=%d" % facets)
'''


def _freecad_cmd() -> str:
    for candidate in FREECAD_CANDIDATES:
        if candidate and os.path.isfile(candidate):
            return candidate
    found = shutil.which("freecadcmd") or shutil.which("FreeCADCmd")
    if found:
        return found
    raise RuntimeError(
        "这台机器上没有 freecadcmd，转不了这个格式；"
        "请装 FreeCAD 或设置 FREECAD_CMD 指向它，也可以先导出 STEP 再发布")


def _freecad_export_obj(path: str, deflection: float = 0.08) -> tuple[str, str]:
    """任意受支持格式 → 临时 OBJ。返回 (obj 路径, 临时目录)，调用方负责清理。"""
    exe = _freecad_cmd()
    workdir = tempfile.mkdtemp(prefix="cad2glb-")
    script = os.path.join(workdir, "export.py")
    out = os.path.join(workdir, "mesh.obj")
    with open(script, "w", encoding="utf-8") as handle:
        handle.write(_FREECAD_EXPORT_SCRIPT)
    env = dict(os.environ, FC_SRC=os.path.abspath(path), FC_OUT=out,
               FC_DEFLECTION=repr(float(deflection)))
    # FreeCAD 首次启动会建用户配置，比一般 CLI 慢；给足 5 分钟，但还是有上限 ——
    # 挂死的子进程比一次失败更糟。
    done = subprocess.run([exe, script], capture_output=True, text=True,
                          timeout=300, env=env, check=False)
    if done.returncode != 0 or not os.path.isfile(out) or os.path.getsize(out) == 0:
        detail = (done.stderr or done.stdout or "").strip()[-300:]
        shutil.rmtree(workdir, ignore_errors=True)
        raise RuntimeError(
            f"FreeCAD 没能把这份文件转成网格：{detail or '退出码 %d' % done.returncode}")
    return out, workdir


def read_obj_file(path: str) -> Mesh:
    """OBJ → Mesh。

    FreeCAD 导出的 OBJ 已经是三角面（它自己网格化过了），这里只把顶点和面
    读回来。不借 VTK：本机没装 VTK 时三维预览也得能用，而 OBJ 语法足够简单，
    自己解析比多背一个几百 MB 的依赖划算。
    """
    mesh = Mesh()
    vertices: list[tuple[float, float, float]] = []
    with open(path, "r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            if line.startswith("v "):
                parts = line.split()
                if len(parts) >= 4:
                    vertices.append((float(parts[1]), float(parts[2]), float(parts[3])))
            elif line.startswith("f "):
                coords = []
                for token in line.split()[1:]:
                    head = token.split("/", 1)[0]
                    if not head:
                        continue
                    index = int(head)
                    # OBJ 的下标是 1 起；负数表示「从末尾倒数」。
                    index = index - 1 if index > 0 else len(vertices) + index
                    if 0 <= index < len(vertices):
                        coords.append(vertices[index])
                mesh.add_polygon(coords)
    return mesh


def read_shape(path: str):
    """STEP / IGES → OCCT shape。读不出来就抛错，别静默返回空壳。

    .fcstd 不在这里：FreeCAD 文档不是 OCCT 能直读的 B-rep，convert() 会先把它
    交给 FreeCAD 网格化成 OBJ，再走 read_obj_file。
    """
    ext = os.path.splitext(path)[1].lower()
    if not HAS_OCP:
        raise RuntimeError("这台机器没有 OCP（也无法用 FreeCAD）读不了这个格式")
    if ext in (".step", ".stp"):
        reader = STEPControl_Reader()
        status = reader.ReadFile(path)
        if status != IFSelect_RetDone:
            raise RuntimeError(f"STEP 解析失败（status={status}）")
        if reader.TransferRoots() <= 0:
            raise RuntimeError("STEP 里没有可传输的几何")
        return reader.OneShape()
    if ext in (".iges", ".igs"):
        reader = IGESControl_Reader()
        status = reader.ReadFile(path)
        if status != IFSelect_RetDone:
            raise RuntimeError(f"IGES 解析失败（status={status}）")
        if reader.TransferRoots() <= 0:
            raise RuntimeError("IGES 里没有可传输的几何")
        return reader.OneShape()
    raise RuntimeError(f"不是 CAD 文件：{ext or path}")


class Mesh:
    """累积三角面。每个面自带顶点块，法线在面内平滑（不跨面）。"""

    def __init__(self) -> None:
        self.positions: list[tuple[float, float, float]] = []
        self.normals: list[tuple[float, float, float]] = []
        self.indices: list[int] = []

    @property
    def triangles(self) -> int:
        return len(self.indices) // 3

    def add_face(self, face) -> int:
        """把一个 BRep 面网格化后并进来，返回并入的三角形数。"""
        location = TopLoc_Location()
        # OCP 把 OCCT 的静态方法暴露成 _s 后缀（Triangulation_s）。
        triangulation = BRep_Tool.Triangulation_s(face, location)
        if triangulation is None:
            return 0
        transform = location.Transformation()
        count = triangulation.NbNodes()
        if count <= 0:
            return 0
        # 面自带一套节点；三角形引用的是这套节点的下标（1 起）。
        points = []
        for index in range(1, count + 1):
            point = triangulation.Node(index).Transformed(transform)
            points.append((point.X(), point.Y(), point.Z()))

        # 面被反向放置时，三角形绕序要翻过来，否则法线朝里、模型看着像空心壳。
        flipped = face.Orientation() == TopAbs_REVERSED
        face_indices = []
        normals: list[list[float]] = [[0.0, 0.0, 0.0] for _ in points]
        for index in range(1, triangulation.NbTriangles() + 1):
            a, b, c = triangulation.Triangle(index).Get()
            if flipped:
                b, c = c, b
            face_indices.append((a - 1, b - 1, c - 1))
            (ax, ay, az), (bx, by, bz), (cx, cy, cz) = points[a - 1], points[b - 1], points[c - 1]
            ux, uy, uz = bx - ax, by - ay, bz - az
            vx, vy, vz = cx - ax, cy - ay, cz - az
            nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
            for vertex in (a - 1, b - 1, c - 1):
                normals[vertex][0] += nx
                normals[vertex][1] += ny
                normals[vertex][2] += nz

        base = len(self.positions)
        for point, normal in zip(points, normals):
            self.positions.append(point)
            length = math.sqrt(normal[0] ** 2 + normal[1] ** 2 + normal[2] ** 2)
            # 退化三角形（面积 0）法线是零向量，落成 (0,0,1) 比 NaN 稳。
            self.normals.append((normal[0] / length, normal[1] / length, normal[2] / length)
                                if length > 1e-20 else (0.0, 0.0, 1.0))
        for triple in face_indices:
            self.indices.extend(base + vertex for vertex in triple)
        return len(face_indices)

    def add_polygon(self, coords) -> int:
        """并入一个网格多边形（OBJ 的四边形、PLY 的任意 n 边面都走这里）。

        扇形拆成三角形，法线按面算、不跨面：网格文件通常没有法线，
        算出来的硬边正是这类成果该有的样子。
        """
        if len(coords) < 3:
            return 0
        ax, ay, az = coords[0]
        ux, uy, uz = coords[1][0] - ax, coords[1][1] - ay, coords[1][2] - az
        vx, vy, vz = coords[2][0] - ax, coords[2][1] - ay, coords[2][2] - az
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        length = math.sqrt(nx * nx + ny * ny + nz * nz)
        normal = (nx / length, ny / length, nz / length) if length > 1e-20 else (0.0, 0.0, 1.0)

        base = len(self.positions)
        triangles = len(coords) - 2
        for point in coords:
            self.positions.append(point)
            self.normals.append(normal)
        for index in range(triangles):
            self.indices.extend((base, base + index + 1, base + index + 2))
        return triangles

    def bounds(self):
        if not self.positions:
            return (0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
        xs = [p[0] for p in self.positions]
        ys = [p[1] for p in self.positions]
        zs = [p[2] for p in self.positions]
        return (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))


def _vtk():
    """VTK 只在转网格时才用得上，所以放在函数里 import。

    CAD 那条路（OCP）每次都要几十秒启动开销，能不付就不付；而网格文件
    本身没有 B-rep，交给 VTK 比让 OCCT 去猜快也更不容易崩。
    """
    try:
        import vtk
        return vtk
    except ImportError:  # vtkmodules 布局下顶层 vtk 可能不在
        from vtkmodules import all as vtk        # noqa: PLC0415 - 按需导入
        return vtk


def read_mesh_file(path: str) -> Mesh:
    """STL / OBJ / PLY → Mesh。这些格式本来就是三角面，不用再网格化。"""
    ext = os.path.splitext(path)[1].lower()
    if ext not in MESH_EXT:
        raise RuntimeError(f"不是网格文件：{ext or path}")
    vtk = _vtk()
    readers = {".stl": vtk.vtkSTLReader, ".obj": vtk.vtkOBJReader, ".ply": vtk.vtkPLYReader}
    reader = readers[ext]()
    reader.SetFileName(path)
    reader.Update()
    poly = reader.GetOutput()
    if poly is None or poly.GetNumberOfPoints() == 0:
        raise RuntimeError(f"{ext} 里没有可显示的顶点（文件损坏或格式不符）")

    mesh = Mesh()
    points = poly.GetPoints()
    for index in range(poly.GetNumberOfCells()):
        cell = poly.GetCell(index)
        # GetNumberOfPoints() > 3 的面（OBJ 的四边形、PLY 的高阶面）扇形拆开，
        # 与 Mesh.add_polygon 的处理一致。
        coords = [tuple(float(value) for value in points.GetPoint(cell.GetPointId(point_index)))
                  for point_index in range(cell.GetNumberOfPoints())]
        mesh.add_polygon(coords)
    return mesh


def tessellate(shape, deflection: float, angular: float):
    # isRelative=True：折线偏差按模型自身尺寸取比例。CAD 文件单位五花八门
    # （mm / m / inch 都见过），写死绝对值要么糊要么爆。平行网格化用满核。
    BRepMesh_IncrementalMesh(shape, deflection, True, angular, True)
    mesh = Mesh()
    faces = 0
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        # Current() 给的是 TopoDS_Shape，BRep_Tool 只认 TopoDS_Face：
        # 探索器不做下转，得自己 cast（OCCT 里对应 TopoDS::Face）。
        if mesh.add_face(TopoDS.Face(explorer.Current())):
            faces += 1
        explorer.Next()
    return mesh, faces


def build_glb(mesh: Mesh, name: str) -> bytes:
    """把网格写成单 mesh 的 GLB。accessor / bufferView 布局自己算，够用即可。"""
    blob = bytearray()
    cursor = 0

    def align(padding: bytes) -> None:
        nonlocal cursor
        while cursor % 4:
            blob.extend(padding)
            cursor += 1

    views: list[dict] = []

    align(b"\x00")
    position_offset = cursor
    for x, y, z in mesh.positions:
        blob.extend(struct.pack("<3f", x, y, z))
    cursor += 12 * len(mesh.positions)
    views.append({"buffer": 0, "byteOffset": position_offset,
                  "byteLength": 12 * len(mesh.positions), "target": 34962})

    align(b"\x00")
    normal_offset = cursor
    for x, y, z in mesh.normals:
        blob.extend(struct.pack("<3f", x, y, z))
    cursor += 12 * len(mesh.normals)
    views.append({"buffer": 0, "byteOffset": normal_offset,
                  "byteLength": 12 * len(mesh.normals), "target": 34962})

    align(b"\x00")
    index_offset = cursor
    for index in mesh.indices:
        blob.extend(struct.pack("<I", index))
    cursor += 4 * len(mesh.indices)
    views.append({"buffer": 0, "byteOffset": index_offset,
                  "byteLength": 4 * len(mesh.indices), "target": 34963})

    low = mesh.bounds()
    document = {
        "asset": {"version": "2.0", "generator": "pilotv-cad-to-glb"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"name": name, "primitives": [{
            "attributes": {"POSITION": 0, "NORMAL": 1},
            "indices": 2,
            "material": 0,
        }]}],
        "materials": [{
            "name": "cad",
            "doubleSided": True,
            # 偏中灰 + 低金属度：白到发亮的材质在默认白色底上糊成一片，
            # 看不出形体。中灰能让各个面靠明暗分开，一眼看出是零件。
            #
            # 半透明是刻意的：整机装配体外面罩着一层封闭机箱，不透明的话
            # 点开只能看到一块灰砖，内部的风道、滤芯、风阀全被挡住 ——
            # 「能看到装配」才是预览的目的。alpha 0.62 还能看清机箱轮廓，
            # 又不至于让里面什么都看不见。
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.30, 0.34, 0.40, 0.74],
                "metallicFactor": 0.0,
                "roughnessFactor": 0.58,
            },
            "alphaMode": "BLEND",
        }],
        "buffers": [{"byteLength": cursor}],
        "bufferViews": views,
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(mesh.positions),
             "type": "VEC3", "min": [low[0], low[1], low[2]], "max": [low[3], low[4], low[5]]},
            {"bufferView": 1, "componentType": 5126, "count": len(mesh.normals), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5125, "count": len(mesh.indices), "type": "SCALAR"},
        ],
    }

    payload = json.dumps(document, separators=(",", ":")).encode("utf-8")
    payload += b" " * (-len(payload) % 4)          # JSON 块用空格补齐
    binary = bytes(blob) + b"\x00" * (-len(blob) % 4)  # BIN 块用 0 补齐
    total = 12 + 8 + len(payload) + 8 + len(binary)
    header = struct.pack("<III", 0x46546C67, 2, total)   # 'glTF', version 2
    return b"".join([
        header,
        struct.pack("<II", len(payload), 0x4E4F534A), payload,   # 'JSON'
        struct.pack("<II", len(binary), 0x004E4942), binary,    # 'BIN\0'
    ])


def convert(src: str, dst: str, deflection: float, angular: float,
            max_triangles: int) -> dict:
    """转一次。三角形超上限就把折线偏差放大重试，宁可糙一点也别把浏览器拖死。"""
    started = time.time()
    ext = os.path.splitext(src)[1].lower()
    attempts = 1
    faces = None
    temp_dir = ""
    try:
        # 优先 FreeCAD：这台机器可能既没 OCP 也没 VTK（隔离 venv 没装），
        # 但装了 FreeCAD 时，所有格式包括 .FCStd 都能由它一次网格化，
        # 不用再背两个几百 MB 的库。
        try:
            freecad = _freecad_cmd()
        except RuntimeError:
            freecad = ""

        if freecad:
            while True:
                obj_path, temp_dir = _freecad_export_obj(src, deflection)
                mesh = read_obj_file(obj_path)
                if mesh.triangles <= max_triangles or attempts >= 3:
                    break
                # 这一轮的临时文件没用了，先删掉再重来，别攒着。
                shutil.rmtree(temp_dir, ignore_errors=True)
                temp_dir = ""
                deflection *= 2.5
                attempts += 1
        elif ext in MESH_EXT:
            # 网格没有折线偏差可调，超上限只能如实报错让人先简化模型。
            mesh = read_mesh_file(src)
        else:
            while True:
                shape = read_shape(src)
                mesh, faces = tessellate(shape, deflection, angular)
                if mesh.triangles <= max_triangles or attempts >= 3:
                    break
                deflection *= 2.5
                attempts += 1

        if not mesh.triangles:
            raise RuntimeError("这份文件里没有三角面（可能是纯线框或空壳）")
        if mesh.triangles > max_triangles:
            raise RuntimeError(f"网格化后有 {mesh.triangles} 个三角形，超过上限 {max_triangles}")

        name = os.path.splitext(os.path.basename(src))[0]
        os.makedirs(os.path.dirname(os.path.abspath(dst)) or ".", exist_ok=True)
        # 先写临时文件再改名：并发两个请求转到同一份成果时，model-viewer 不会
        # 读到写了一半的 GLB。
        tmp = f"{dst}.tmp{os.getpid()}"
        with open(tmp, "wb") as handle:
            handle.write(build_glb(mesh, name))
        os.replace(tmp, dst)

        low = mesh.bounds()
        return {
            "src": src, "dst": dst,
            "bytes": os.path.getsize(dst),
            "triangles": mesh.triangles,
            "vertices": len(mesh.positions),
            "faces": faces,
            "backend": "freecad" if freecad else ("mesh" if ext in MESH_EXT else "occt"),
            "deflection": round(deflection, 6),
            "attempts": attempts,
            "bounds": {"min": [low[0], low[1], low[2]], "max": [low[3], low[4], low[5]]},
            "seconds": round(time.time() - started, 2),
        }
    finally:
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="CAD（STEP/IGES）→ GLB")
    parser.add_argument("src")
    parser.add_argument("dst")
    parser.add_argument("--deflection", type=float, default=0.0015,
                        help="折线偏差比例（相对模型尺寸），默认 0.15%%")
    parser.add_argument("--angular", type=float, default=0.4, help="角度偏差（弧度）")
    parser.add_argument("--max-triangles", type=int, default=4_000_000)
    args = parser.parse_args(argv)

    try:
        stats = convert(args.src, args.dst, args.deflection, args.angular, args.max_triangles)
    except Exception as exc:                      # noqa: BLE001 - 子进程只回报原因
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"[:400]},
                         ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, **stats}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
