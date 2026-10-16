"""生成 CAD 转换的测试夹具（需要隔离 venv 里的 OCP）。

用 OCP 自己造几何再写成 STEP/IGES，比手搓 ISO-10303-21 文本可靠：这份脚本
产出的文件就是真实 CAD 软件能读的那种，能证明转换链路读的是真 STEP。

    .artifacts-data/venvs/cad/bin/python scripts/make_cad_fixtures.py <输出目录>
"""

import os
import sys

from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.gp import gp_Trsf, gp_Vec
from OCP.IGESControl import IGESControl_Writer
from OCP.STEPControl import STEPControl_StepModelType, STEPControl_Writer


def write_step(shape, path):
    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_StepModelType.STEPControl_AsIs)
    if writer.Write(path) != 1:      # IFSelect_RetDone
        raise RuntimeError(f"STEP 写出失败：{path}")
    return path


def write_iges(shape, path):
    writer = IGESControl_Writer()
    writer.AddShape(shape)
    writer.Write(path)
    return path


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    made = []

    # 1) 最基本的立方体：解析出来必须正好 12 个三角形、24 个顶点。
    box = BRepPrimAPI_MakeBox(40.0, 25.0, 12.0).Shape()
    made.append(write_step(box, os.path.join(out_dir, "box.step")))

    # 2) 立方体挖个圆柱孔：验证多面 + 圆弧面网格化、绕序与法线方向。
    move = gp_Trsf()
    move.SetTranslation(gp_Vec(20.0, 12.5, -5.0))
    hole = BRepBuilderAPI_Transform(BRepPrimAPI_MakeCylinder(6.0, 22.0).Shape(),
                                    move, True).Shape()
    made.append(write_step(BRepAlgoAPI_Cut(box, hole).Shape(),
                           os.path.join(out_dir, "box-with-hole.step")))

    # 3) IGES 走另一条读取路径。
    made.append(write_iges(BRepPrimAPI_MakeBox(10.0, 10.0, 10.0).Shape(),
                           os.path.join(out_dir, "cube.iges")))

    for path in made:
        print(f"{os.path.getsize(path):>8} B  {path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "testdata/cad")
