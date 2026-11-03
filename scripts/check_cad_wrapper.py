"""artifacts_cad 的端到端自检：转换、缓存命中、坏文件、体检接口。

成果台的 /viewer 直接依赖这几个行为，这里把它当回归跑一遍，免得只靠手点页面。

    python3 scripts/check_cad_wrapper.py
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import artifacts_cad as cad  # noqa: E402


def _write_stl(path: str) -> None:
    """一个单位立方体的 ASCII STL。当场造，免得为了自检往仓库里塞二进制。"""
    corners = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
               (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
    quads = [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4),
             (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("solid cube\n")
        for a, b, c, d in quads:
            for tri in ((a, b, c), (a, c, d)):
                points = [corners[i] for i in tri]
                ux, uy, uz = (points[1][i] - points[0][i] for i in range(3))
                vx, vy, vz = (points[2][i] - points[0][i] for i in range(3))
                nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
                handle.write(f"  facet normal {nx} {ny} {nz}\n    outer loop\n")
                for point in points:
                    handle.write(f"      vertex {point[0]} {point[1]} {point[2]}\n")
                handle.write("    endloop\n  endfacet\n")
        handle.write("endsolid cube\n")


def main():
    src = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "testdata", "cad", "box.step"))
    if not os.path.isfile(src):
        print(f"缺少夹具：{src}")
        return 1

    status = cad.converter_status()
    print("converter_status:", status)
    if not status.get("ok"):
        print("FAIL 转换器不可用")
        return 1

    with tempfile.TemporaryDirectory() as tmp:
        # 缓存目录换成临时的（不碰真实成果），但解释器还得是真的那个：venv 是按
        # ARTIFACTS_DATA_DIR 找的，指向 tmp 就等于「这台机器没装转换器」。
        venv = os.path.dirname(os.path.dirname(status["python"]))
        os.environ["ARTIFACTS_CAD_VENV"] = venv
        os.environ["ARTIFACTS_DATA_DIR"] = tmp

        first = cad.convert(src)
        print("first:", {k: v for k, v in first.items() if k != "path"},
              os.path.basename(first["path"]))
        assert not first["cached"] and os.path.isfile(first["path"]), "首次转换应当落盘"

        second = cad.convert(src)
        print("second cached:", second["cached"])
        assert second["cached"], "第二次应当命中缓存"

        # 坏文件：不能抛成别的东西，也不能留下半成品缓存。
        broken = os.path.join(tmp, "broken.step")
        with open(broken, "w", encoding="utf-8") as handle:
            handle.write("this is not a STEP file at all")
        try:
            cad.convert(broken)
            print("FAIL 坏 STEP 没有报错")
            return 1
        except cad.CadError as exc:
            print("broken STEP ->", type(exc).__name__, str(exc)[:90])
        leftovers = [name for name in os.listdir(os.path.join(tmp, "viewer"))
                     if name.startswith("broken")]
        assert not leftovers, f"失败留下了缓存半成品：{leftovers}"

        # 网格格式走的是另一条读取路径（VTK，不是 OCCT）：必须真的转出 glb，
        # 否则页面上这类成果就是一块空白，而体检照样全绿。
        stl = os.path.join(tmp, "cube.stl")
        _write_stl(stl)
        assert cad.needs_conversion(stl), "stl 该走转换"
        mesh = cad.convert(stl)
        print("stl:", {k: v for k, v in mesh.items() if k != "path"},
              os.path.basename(mesh["path"]))
        assert mesh["path"].endswith(".glb") and os.path.getsize(mesh["path"]) > 0, \
            "STL 应当转出可用的 glb"

        # 非 CAD 文件不该被转换。
        assert not cad.needs_conversion(__file__), "py 不该走转换"
        for unsupported in ("scene.dae", "pack.3mf", "model.blend"):
            assert not cad.needs_conversion(unsupported), \
                f"{unsupported} 本机没有转换器，不该假装能转"
    print("PASS artifacts_cad wrapper")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
