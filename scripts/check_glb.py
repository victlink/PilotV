"""检查 GLB 是不是一个 model-viewer 能直接吃的 glTF 2.0 二进制。

自己写的写出器（scripts/cad_to_glb.py）最容易被抓的地方就是容器和 accessor：
块头是 **8 字节**（长度 + 类型），不是 12；对齐和 min/max 算错，model-viewer
会安静地渲染成一团空白或者直接黑屏。这个脚本把容器、accessor、法线和绕序
（外向绕序给出正体积）都过一遍，当回归检查用。

    python3 scripts/check_glb.py testdata/cad/*.glb
"""

import glob
import json
import struct
import sys

COMP = {"5120": ("b", 1), "5121": ("B", 1), "5122": ("h", 2), "5123": ("H", 2),
        "5125": ("I", 4), "5126": ("f", 4)}
NUM = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def load(path):
    with open(path, "rb") as handle:
        data = handle.read()
    magic, version, total = struct.unpack("<III", data[:12])
    assert magic == 0x46546C67, f"不是 GLB（magic={magic:#x}）"
    assert version == 2, f"版本不是 2：{version}"
    assert total == len(data), f"文件头长度 {total} 与实际 {len(data)} 不符"
    assert len(data) % 4 == 0, "总长没有 4 字节对齐"

    # 块头 8 字节：u32 长度 + u32 类型。JSON 之后是 BIN 块。
    json_len, json_type = struct.unpack("<II", data[12:20])
    assert json_type == 0x4E4F534A, f"第一个块不是 JSON（{json_type:#x}）"
    doc = json.loads(data[20:20 + json_len])
    rest = 20 + json_len
    bin_len, bin_type = struct.unpack("<II", data[rest:rest + 8])
    assert bin_type == 0x004E4942, f"第二个块不是 BIN（{bin_type:#x}）"
    bin_start = rest + 8
    return doc, data, bin_start, bin_len


def read_accessor(doc, data, bin_start, index):
    accessor = doc["accessors"][index]
    view = doc["bufferViews"][accessor["bufferView"]]
    # componentType 在 glTF 里是整数，COMP 的键是字符串，直接查会 KeyError。
    fmt, size = COMP[str(accessor["componentType"])]
    width = NUM[accessor["type"]]
    base = bin_start + view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride = view.get("byteStride") or size * width
    out = []
    for i in range(accessor["count"]):
        start = base + i * stride
        row = struct.unpack_from(f"<{width}{fmt}", data, start)
        # SCALAR 读出来是 (7,) 这种一元组，索引表按这个用会踩到「tuple 索引」。
        out.append(row[0] if width == 1 else row)
    return accessor, out


def check(path):
    doc, data, bin_start, bin_len = load(path)
    mesh = doc["meshes"][0]
    prim = mesh["primitives"][0]
    assert prim["attributes"]["POSITION"] == 0, "POSITION 不是 accessor 0"
    assert prim["indices"] == 2, "indices 不是 accessor 2"

    _, points = read_accessor(doc, data, bin_start, 0)
    _, normals = read_accessor(doc, data, bin_start, 1)
    index_acc, indices = read_accessor(doc, data, bin_start, 2)
    assert len(indices) % 3 == 0, f"索引数 {len(indices)} 不是 3 的倍数"
    assert len(points) == len(normals), "法线数量和顶点对不上"

    # 顶点属性声明的 min/max 必须和实际数据一致：model-viewer 会拿它算包围盒，
    # 错了相机就框不准（表现为模型只露一个角或者被放到极远处）。
    for axis in range(3):
        assert abs(doc["accessors"][0]["min"][axis] - min(p[axis] for p in points)) < 1e-5, \
            f"POSITION.min[{axis}] 与实际数据不符"
        assert abs(doc["accessors"][0]["max"][axis] - max(p[axis] for p in points)) < 1e-5, \
            f"POSITION.max[{axis}] 与实际数据不符"

    for normal in normals:
        length = sum(value * value for value in normal) ** 0.5
        assert abs(length - 1.0) < 1e-3, f"法线不是单位向量：{length}"

    volume = 0.0
    for i in range(0, len(indices), 3):
        a, b, c = points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]
        volume += (a[0] * (b[1] * c[2] - b[2] * c[1])
                   - a[1] * (b[0] * c[2] - b[2] * c[0])
                   + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0

    print(f"OK {path}: {len(indices) // 3} tris, {len(points)} verts, "
          f"bin={bin_len}B, signed_volume={volume:.2f}")
    return volume


if __name__ == "__main__":
    paths = sys.argv[1:] or sorted(glob.glob("testdata/cad/*.glb"))
    for item in paths:
        check(item)
