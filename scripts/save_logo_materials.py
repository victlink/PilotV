"""Archive the approved PilotV logo for website and promotional use.

品牌定稿是「蓝橙循环版」：16 秒循环，蓝色点延展成线，V 与 Pilot 依次浮现，
V 绕自身竖轴旋转并吞入后续字母后收回成点。

唯一事实来源是批准版动效 SVG：
    常用资料/PilotV-Logo-3D/蓝橙循环版/pilotv-loop.svg

本脚本把派生成品连同这个主源一起归档，使归档自洽 —— 即使日后 brand/ 里的
派生文件丢了，也能从 源文件/ 重新生成。

用法：
    python3 scripts/save_logo_materials.py
"""
from pathlib import Path
import shutil
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
out = root / '常用资料' / 'PilotV Logo'
out.mkdir(parents=True, exist_ok=True)

# 归档的成品 SVG。只放正式命名，不放 pilotv-*-animated.svg / pilotv-icon-animated*.svg
# 这类为兼容旧脚本保留的别名 —— 它们内容与正式文件重复。
files = [
    'pilotv-logo-animated-dark.svg',
    'pilotv-logo-animated-light.svg',
    'pilotv-logo-static-dark.svg',
    'pilotv-logo-static-light.svg',
    'pilotv-mark.svg',
    'pilotv-lockup.svg',
    'pilotv-lockup-light.svg',
]

# 批准版主源：归档自洽的关键。
master = root / '常用资料' / 'PilotV-Logo-3D' / '蓝橙循环版' / 'pilotv-loop.svg'
assert master.exists(), f'批准版主源缺失：{master}'

records = []
for name in files:
    source = root / 'brand' / name
    assert source.exists(), f'缺少品牌文件：{source}'
    target = out / name
    shutil.copy2(source, target)
    assert target.read_bytes() == source.read_bytes()
    records.append({
        'file': name,
        'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
    })

source_dir = out / '源文件'
source_dir.mkdir(exist_ok=True)
# 主源 + 两个生成器：拿到这三样就能重建全部成品。
for path in [
    master,
    root / 'scripts' / 'build_brand_loop.py',
    root / 'scripts' / 'build_brand_component.py',
]:
    shutil.copy2(path, source_dir / path.name)

(out / '使用说明.txt').write_text('''PilotV Logo 常用品牌资料
归档日期：2026-10-17
确认版本：蓝橙循环版（v3）

动画：蓝色点延展成横线，V 与 Pilot 依次浮现；V 绕自身竖轴持续旋转，并依次
吞入 t/o/l/i/P，随后收回横线、缩回蓝点，无缝接回起点。周期 16 秒。

品牌色
- 橙（V）：#e55a09
- 蓝（底线）：#297cc0
- 深色背景用字色：#FAFAFA；浅色背景用字色：#0A0A0A

网站使用
- 深色背景：pilotv-logo-animated-dark.svg
- 浅色背景：pilotv-logo-animated-light.svg
- 静态字标（reduced-motion、静态页、印刷、OG 图）：
  pilotv-logo-static-dark.svg / pilotv-logo-static-light.svg
- 图标：pilotv-mark.svg（方形橙 V + 蓝线，自带深色圆角底，浅深背景通用）
- 锁定组合（成果台、归档说明）：pilotv-lockup.svg / pilotv-lockup-light.svg
- 推荐通过 img 引用动画 SVG，避免内联多份 SVG 的全局 CSS 冲突。
- SVG 为路径轮廓，展示无需安装字体。尊重系统“减少动态效果”，开启时动画会
  静止在完整字标上。

React 组件
- 组件：pilotdeck-mobile/upstream-official/ui/src/components/app-shell/PilotVLogo.tsx
  与同名 .css。属性 height / animated / className / style / aria-hidden 不变。
- 字母颜色走 currentColor，V 为橙、底线为蓝，主题切换无需改代码。
- animated={false} 即静态完整字标。

宣传片使用
- 已渲染视频：常用资料/PilotV-Logo-3D/蓝橙循环版/PilotV-Loop-3D-1080p.mp4
  （1920x1080，24fps，384 帧，16 秒；播放器需设为循环播放）。
- Blender 源：同目录 PilotV-Loop-3D.blend。
- 本归档本身提供矢量动画源素材，不是视频。常见剪辑软件未必执行 SVG 内的
  CSS 动画，不能直接导入后假设会动。

源文件与重建
源文件/ 内含：pilotv-loop.svg（批准版主源，唯一事实来源）、
build_brand_loop.py（生成全部成品 SVG 与 public 镜像）、
build_brand_component.py（生成 React 组件与 CSS）。

在仓库根目录重建：
    python3 scripts/build_brand_loop.py        # 成品 SVG
    python3 scripts/build_brand_component.py   # React 组件与样式
    python3 scripts/render_brand_icons.py      # favicon / PWA 图标 PNG

两个生成器都支持 --check，只报告差异不写文件。

本目录为当前确认版快照；以后品牌更新应重新归档，不自动跟随开发中的改动。
''', encoding='utf-8')

(out / 'manifest.json').write_text(json.dumps({
    'version': 3,
    'artifact_id': 'brand_loop_16s',
    'cycle_seconds': 16,
    'master': str(master.relative_to(root)),
    'colors': {'orange': '#e55a09', 'blue': '#297cc0'},
    'files': records,
}, ensure_ascii=False, indent=2), encoding='utf-8')

archive = out.parent / 'PilotV-Logo-v3.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
    for p in sorted(out.rglob('*')):
        if p.is_file():
            z.write(p, p.relative_to(out.parent))
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    print('Archived', len(z.namelist()), 'files:', archive.relative_to(root))
print(f'Verified {len(files)} SVG copies against brand originals.')
