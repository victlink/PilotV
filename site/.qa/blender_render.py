#!/usr/bin/env python3
"""Blender 无头渲染：给介绍页生成工业设计效果图与车间场景图。

用法（本机 GPU 驱动不匹配，Cycles 走 CPU；系统 Blender 未编 OpenImageDenoise，
脚本会自动关降噪并把采样翻倍）:
  blender -b -P site/.qa/blender_render.py -- --scene product --out review/render/product.png \
      --width 1600 --height 1000 --samples 256
  blender -b -P site/.qa/blender_render.py -- --scene all --outdir review/render --samples 256
  blender -b -P site/.qa/blender_render.py -- --scene cnc --preview   # 800x500/96 采样快出图

场景:
  product  工业设计效果图：无线振动传感器节点（深色阳极氧化 + 机加工亮件 + 玻璃）
  cnc      加工中心：立式加工中心 + 观察窗腔内主轴/工作台 + 发光操作屏 + 三色灯塔
  robot    数控机器人产线：六轴焊接机器人 + 安全围栏 + 工装夹具 + 输送线 + 地面标线
"""
from __future__ import annotations

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

# ──────────────────────────── 通用工具 ────────────────────────────


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = "METRIC"


def mat(name, base, metallic=0.0, rough=0.4, *, spec=0.5, coat=0.0,
        noise_rough=0.0, noise_scale=60.0, emission=None, emission_strength=0.0,
        transmission=0.0, ior=1.45, bump=0.0, aniso=0.0):
    """建一个 Principled 材质；noise_rough>0 时叠程序化粗糙度（磨砂/铸件/拉丝感）。"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    inp = bsdf.inputs

    # Blender 4.x 改名为 Transmission Weight / Specular IOR Level，这里做别名兼容
    alias = {"Transmission": ("Transmission Weight", "Transmission"),
             "Specular": ("Specular IOR Level", "Specular"),
             "Emission": ("Emission Color", "Emission")}

    def setv(key, val):
        for name in alias.get(key, (key,)):
            if name in inp:
                inp[name].default_value = val
                return

    setv("Base Color", (*base, 1.0))
    setv("Metallic", metallic)
    setv("Roughness", rough)
    setv("Specular", spec)
    setv("Coat Weight", coat)
    setv("Transmission", transmission)
    setv("IOR", ior)
    setv("Anisotropic", aniso)
    if emission is not None:
        setv("Emission Color", (*emission, 1.0))
        setv("Emission Strength", emission_strength)

    if noise_rough > 0:
        tex = nt.nodes.new("ShaderNodeTexNoise")
        tex.inputs["Scale"].default_value = noise_scale
        tex.inputs["Detail"].default_value = 6.0
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        lo = max(0.02, rough - noise_rough)
        hi = min(1.0, rough + noise_rough)
        ramp.color_ramp.elements[0].position = 0.35
        ramp.color_ramp.elements[0].color = (lo, lo, lo, 1)
        ramp.color_ramp.elements[1].position = 0.65
        ramp.color_ramp.elements[1].color = (hi, hi, hi, 1)
        nt.links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], inp["Roughness"])

    if bump > 0:
        bmp = nt.nodes.new("ShaderNodeBump")
        bmp.inputs["Strength"].default_value = bump
        bmp.inputs["Distance"].default_value = 0.002
        src = nt.nodes.new("ShaderNodeTexNoise")
        src.inputs["Scale"].default_value = 220.0
        src.inputs["Detail"].default_value = 8.0
        nt.links.new(src.outputs["Fac"], bmp.inputs["Height"])
        nt.links.new(bmp.outputs["Normal"], inp["Normal"])
    return m


def assign(obj, material, smooth=False):
    obj.data.materials.append(material)
    if smooth:
        for p in obj.data.polygons:
            p.use_smooth = True
    return obj


def bevel(obj, width=0.006, segments=3, angle=math.radians(40)):
    mod = obj.modifiers.new("bev", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = angle
    return mod


def cube(name, size, loc=(0, 0, 0), rot=(0, 0, 0), material=None, bev=0.006):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    ob = bpy.context.object
    ob.name = name
    ob.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if material:
        assign(ob, material)
    if bev:
        bevel(ob, bev)
    return ob


def cyl(name, r, h, loc=(0, 0, 0), rot=(0, 0, 0), material=None, verts=64,
        smooth=True, bev=0.0, r2=None):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=(r if r2 is None else r2),
                                    depth=h, location=loc, rotation=rot)
    ob = bpy.context.object
    ob.name = name
    if material:
        assign(ob, material, smooth=smooth)
    if bev:
        bevel(ob, bev)
    return ob


def area_light(name, loc, target, size, power, color=(1, 1, 1), size_y=None, shape="RECTANGLE"):
    data = bpy.data.lights.new(name, type="AREA")
    data.energy = power
    data.color = color
    data.shape = shape
    data.size = size
    if size_y is not None:
        data.size_y = size_y
    ob = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(ob)
    ob.location = loc
    d = Vector(target) - Vector(loc)
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    return ob


def point_light(name, loc, power, color=(1, 1, 1), radius=0.05):
    data = bpy.data.lights.new(name, type="POINT")
    data.energy = power
    data.color = color
    data.shadow_soft_size = radius
    ob = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(ob)
    ob.location = loc
    return ob


def studio_world(top=(0.05, 0.055, 0.07), bottom=(0.012, 0.013, 0.016), strength=1.0):
    """渐变世界：顶部略亮、地平线偏暗，给金属反射一个自然的天光梯度。"""
    w = bpy.data.worlds.new("W")
    bpy.context.scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    grad = nt.nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "LINEAR"
    mapping = nt.nodes.new("ShaderNodeMapping")
    tex = nt.nodes.new("ShaderNodeTexCoord")
    mapping.inputs["Rotation"].default_value = (0, math.radians(90), 0)
    mapping.inputs["Location"].default_value = (0, 0, 0.5)
    ramp.color_ramp.elements[0].color = (*bottom, 1)
    ramp.color_ramp.elements[1].color = (*top, 1)
    nt.links.new(tex.outputs["Generated"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], grad.inputs["Vector"])
    nt.links.new(grad.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    return w


def look_at_camera(loc, target, lens=70, fstop=None):
    data = bpy.data.cameras.new("cam")
    ob = bpy.data.objects.new("cam", data)
    bpy.context.collection.objects.link(ob)
    ob.location = loc
    d = Vector(target) - Vector(loc)
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    data.lens = lens
    data.clip_start = 0.01
    data.clip_end = 300
    if fstop:
        data.dof.use_dof = True
        data.dof.aperture_fstop = fstop
        focus = bpy.data.objects.new("focus", None)
        bpy.context.collection.objects.link(focus)
        focus.location = target
        data.dof.focus_object = focus
    bpy.context.scene.camera = ob
    return ob


def floor_plane(name="floor", size=60, material=None, z=0.0):
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, z))
    ob = bpy.context.object
    ob.name = name
    if material:
        assign(ob, material)
    return ob


def text_obj(name, body, loc, rot=(0, 0, 0), size=0.05, material=None, align="CENTER",
             extrude=0.0006, font=None):
    bpy.ops.object.text_add(location=loc, rotation=rot)
    ob = bpy.context.object
    ob.name = name
    ob.data.body = body
    ob.data.size = size
    ob.data.align_x = align
    ob.data.align_y = "CENTER"
    ob.data.extrude = extrude
    if font:
        ob.data.font = font
    if material:
        assign(ob, material)
    return ob


def load_font(path):
    try:
        return bpy.data.fonts.load(path)
    except Exception:
        return None


def render(out, width, height, samples, *, exposure=0.0, denoise=True):
    scn = bpy.context.scene
    scn.render.engine = "CYCLES"
    scn.cycles.device = "CPU"
    scn.cycles.samples = samples
    scn.cycles.use_denoising = denoise
    scn.cycles.max_bounces = 8
    scn.cycles.transmission_bounces = 8
    scn.cycles.transparent_max_bounces = 8
    scn.cycles.use_adaptive_sampling = True
    scn.cycles.adaptive_threshold = 0.008
    scn.render.resolution_x = width
    scn.render.resolution_y = height
    scn.render.resolution_percentage = 100
    scn.render.film_transparent = False
    scn.render.image_settings.file_format = "PNG"
    scn.render.image_settings.color_mode = "RGB"
    scn.render.filepath = out
    try:
        scn.view_settings.view_transform = "AgX"
        scn.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        scn.view_settings.view_transform = "Filmic"
    scn.view_settings.exposure = exposure
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    try:
        bpy.ops.render.render(write_still=True)
    except RuntimeError as exc:
        if "OpenImageDenoiser" not in str(exc):
            raise
        print("OIND 不可用：关降噪、采样翻倍重渲", flush=True)
        scn.cycles.use_denoising = False
        scn.cycles.samples = samples * 2
        scn.cycles.adaptive_threshold = 0.005
        bpy.ops.render.render(write_still=True)
    print("WROTE", out, flush=True)


# ──────────────────────────── 场景 1：工业设计 ────────────────────────────

def build_product() -> None:
    """无线振动传感器节点：深色阳极氧化筒身 + 机加工亮环 + 黑玻璃顶盖 + M12 接口。"""
    studio_world(top=(0.045, 0.05, 0.062), bottom=(0.006, 0.007, 0.009), strength=1.0)

    alu = mat("alu_dark", (0.055, 0.060, 0.070), metallic=1.0, rough=0.34,
              noise_rough=0.10, noise_scale=220.0, aniso=0.30)
    alu_mid = mat("alu_mid", (0.46, 0.47, 0.485), metallic=1.0, rough=0.24,
                  noise_rough=0.07, noise_scale=260.0)
    steel = mat("steel", (0.58, 0.59, 0.60), metallic=1.0, rough=0.20,
                noise_rough=0.06, noise_scale=400.0)
    glass = mat("glass_top", (0.012, 0.013, 0.016), metallic=0.0, rough=0.045, coat=1.0, spec=0.75)
    rubber = mat("rubber", (0.018, 0.019, 0.021), metallic=0.0, rough=0.72,
                 noise_rough=0.10, noise_scale=900.0, bump=0.25)
    orange = mat("orange", (0.82, 0.24, 0.02), metallic=0.0, rough=0.42)
    led = mat("led", (0.2, 0.9, 0.5), metallic=0.0, rough=0.15,
              emission=(0.15, 1.0, 0.55), emission_strength=6.0)
    lens = mat("lens", (0.05, 0.08, 0.12), metallic=0.1, rough=0.05, coat=1.0)
    plate = mat("label_plate", (0.62, 0.63, 0.645), metallic=0.2, rough=0.42)
    ground = mat("ground", (0.022, 0.023, 0.027), metallic=0.05, rough=0.38,
                 noise_rough=0.10, noise_scale=40.0)
    ink = mat("ink", (0.04, 0.04, 0.04), rough=0.6)
    ink2 = mat("ink2", (0.10, 0.10, 0.10), rough=0.6)
    mark = mat("mark", (0.72, 0.73, 0.75), rough=0.45)

    fnt = load_font("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf")

    cyl("base", 0.052, 0.018, loc=(0, 0, 0.009), material=alu, verts=96, bev=0.002)
    cyl("base_ring", 0.0555, 0.012, loc=(0, 0, 0.021), material=steel, verts=96, bev=0.0015)
    cyl("gasket", 0.0522, 0.004, loc=(0, 0, 0.029), material=rubber, verts=96)
    cyl("body", 0.048, 0.118, loc=(0, 0, 0.0905), material=alu, verts=128, bev=0.004)
    for i in range(2):
        cyl(f"knurl{i}", 0.0487, 0.030, loc=(0, 0, 0.055 + i * 0.085), material=alu_mid, verts=128)
    cyl("shoulder", 0.048, 0.010, loc=(0, 0, 0.1545), material=alu, verts=128, bev=0.002)
    cyl("cap", 0.0455, 0.014, loc=(0, 0, 0.1665), material=glass, verts=128, bev=0.003)
    cyl("cap_ring", 0.0468, 0.004, loc=(0, 0, 0.1595), material=steel, verts=128, bev=0.0008)
    cyl("lens_barrel", 0.016, 0.010, loc=(0, 0, 0.1745), material=steel, verts=64, bev=0.001)
    cyl("lens_glass", 0.0125, 0.004, loc=(0, 0, 0.1795), material=lens, verts=64)
    cyl("led_ring", 0.0032, 0.003, loc=(0.030, 0.0, 0.1745), material=led, verts=32)
    cyl("conn", 0.011, 0.016, loc=(0.0475, 0, 0.100), rot=(0, math.radians(90), 0),
        material=steel, verts=48, bev=0.001)
    cyl("conn_ring", 0.0125, 0.004, loc=(0.0475, 0, 0.100), rot=(0, math.radians(90), 0),
        material=orange, verts=48, bev=0.0008)
    cyl("conn_bore", 0.0065, 0.020, loc=(0.0475, 0, 0.100), rot=(0, math.radians(90), 0),
        material=rubber, verts=32)
    cube("label", (0.046, 0.0012, 0.020), loc=(0, -0.0478, 0.075), material=plate, bev=0.0004)
    text_obj("label_t1", "VICTLINK  VX-210", (0, -0.0489, 0.0795),
             rot=(math.radians(90), 0, 0), size=0.0062, material=ink, font=fnt)
    text_obj("label_t2", "SN 2408-0177  IP67", (0, -0.0489, 0.0705),
             rot=(math.radians(90), 0, 0), size=0.0048, material=ink2, font=fnt)
    text_obj("body_mark", "VICTLINK", (0.0215, 0.0, 0.140),
             rot=(math.radians(90), 0, math.radians(90)), size=0.0075, material=mark, font=fnt)

    floor_plane(material=ground)
    area_light("key", (0.34, -0.30, 0.42), (0, 0, 0.09), size=0.62, size_y=0.42,
               power=20, color=(1.0, 0.97, 0.93))
    area_light("strip", (-0.42, -0.10, 0.20), (0, 0, 0.09), size=0.06, size_y=0.55,
               power=18, color=(0.80, 0.88, 1.0))
    area_light("rim", (-0.10, 0.42, 0.34), (0, 0, 0.10), size=0.5, size_y=0.25,
               power=34, color=(1.0, 0.93, 0.85))
    area_light("fill", (0.30, 0.30, 0.16), (0, 0, 0.08), size=0.5, size_y=0.5,
               power=7, color=(0.9, 0.94, 1.0))
    look_at_camera((0.46, -0.40, 0.255), (0, 0, 0.095), lens=60, fstop=7.1)


# ──────────────────────────── 场景 2：加工中心 ────────────────────────────

def build_cnc() -> None:
    """立式加工中心：钣金外壳 + 双开观察门 + 腔内主轴/工作台 + 悬臂操作屏 + 三色灯塔。"""
    studio_world(top=(0.026, 0.028, 0.034), bottom=(0.005, 0.005, 0.007), strength=0.8)

    shell = mat("shell", (0.205, 0.215, 0.230), metallic=0.30, rough=0.36,
                noise_rough=0.05, noise_scale=140.0)
    shell_dark = mat("shell_dark", (0.052, 0.055, 0.062), metallic=0.40, rough=0.42,
                     noise_rough=0.07, noise_scale=160.0)
    steel = mat("steel", (0.52, 0.53, 0.545), metallic=1.0, rough=0.26, noise_rough=0.07, noise_scale=300.0)
    iron = mat("cast_iron", (0.13, 0.135, 0.145), metallic=0.85, rough=0.52,
               noise_rough=0.13, noise_scale=90.0, bump=0.2)
    glass = mat("window", (0.86, 0.92, 0.96), metallic=0.0, rough=0.0, transmission=1.0, ior=1.45)
    alu = mat("alu", (0.62, 0.63, 0.64), metallic=1.0, rough=0.28, noise_rough=0.09, noise_scale=280.0)
    orange = mat("orange", (0.80, 0.26, 0.03), metallic=0.0, rough=0.40)
    screen = mat("screen", (0.02, 0.03, 0.04), metallic=0.0, rough=0.12,
                 emission=(0.10, 0.36, 0.55), emission_strength=2.2)
    estop = mat("estop", (0.70, 0.05, 0.04), rough=0.35)
    lamp_g = mat("lamp_green", (0.1, 0.8, 0.35), emission=(0.1, 1.0, 0.4), emission_strength=10.0, rough=0.2)
    lamp_a = mat("lamp_amber", (0.9, 0.5, 0.05), emission=(1.0, 0.55, 0.05), emission_strength=8.0, rough=0.2)
    lamp_r = mat("lamp_red", (0.8, 0.1, 0.1), emission=(1.0, 0.12, 0.12), emission_strength=5.0, rough=0.2)
    floor_m = mat("shopfloor", (0.085, 0.09, 0.10), metallic=0.1, rough=0.45,
                  noise_rough=0.10, noise_scale=26.0)
    led_strip = mat("led_strip", (0.9, 0.95, 1.0), emission=(0.85, 0.93, 1.0), emission_strength=3.5, rough=0.4)
    brand_ink = mat("brand_ink", (0.80, 0.82, 0.84), rough=0.45)
    brand_ink2 = mat("brand_ink2", (0.42, 0.45, 0.48), rough=0.5)

    fnt = load_font("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")

    # ── 机身：底座 + 后墙 + 左右立柱 + 顶梁，正面留 1.24m 开口
    cube("pedestal", (2.44, 1.80, 0.44), loc=(0, 0, 0.22), material=shell_dark, bev=0.012)
    cube("back_wall", (2.44, 0.22, 2.60), loc=(0, 0.79, 1.74), material=shell, bev=0.010)
    cube("bay_liner", (1.34, 0.06, 2.34), loc=(0.0, 0.66, 1.70), material=shell_dark, bev=0.006)
    for xx in (-0.66, 0.66):
        cube(f"bay_side{xx}", (0.06, 1.44, 2.34), loc=(xx, 0.0, 1.70), material=shell_dark, bev=0.006)
    cube("bay_ceiling", (1.34, 1.44, 0.06), loc=(0.0, 0.0, 2.86), material=shell_dark, bev=0.006)
    cube("left_column", (0.60, 1.80, 2.60), loc=(-0.92, 0, 1.74), material=shell, bev=0.012)
    cube("right_column", (0.60, 1.80, 2.60), loc=(0.92, 0, 1.74), material=shell, bev=0.012)
    cube("top_beam", (2.44, 1.80, 0.44), loc=(0, 0, 3.26), material=shell, bev=0.012)
    cube("chip_trough", (1.24, 1.70, 0.22), loc=(0, 0, 0.55), material=iron, bev=0.006)
    cube("splash", (1.24, 0.06, 0.26), loc=(0, -0.86, 0.62), material=steel, bev=0.004)

    # ── 双开观察门（正面）：门板做成边框 + 玻璃留真实开口，能看见腔内
    for s_, xc in ((-1, -0.32), (1, 0.32)):
        cube(f"door_bot{s_}", (0.60, 0.06, 0.59), loc=(xc, -0.90, 0.865), material=shell, bev=0.008)
        cube(f"door_top{s_}", (0.60, 0.06, 0.27), loc=(xc, -0.90, 2.535), material=shell, bev=0.008)
        cube(f"door_l{s_}", (0.08, 0.06, 1.24), loc=(xc - 0.26, -0.90, 1.78), material=shell, bev=0.006)
        cube(f"door_r{s_}", (0.08, 0.06, 1.24), loc=(xc + 0.26, -0.90, 1.78), material=shell, bev=0.006)
        cube(f"door_glass{s_}", (0.44, 0.012, 1.24), loc=(xc, -0.90, 1.78), material=glass, bev=0.002)
        for zz in (1.16, 2.40):
            cube(f"door_seal{s_}_{zz}", (0.46, 0.035, 0.022), loc=(xc, -0.905, zz),
                 material=steel, bev=0.003)
        for xx in (xc - 0.222, xc + 0.222):
            cube(f"door_sealv{s_}_{xx}", (0.022, 0.035, 1.26), loc=(xx, -0.905, 1.78),
                 material=steel, bev=0.003)
    cube("accent", (1.24, 0.03, 0.05), loc=(0, -0.935, 2.62), material=orange, bev=0.004)
    cyl("handle_l", 0.017, 0.42, loc=(-0.055, -0.955, 1.70), material=steel, verts=24)
    cyl("handle_r", 0.017, 0.42, loc=(0.055, -0.955, 1.70), material=steel, verts=24)

    # ── 腔内：工作台 + 工件 + 立柱 + 主轴 + 刀具 + 冷却喷嘴
    cube("table_base", (1.00, 0.94, 0.34), loc=(0.02, -0.02, 0.85), material=iron, bev=0.008)
    cube("table_top", (1.08, 1.00, 0.08), loc=(0.02, -0.02, 1.03), material=steel, bev=0.004)
    for i in range(7):
        cube(f"tslot{i}", (0.035, 1.00, 0.012), loc=(-0.42 + i * 0.147, -0.02, 1.075),
             material=iron, bev=0.002)
    cyl("workpiece", 0.20, 0.11, loc=(0.02, -0.06, 1.125), material=alu, verts=96, bev=0.006)
    cyl("workpiece_bore", 0.105, 0.16, loc=(0.02, -0.06, 1.125), material=iron, verts=96)
    for i in range(6):
        a = i * math.pi / 3 + 0.2
        cyl(f"wbolt{i}", 0.018, 0.11,
            loc=(0.02 + 0.152 * math.cos(a), -0.06 + 0.152 * math.sin(a), 1.125),
            material=steel, verts=24)
    cube("column_back", (0.36, 0.36, 1.70), loc=(0.42, 0.46, 2.00), material=iron, bev=0.008)
    cube("ram_block", (0.30, 0.30, 0.90), loc=(0.02, 0.22, 2.35), material=iron, bev=0.008)
    cyl("spindle_body", 0.145, 0.46, loc=(0.02, 0.0, 2.06), material=shell_dark, verts=64, bev=0.010)
    cyl("spindle_nose", 0.105, 0.14, loc=(0.02, 0.0, 1.78), material=steel, verts=64, bev=0.004)
    cyl("tool_holder", 0.058, 0.15, loc=(0.02, 0.0, 1.63), material=steel, verts=48, bev=0.003)
    cyl("tool", 0.020, 0.17, loc=(0.02, 0.0, 1.50), material=iron, verts=32)
    cyl("nozzle", 0.014, 0.34, loc=(0.20, -0.16, 1.86),
        rot=(math.radians(26), 0, math.radians(-22)), material=steel, verts=24)
    cyl("nozzle_tip", 0.011, 0.06, loc=(0.262, -0.226, 1.71),
        rot=(math.radians(26), 0, math.radians(-22)), material=steel, verts=24)
    cube("bay_led", (0.90, 0.05, 0.03), loc=(0.0, -0.30, 2.60), material=led_strip, bev=0.0)

    # ── 右侧电气柜 + 散热格栅 + 品牌字
    cube("elec_panel", (0.04, 1.30, 1.90), loc=(1.23, -0.20, 1.70), material=shell, bev=0.006)
    for i in range(10):
        cube(f"louver{i}", (0.03, 0.50, 0.035), loc=(1.255, 0.30, 0.62 + i * 0.075),
             material=shell_dark, bev=0.004)
    text_obj("brand", "VICTLINK", (0.0, -0.938, 2.94), rot=(math.radians(90), 0, 0),
             size=0.150, material=brand_ink, font=fnt)
    text_obj("model", "VMC-850  5-AXIS", (0.0, -0.938, 2.76), rot=(math.radians(90), 0, 0),
             size=0.058, material=brand_ink2, font=fnt)

    # ── 悬臂操作面板（右侧）
    cube("pendant_arm1", (0.12, 0.12, 0.12), loc=(1.22, -0.30, 2.40),
         material=shell_dark, bev=0.016)
    cube("pendant_arm2", (1.05, 0.11, 0.11), loc=(1.70, -0.30, 2.40),
         material=shell_dark, bev=0.016)
    cube("pendant_arm3", (0.10, 0.10, 0.62), loc=(1.80, -0.86, 2.16),
         material=shell_dark, bev=0.016)
    cube("pendant", (0.52, 0.13, 0.74), loc=(1.80, -0.98, 1.80),
         rot=(math.radians(-20), 0, math.radians(-26)), material=shell_dark, bev=0.014)
    cube("pendant_screen", (0.40, 0.03, 0.34), loc=(1.766, -1.036, 1.93),
         rot=(math.radians(-20), 0, math.radians(-26)), material=screen, bev=0.004)
    cyl("e_stop", 0.033, 0.030, loc=(1.98, -1.086, 1.60),
        rot=(math.radians(70), 0, math.radians(-26)), material=estop, verts=32)
    for i in range(6):
        cyl(f"btn{i}", 0.015, 0.020,
            loc=(1.62 + (i % 3) * 0.050, -1.072, 1.62 - (i // 3) * 0.046),
            rot=(math.radians(70), 0, math.radians(-26)), material=steel, verts=24)
    cyl("handwheel", 0.072, 0.034, loc=(1.80, -1.072, 1.47),
        rot=(math.radians(70), 0, math.radians(-26)), material=steel, verts=48, bev=0.004)

    # ── 三色灯塔
    cyl("tower_post", 0.022, 0.34, loc=(0.55, -0.72, 3.65), material=shell_dark, verts=24)
    cyl("tower_green", 0.058, 0.11, loc=(0.55, -0.72, 3.86), material=lamp_g, verts=48)
    cyl("tower_amber", 0.058, 0.11, loc=(0.55, -0.72, 3.97), material=lamp_a, verts=48)
    cyl("tower_red", 0.058, 0.11, loc=(0.55, -0.72, 4.08), material=lamp_r, verts=48)
    cyl("tower_cap", 0.060, 0.03, loc=(0.55, -0.72, 4.15), material=shell_dark, verts=48)

    # ── 地面、标线、料桶
    floor_plane(material=floor_m)
    cube("safety_line", (6.0, 0.06, 0.004), loc=(0, -2.35, 0.004), material=orange, bev=0.0)
    cube("safety_line2", (0.06, 4.6, 0.004), loc=(-2.9, 0, 0.004), material=orange, bev=0.0)
    cyl("chip_bin", 0.30, 0.55, loc=(1.75, 1.15, 0.275), material=steel, verts=48, bev=0.006)
    for i in range(5):
        cyl(f"chip{i}", 0.03 + 0.008 * (i % 3), 0.012, loc=(1.75 + 0.06 * (i - 2), 1.15, 0.56),
            rot=(0, math.radians(6 * i), 0), material=alu, verts=16)

    # ── 灯光
    area_light("shop_top", (-0.4, -0.7, 6.3), (0.0, 0.0, 1.6), size=4.5, size_y=3.0,
               power=1700, color=(0.97, 0.98, 1.0))
    area_light("shop_side", (3.9, 2.2, 4.2), (0.2, 0.2, 2.0), size=3.0, size_y=2.4,
               power=520, color=(1.0, 0.94, 0.86))
    area_light("rim_back", (-3.4, 3.4, 3.8), (0, 0.2, 2.0), size=2.5, size_y=2.0,
               power=620, color=(0.80, 0.88, 1.0))
    area_light("front_fill", (1.6, -4.6, 2.0), (0, 0, 1.8), size=3.0, size_y=2.0,
               power=260, color=(0.95, 0.97, 1.0))
    area_light("bay_light", (0.0, -0.35, 2.58), (0.0, -0.05, 1.0), size=0.95, size_y=0.55,
               power=105, color=(0.90, 0.95, 1.0))
    area_light("bay_spot", (0.02, -0.78, 2.32), (0.02, 0.0, 1.10), size=0.35, size_y=0.35,
               power=75, color=(1.0, 0.96, 0.90))
    area_light("bay_fill", (-0.60, -0.30, 1.95), (0.35, 0.10, 1.45), size=0.5, size_y=0.9,
               power=26, color=(0.85, 0.92, 1.0))
    area_light("bay_front", (0.0, -0.72, 1.55), (0.0, 0.30, 1.30), size=0.9, size_y=0.5,
               power=28, color=(0.92, 0.95, 1.0))
    # 腔顶工作灯带：既照亮腔内，也让观察窗里有真实光源
    for k, dx in enumerate((-0.33, 0.33)):
        cube(f"bay_lamp{k}", (0.86, 0.085, 0.030), loc=(dx, -0.05, 2.795),
             material=led_strip, bev=0.006)
        cube(f"bay_lamp_hood{k}", (0.92, 0.12, 0.05), loc=(dx, -0.05, 2.835),
             material=shell_dark, bev=0.006)
    point_light("led_glow", (0.55, -0.72, 3.86), power=6, color=(0.2, 1.0, 0.45), radius=0.08)
    look_at_camera((6.05, -7.55, 3.35), (0.10, -0.10, 1.92), lens=45)


# ──────────────────────────── 场景 3：机器人产线 ────────────────────────────

def build_robot() -> None:
    """六轴焊接机器人单元：机器人 + 焊枪火花 + 工装夹具 + 输送线 + 安全围栏 + 地面标线。"""
    studio_world(top=(0.028, 0.030, 0.036), bottom=(0.006, 0.006, 0.008), strength=0.85)

    body_w = mat("robot_white", (0.72, 0.725, 0.73), metallic=0.05, rough=0.32,
                 noise_rough=0.05, noise_scale=200.0, coat=0.25)
    body_o = mat("robot_orange", (0.72, 0.17, 0.02), metallic=0.05, rough=0.30,
                 noise_rough=0.05, noise_scale=200.0, coat=0.3)
    body_d = mat("robot_dark", (0.038, 0.040, 0.045), metallic=0.45, rough=0.38)
    steel = mat("steel", (0.50, 0.51, 0.525), metallic=1.0, rough=0.28, noise_rough=0.08, noise_scale=280.0)
    iron = mat("iron", (0.11, 0.115, 0.125), metallic=0.8, rough=0.55,
               noise_rough=0.12, noise_scale=80.0, bump=0.2)
    yellow = mat("safety_yellow", (0.80, 0.52, 0.03), metallic=0.0, rough=0.45)
    orange = mat("line_orange", (0.78, 0.26, 0.04), rough=0.5)
    floor_m = mat("shopfloor", (0.075, 0.079, 0.086), metallic=0.1, rough=0.45,
                  noise_rough=0.10, noise_scale=22.0)
    cell_floor = mat("cellfloor", (0.05, 0.052, 0.058), rough=0.55)
    belt = mat("belt", (0.028, 0.030, 0.033), rough=0.62, noise_rough=0.08,
               noise_scale=400.0, bump=0.3)
    alu = mat("alu", (0.60, 0.61, 0.62), metallic=1.0, rough=0.26, noise_rough=0.08, noise_scale=300.0)
    mesh_m = mat("mesh", (0.22, 0.23, 0.24), metallic=0.8, rough=0.45)
    screen_blue = mat("screen_blue", (0.02, 0.05, 0.09), rough=0.15,
                      emission=(0.10, 0.34, 0.54), emission_strength=0.85)
    wood = mat("pallet", (0.30, 0.21, 0.12), rough=0.72, noise_rough=0.12, noise_scale=60.0)
    card = mat("carton", (0.36, 0.27, 0.17), rough=0.78, noise_rough=0.10, noise_scale=90.0)
    spark = mat("spark", (1.0, 0.85, 0.5), emission=(1.0, 0.78, 0.38),
                emission_strength=16.0, rough=0.3)
    glow = mat("glow", (1.0, 0.92, 0.75), emission=(1.0, 0.88, 0.62),
               emission_strength=5.0, rough=0.4)
    ceiling_lamp = mat("ceiling_lamp", (1.0, 0.97, 0.9), emission=(1.0, 0.96, 0.88),
                       emission_strength=6.0, rough=0.5)
    brand_w = mat("brand_w", (0.85, 0.86, 0.87), rough=0.5)
    ink_d = mat("ink_d", (0.10, 0.11, 0.12), rough=0.5)

    fnt = load_font("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")

    # ── 六轴机器人（肩 → 肘 → 腕，末端焊枪对准工装上的工件）
    cyl("rb_base", 0.32, 0.10, loc=(0, 0, 0.05), material=body_d, verts=64, bev=0.006)
    cyl("rb_base_ring", 0.34, 0.03, loc=(0, 0, 0.11), material=body_o, verts=64, bev=0.004)
    cyl("j1", 0.27, 0.28, loc=(0, 0, 0.25), material=body_o, verts=64, bev=0.006)
    sh = Vector((0.0, -0.16, 0.52))
    cyl("shoulder_joint", 0.132, 0.34, loc=sh, rot=(0, math.radians(90), 0),
        material=body_d, verts=48, bev=0.005)
    tilt = math.radians(40)
    upper_len = 1.00
    cube("upper_arm", (0.25, 0.23, upper_len),
         loc=sh + Vector((0, -math.sin(tilt) * upper_len / 2, math.cos(tilt) * upper_len / 2)),
         rot=(tilt, 0, 0), material=body_w, bev=0.05)
    elb = sh + Vector((0, -math.sin(tilt) * upper_len, math.cos(tilt) * upper_len))
    cyl("elbow_joint", 0.122, 0.30, loc=elb, rot=(0, math.radians(90), 0),
        material=body_d, verts=48, bev=0.005)
    fore_dir = Vector((0.0, -0.920, -0.100))
    fore_len = 0.490
    fore_ang = math.atan2(-fore_dir.y, fore_dir.z)
    cube("fore_arm", (0.20, 0.185, fore_len), loc=elb + fore_dir * (fore_len / 2),
         rot=(fore_ang, 0, 0), material=body_o, bev=0.040)
    wr = elb + fore_dir * fore_len
    cyl("wrist_joint", 0.10, 0.24, loc=wr, rot=(0, math.radians(90), 0),
        material=body_d, verts=48, bev=0.004)
    torch_dir = Vector((0.256, -0.433, -0.856))
    torch_ang = math.atan2(-torch_dir.y, torch_dir.z)
    torch_spin = math.atan2(torch_dir.x, math.hypot(torch_dir.y, torch_dir.z))
    torch_rot = (torch_ang, 0, torch_spin)
    cyl("torch_body", 0.045, 0.24, loc=wr + torch_dir * 0.15, rot=torch_rot,
        material=body_d, verts=32, bev=0.004)
    cyl("torch_neck", 0.028, 0.14, loc=wr + torch_dir * 0.32, rot=torch_rot,
        material=steel, verts=32)
    cyl("torch_nozzle", 0.016, 0.09, loc=wr + torch_dir * 0.43, rot=torch_rot,
        material=steel, verts=24)
    for k in range(5):
        d = Vector((0.256, -0.433, -0.856)) * 0.45 + Vector((
            0.018 * math.cos(k * 1.9), 0.016 * math.sin(k * 1.7), 0.012 * ((k % 3) - 1)))
        cyl(f"sparks{k}", 0.0075, 0.022, loc=wr + d, rot=torch_rot, material=spark, verts=12)
    cyl("cable", 0.030, 0.72, loc=(0.0, -0.44, 0.72),
        rot=(math.radians(50), 0, 0), material=body_d, verts=20)
    cyl("cable2", 0.026, 0.52, loc=(0.0, -0.93, 1.16),
        rot=(math.radians(96), 0, 0), material=body_d, verts=20)
    text_obj("rb_brand", "VICTLINK", (0, -0.24, 0.30), rot=(math.radians(90), 0, 0),
             size=0.055, material=brand_w, font=fnt)

    # ── 工装台 + 被焊接工件
    cube("fixture_base", (1.25, 0.95, 0.62), loc=(0.0, -1.50, 0.31), material=iron, bev=0.008)
    cube("fixture_plate", (1.06, 0.80, 0.08), loc=(0.0, -1.50, 0.66), material=steel, bev=0.004)
    for (dx, dy) in ((-0.40, -0.28), (0.40, -0.28), (-0.40, 0.28), (0.40, 0.28)):
        cyl(f"clamp{dx}_{dy}", 0.032, 0.11, loc=(dx, -1.50 + dy, 0.72),
            material=steel, verts=24)
        cyl(f"clamp_bolt{dx}_{dy}", 0.014, 0.06, loc=(dx, -1.50 + dy, 0.78),
            material=body_d, verts=16)
    cube("part_plate", (0.56, 0.44, 0.10), loc=(0.0, -1.50, 0.71), material=alu, bev=0.005)
    cyl("part_boss", 0.15, 0.15, loc=(0.0, -1.50, 0.79), material=alu, verts=48, bev=0.005)
    cyl("part_seam", 0.152, 0.045, loc=(0.0, -1.50, 0.882), material=glow, verts=64)
    cyl("weld_bead", 0.034, 0.10, loc=(0.118, -1.452, 0.895),
        rot=(0, math.radians(56), 0), material=spark, verts=24)
    for k in range(4):
        cyl(f"fly{k}", 0.010, 0.030,
            loc=(0.118 + 0.035 * math.cos(k * 2.2), -1.452 + 0.035 * math.sin(k * 2.2), 0.935),
            rot=(math.radians(20 * k), 0, 0), material=spark, verts=12)

    # ── 输送线 + 料盘
    cube("conveyor_frame", (2.30, 0.72, 0.52), loc=(2.05, -0.20, 0.26), material=iron, bev=0.008)
    cube("belt_top", (2.20, 0.64, 0.04), loc=(2.05, -0.20, 0.54), material=belt, bev=0.004)
    for i in range(3):
        cyl(f"tray{i}", 0.19, 0.08, loc=(1.40 + i * 0.62, -0.20, 0.60),
            material=steel, verts=48, bev=0.005)
        cyl(f"tray_p{i}", 0.12, 0.05, loc=(1.40 + i * 0.62, -0.20, 0.66),
            material=alu, verts=48)
    for s in (-1, 1):
        cyl(f"motor{s}", 0.07, 0.20, loc=(2.05 + s * 1.24, -0.20, 0.40),
            rot=(0, math.radians(90), 0), material=body_d, verts=32)

    # ── 安全围栏（后/左/右三面，朝镜头一面敞开）
    for (x, y) in ((-2.55, 1.30), (2.55, 1.30), (-2.55, -2.40), (2.55, -2.40)):
        cyl(f"post{x}_{y}", 0.04, 1.95, loc=(x, y, 0.975), material=yellow, verts=24)
        cyl(f"postbase{x}_{y}", 0.09, 0.03, loc=(x, y, 0.015), material=iron, verts=24)
    for z in (0.50, 1.10, 1.85):
        cube(f"rail_back{z}", (5.15, 0.025, 0.025), loc=(0, 1.30, z), material=yellow, bev=0.003)
        cube(f"rail_left{z}", (0.025, 3.70, 0.025), loc=(-2.55, -0.55, z), material=yellow, bev=0.003)
        cube(f"rail_right{z}", (0.025, 3.70, 0.025), loc=(2.55, -0.55, z), material=yellow, bev=0.003)
    nv, nh = 20, 5
    for i in range(nv):
        x = -2.5 + i * (5.0 / (nv - 1))
        cube(f"mvb{i}", (0.006, 0.006, 1.35), loc=(x, 1.30, 1.18), material=mesh_m, bev=0.0)
    for j in range(nh):
        z = 0.55 + j * 0.26
        cube(f"mhb{z}", (5.0, 0.006, 0.006), loc=(0, 1.30, z), material=mesh_m, bev=0.0)
    for i in range(14):
        y = -2.35 + i * (3.65 / 13)
        for x in (-2.55, 2.55):
            cube(f"mvs{i}_{x}", (0.006, 0.006, 1.35), loc=(x, y, 1.18), material=mesh_m, bev=0.0)
        if i % 2 == 0:
            for x in (-2.55, 2.55):
                cube(f"mhs{i}_{x}", (0.006, 0.28, 0.006), loc=(x, y, 1.18), material=mesh_m, bev=0.0)

    # ── 控制柜
    cube("cabinet", (0.60, 0.48, 1.50), loc=(-2.05, 0.95, 0.75), material=body_w, bev=0.012)
    cube("cabinet_screen", (0.34, 0.02, 0.25), loc=(-2.05, 0.705, 1.26),
         material=screen_blue, bev=0.003)
    text_obj("cab_text", "CELL 07", (-2.05, 0.702, 0.98), rot=(math.radians(90), 0, 0),
             size=0.07, material=ink_d, font=fnt)

    # ── 背景堆料：托盘 + 纸箱
    cube("pallet1", (1.20, 0.90, 0.14), loc=(1.30, 1.85, 0.07), material=wood, bev=0.004)
    for i in range(3):
        cube(f"box{i}", (0.48, 0.44, 0.42), loc=(0.85 + i * 0.52, 1.85, 0.35),
             rot=(0, 0, math.radians(3 * i)), material=card, bev=0.006)
    cube("pallet2", (1.20, 0.90, 0.14), loc=(-1.45, 2.00, 0.07), material=wood, bev=0.004)
    for i in range(2):
        cube(f"box2{i}", (0.52, 0.46, 0.40), loc=(-1.70 + i * 0.56, 2.00, 0.34),
             material=card, bev=0.006)

    # ── 背景墙 + 顶部灯带
    wall = mat("wall", (0.105, 0.110, 0.120), rough=0.74, noise_rough=0.10, noise_scale=8.0)
    cube("back_wall", (34, 0.4, 11), loc=(0, 8.2, 5.5), material=wall, bev=0.0)
    cube("side_wall", (0.4, 26, 11), loc=(-11.0, 0, 5.5), material=wall, bev=0.0)
    for i in range(3):
        cube(f"ceil{i}", (1.90, 0.26, 0.07), loc=(-2.4 + i * 2.4, 1.2, 3.75),
             material=ceiling_lamp, bev=0.0)
        cube(f"ceil_arm{i}", (0.05, 0.05, 0.75), loc=(-2.4 + i * 2.4, 1.2, 4.15),
             material=body_d, bev=0.0)
    win_m = mat("wall_win", (0.2, 0.32, 0.45), rough=0.4, emission=(0.30, 0.45, 0.62),
                emission_strength=0.8)
    for i in range(4):
        cube(f"win{i}", (0.95, 0.06, 0.52), loc=(-4.8 + i * 3.2, 7.98, 2.55),
             material=win_m, bev=0.0)
    # 围栏后的仓储货架，把画面上半部填起来
    for r, (rx, ry) in enumerate(((-2.75, 4.75), (2.55, 4.85))):
        for (px, py) in ((-0.85, -0.32), (0.85, -0.32), (-0.85, 0.32), (0.85, 0.32)):
            cube(f"rack{r}_post{px}_{py}", (0.07, 0.07, 2.30),
                 loc=(rx + px, ry + py, 1.15), material=body_d, bev=0.004)
        for lvl in range(2):
            zz = 0.40 + lvl * 1.05
            cube(f"rack{r}_shelf{lvl}", (1.86, 0.78, 0.05), loc=(rx, ry, zz),
                 material=body_d, bev=0.004)
            for b in range(3):
                if (r + lvl + b) % 3 == 0:
                    continue
                bx = rx - 0.62 + b * 0.62
                cube(f"rack{r}_box{lvl}_{b}", (0.52, 0.56, 0.44), loc=(bx, ry, zz + 0.25),
                     rot=(0, 0, math.radians(4 * ((b % 3) - 1))), material=card, bev=0.008)

    # ── 地面 + 区域标线
    cube("cell_floor", (5.2, 4.3, 0.003), loc=(0, -0.72, 0.002), material=cell_floor, bev=0.0)
    floor_plane(material=floor_m)
    cube("line_a", (6.0, 0.06, 0.004), loc=(0, -2.95, 0.005), material=orange, bev=0.0)
    cube("line_b", (6.0, 0.06, 0.004), loc=(0, 1.60, 0.005), material=orange, bev=0.0)
    cube("line_c", (0.06, 4.55, 0.004), loc=(-2.72, -0.67, 0.005), material=orange, bev=0.0)
    cube("line_d", (0.06, 4.55, 0.004), loc=(2.72, -0.67, 0.005), material=orange, bev=0.0)

    # ── 灯光
    area_light("shop_top_a", (-1.6, -1.4, 5.0), (0, -0.6, 1.0), size=4.0, size_y=3.0,
               power=1100, color=(0.97, 0.98, 1.0))
    area_light("shop_top_b", (2.4, 1.6, 4.6), (0.5, 0, 1.0), size=3.0, size_y=2.4,
               power=600, color=(1.0, 0.95, 0.88))
    area_light("key_front", (2.0, -3.6, 2.4), (0, -0.8, 1.1), size=2.4, size_y=1.6,
               power=320, color=(1.0, 0.95, 0.9))
    area_light("rim_back", (-2.8, 2.8, 2.6), (0, 0.4, 1.2), size=2.0, size_y=1.6,
               power=420, color=(0.80, 0.88, 1.0))
    point_light("arc_glow", (0.10, -1.45, 0.93), power=13, color=(0.55, 0.78, 1.0), radius=0.04)
    point_light("arc_warm", (0.09, -1.46, 0.90), power=4, color=(1.0, 0.75, 0.40), radius=0.03)
    look_at_camera((2.55, -5.50, 2.55), (0.05, -1.00, 0.95), lens=46)


EXPOSURE = {"product": -0.15, "cnc": -0.45, "robot": -0.35}
SCENES = {"product": build_product, "cnc": build_cnc, "robot": build_robot}


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", default="all", choices=list(SCENES) + ["all"])
    ap.add_argument("--out", default=None)
    ap.add_argument("--outdir", default="review/render")
    ap.add_argument("--width", type=int, default=1600)
    ap.add_argument("--height", type=int, default=1000)
    ap.add_argument("--samples", type=int, default=256)
    ap.add_argument("--preview", action="store_true", help="800x500 / 96 采样快出图")
    args = ap.parse_args(argv)

    if args.preview:
        args.width, args.height, args.samples = 800, 500, 96

    names = list(SCENES) if args.scene == "all" else [args.scene]
    for name in names:
        print(f"=== build {name} ===", flush=True)
        reset_scene()
        SCENES[name]()
        out = args.out if (args.out and len(names) == 1) else os.path.join(args.outdir, f"{name}.png")
        render(out, args.width, args.height, args.samples, exposure=EXPOSURE.get(name, 0.0))


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    main(argv)
