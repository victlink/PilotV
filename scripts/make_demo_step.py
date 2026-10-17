#!/usr/bin/env python3
"""生成一个真实的三维机械零件（STEP），用来验「成果台三维查看」这条链路。

不是拿假图糊弄：这里用 OCP（OpenCascade）真的建实体、真的切孔、真的导出 STEP，
后面成果台会用同一套转换器把它转成 glb 交给 model-viewer 渲染旋转。

    /home/marc/pilotv-artifacts/data/venvs/cad/bin/python scripts/make_demo_step.py \
        --out testdata/cad/flange.step

参数（都有默认值，演示用不需要改）：
  --plate-r   法兰盘半径 mm（默认 45）
  --plate-t   法兰盘厚度 mm（默认 10）
  --bolt-n    螺栓孔数量（默认 6）
  --bolt-r    螺栓孔半径 mm（默认 4）
  --bore-r    中心孔半径 mm（默认 12）
  --boss-r    中心凸台半径 mm（默认 22）
  --boss-h    凸台高度 mm（默认 18）
"""
from __future__ import annotations

import argparse
import math
import pathlib

from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
from OCP.STEPControl import STEPControl_Writer, STEPControl_StepModelType
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_EDGE
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.GeomAbs import GeomAbs_Circle
from OCP.TopoDS import TopoDS


def build(plate_r: float, plate_t: float, bolt_n: int, bolt_r: float,
          bore_r: float, boss_r: float, boss_h: float):
    z = gp_Pnt(0, 0, 0)
    axis = gp_Dir(0, 0, 1)

    plate = BRepPrimAPI_MakeCylinder(gp_Ax2(z, axis), plate_r, plate_t).Shape()
    boss = BRepPrimAPI_MakeCylinder(gp_Ax2(z, axis), boss_r, boss_h).Shape()
    solid = BRepAlgoAPI_Fuse(plate, boss).Shape()

    bore = BRepPrimAPI_MakeCylinder(gp_Ax2(z, axis), bore_r, boss_h + 20).Shape()
    solid = BRepAlgoAPI_Cut(solid, bore).Shape()

    pcd = plate_r * 0.72
    for i in range(bolt_n):
        ang = 2 * math.pi * i / bolt_n
        cx = pcd * math.cos(ang)
        cy = pcd * math.sin(ang)
        cut = BRepPrimAPI_MakeCylinder(
            gp_Ax2(gp_Pnt(cx, cy, -5), axis), bolt_r, plate_t + 10).Shape()
        solid = BRepAlgoAPI_Cut(solid, cut).Shape()

    # 盘外缘倒一圈圆角：真机加工件不会留锐边，顺手让渲染有高光可看。
    try:
        fillet = BRepFilletAPI_MakeFillet(solid)
        exp = TopExp_Explorer(solid, TopAbs_EDGE)
        done = 0
        while exp.More():
            edge = TopoDS.Edge_s(exp.Current())
            curve = BRepAdaptor_Curve(edge)
            if curve.GetType() == GeomAbs_Circle:
                circ = curve.Circle()
                if abs(circ.Radius() - plate_r) < 1e-6:
                    fillet.Add(2.0, edge)
                    done += 1
            exp.Next()
        if done:
            solid = fillet.Shape()
    except Exception as exc:  # 倒角失败也别让整个零件没了
        print(f"warn: 倒角跳过 ({exc})")
    return solid


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="testdata/cad/flange.step")
    ap.add_argument("--plate-r", type=float, default=45.0)
    ap.add_argument("--plate-t", type=float, default=10.0)
    ap.add_argument("--bolt-n", type=int, default=6)
    ap.add_argument("--bolt-r", type=float, default=4.0)
    ap.add_argument("--bore-r", type=float, default=12.0)
    ap.add_argument("--boss-r", type=float, default=22.0)
    ap.add_argument("--boss-h", type=float, default=18.0)
    args = ap.parse_args()

    shape = build(args.plate_r, args.plate_t, args.bolt_n, args.bolt_r,
                  args.bore_r, args.boss_r, args.boss_h)

    out = pathlib.Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_StepModelType.STEPControl_AsIs)
    status = writer.Write(str(out))
    kb = out.stat().st_size / 1024 if out.exists() else 0
    print(f"STEP 写出 {'成功' if status else '失败'}: {out} ({kb:.1f} KB)")
    print(f"螺栓孔 {args.bolt_n}×Ø{args.bolt_r*2:g}  中心孔 Ø{args.bore_r*2:g}  "
          f"法兰 Ø{args.plate_r*2:g}×{args.plate_t:g}  凸台 Ø{args.boss_r*2:g}×{args.boss_h:g}")


if __name__ == "__main__":
    main()
