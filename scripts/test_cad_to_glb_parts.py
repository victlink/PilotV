"""成果台三维转换器：多零件 GLB 的结构检查（合成数据，不碰真成果）。

为什么要有这个检查：成果台的三维展示台（爆炸图 / 隐藏零件 / 挪零件 /
演示行程）靠的是 glTF 的节点层级。转换器要是把装配体合成一块网格，
那些功能全部失效 —— 而且页面上一眼看不出来（模型照样显示），只有用户
真去点「爆炸」才会发现零件是空的。所以这里直接查 GLB 里有没有节点。
"""
from pathlib import Path
import json
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import cad_to_glb


def parse_glb(payload: bytes):
    """把 GLB 拆回 (json, bin)。"""
    magic, version, total = struct.unpack("<III", payload[:12])
    assert magic == 0x46546C67, "不是 GLB"
    assert version == 2, f"GLB 版本不对：{version}"
    assert total == len(payload), f"GLB 长度对不上：{total} != {len(payload)}"
    offset = 12
    document = None
    binary = b""
    while offset + 8 <= len(payload):
        length, kind = struct.unpack("<II", payload[offset:offset + 8])
        start = offset + 8
        if kind == 0x4E4F534A:
            document = json.loads(payload[start:start + length].decode("utf-8"))
        elif kind == 0x004E4942:
            binary = payload[start:start + length]
        offset = start + length
    return document, binary


def triangle_mesh(offset: float):
    mesh = cad_to_glb.Mesh()
    mesh.add_polygon([(offset, 0, 0), (offset + 1, 0, 0), (offset, 1, 0)])
    return mesh


class MultiPartGlbTests(unittest.TestCase):
    def test_one_node_per_part(self):
        parts = [("机身", triangle_mesh(0.0)), ("机翼", triangle_mesh(10.0))]
        document, binary = parse_glb(cad_to_glb.build_glb(parts, "asm"))

        self.assertEqual(len(document["nodes"]), 2, "两个零件就要有两个节点")
        self.assertEqual([node["name"] for node in document["nodes"]], ["机身", "机翼"])
        self.assertEqual(document["scenes"][0]["nodes"], [0, 1])
        self.assertEqual(len(document["meshes"]), 2)
        # 每个节点带自己的网格，且互不共用。
        self.assertNotEqual(document["nodes"][0]["mesh"], document["nodes"][1]["mesh"])

    def test_accessors_point_at_real_ranges(self):
        parts = [("a", triangle_mesh(0.0)), ("b", triangle_mesh(5.0))]
        document, binary = parse_glb(cad_to_glb.build_glb(parts, "asm"))

        views = document["bufferViews"]
        for accessor in document["accessors"]:
            view = views[accessor["bufferView"]]
            self.assertLessEqual(view["byteOffset"] + view["byteLength"], len(binary))
            # accessor 的分量数 × 4 字节要落在 bufferView 长度里。
            components = {"SCALAR": 1, "VEC3": 3}[accessor["type"]]
            self.assertEqual(accessor["count"] * components * 4, view["byteLength"])

    def test_duplicate_part_names_stay_distinguishable(self):
        parts = [("零件", triangle_mesh(0.0)), ("零件", triangle_mesh(3.0))]
        document, _ = parse_glb(cad_to_glb.build_glb(parts, "asm"))
        names = [node["name"] for node in document["nodes"]]
        self.assertEqual(len(set(names)), 2, f"重名零件要能分清：{names}")

    def test_bounds_cover_all_parts(self):
        parts = [("a", triangle_mesh(0.0)), ("b", triangle_mesh(10.0))]
        low = cad_to_glb._bounds_of(parts)
        self.assertAlmostEqual(low[0], 0.0)
        self.assertAlmostEqual(low[3], 11.0)

    def test_empty_parts_are_rejected(self):
        with self.assertRaises(RuntimeError):
            cad_to_glb.build_glb([("空", cad_to_glb.Mesh())], "asm")


if __name__ == '__main__':
    unittest.main()
