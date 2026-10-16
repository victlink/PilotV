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
import struct
import sys
import time

# OCP 是重依赖，只有真的要转 CAD 才付这个导入成本。
from OCP.BRep import BRep_Tool
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.IFSelect import IFSelect_RetDone
from OCP.IGESControl import IGESControl_Reader
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.TopLoc import TopLoc_Location

CAD_EXT = {".step", ".stp", ".iges", ".igs"}
# 网格格式：里面已经是三角面，只是 model-viewer 不认。走 VTK 读进 glb。
MESH_EXT = {".stl", ".obj", ".ply"}


def read_shape(path: str):
    """STEP / IGES → OCCT shape。读不出来就抛错，别静默返回空壳。"""
    ext = os.path.splitext(path)[1].lower()
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
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.38, 0.41, 0.46, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 0.58,
            },
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
    attempts = 0
    if ext in MESH_EXT:
        # 网格没有折线偏差可调，超上限只能如实报错让人先简化模型。
        mesh = read_mesh_file(src)
        faces = None
    else:
        while True:
            attempts += 1
            shape = read_shape(src)
            mesh, faces = tessellate(shape, deflection, angular)
            if mesh.triangles <= max_triangles or attempts >= 3:
                break
            deflection *= 2.5
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
        "deflection": round(deflection, 6),
        "attempts": attempts,
        "bounds": {"min": [low[0], low[1], low[2]], "max": [low[3], low[4], low[5]]},
        "seconds": round(time.time() - started, 2),
    }


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
