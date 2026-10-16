# PilotV 官方 logo

本目录里的文件是**生成产物**，不要手工编辑。

唯一批准源（人工设计、逐帧调过）：

```
常用资料/PilotV-Logo-3D/蓝橙循环版/pilotv-loop.svg
```

改设计 → 只改那份 SVG → 跑生成器重出全套。改动不会自动传播，
这是刻意的：批准源和产物分离，评审只看一份文件。

## 设计约定

| 项 | 值 |
|---|---|
| 主色 | 蓝 `#297cc0`（下划线）、橙 `#e55a09`（V） |
| 循环时长 | 16s，无限，`cubic-bezier(.4,0,.2,1)` |
| V 自转 | 绕自身竖直轴，3.2s 线性，72 帧余弦 scaleX |
| 序列 | 蓝线生长 → V 浮现自转 → 逐个吐出 `P i l o t` → V 吞回 → 收线 |

字形轮廓是原始设计，**不得改动**；只有出现位置与动画在变。

V 不加方框：否决过带底板的方案，`pilotv-mark.svg` 是小尺寸适配，
不是主 logo，不要把主 logo 换成带框版本。

## 生成

```bash
python3 scripts/build_brand_loop.py       # 本目录 10 个变体
python3 scripts/build_brand_component.py  # React 组件 TSX + CSS
python3 scripts/render_brand_icons.py     # PNG 图标 / PWA / favicon
```

三个脚本都是幂等的，改完源统一重跑。`--check` 只报告差异不写盘。

## 变体

| 文件 | 用途 |
|---|---|
| `pilotv-mark.svg` | 方形小标，favicon / 设置页 / 关于页 |
| `pilotv-lockup.svg` / `-light` | 锁版小尺寸静态字标 |
| `pilotv-logo-static-{dark,light}.svg` | 静态完整字标，`prefers-reduced-motion` 降级用 |
| `pilotv-logo-animated{,-light,-dark}.svg` | 独立动画字标，文档页 / 邮件 / 启动画面 |
| `pilotv-icon-animated{,-plain}.svg` | 动画方标兼容名（实为字标，保留旧文件名） |

后缀指的是**放在什么背景上**，不是字母本身什么颜色：

| 后缀 | 适用背景 | 字母 |
|---|---|---|
| 不带 / `-dark` | 深色底 | 浅色 `#FAFAFA` |
| `-light` | 浅色底 | 深色 `#0A0A0A` |

三个 animated 字标字节相同，只是文件名区分用途。

## React 组件

```tsx
import { PilotVLogo } from 'components/app-shell/PilotVLogo';

<PilotVLogo height={17} />                    {/* 动效 */}
<PilotVLogo height={44} animated={false} />   {/* 静态完整字标 */}
```

- 字母用 `currentColor`，跟随主题；V 橙、线蓝固定。
- `animated={false}` 停掉动画后各元素停在自己的基础属性上，正好是完整字标。
- 无障碍与旧组件一致：`aria-hidden` 传 true 则不播报，否则 `role="img"` +
  `aria-label="PilotV"`。组件根节点不套主题类，光色由调用方的 `color` 决定。

组件的 CSS 是母版动效的机械派生（类名加 `pv-` 前缀，坐标系对齐），
9 组关键帧逐帧与批准源一致 —— 由 `verify_brand_motion.py` 保证。

## 校验

```bash
python3 scripts/verify_brand_motion.py    # 动效逐帧 == 批准源（26 项）
python3 scripts/verify_brand_component.py # 组件 API / 无障碍 / 字形未漂移
python3 scripts/check_brand_icon_pixels.py # 图标像素正确
python3 scripts/shot_brand_component.py   # 真实组件 Chromium 定格实拍
bash    scripts/verify_brand_deploy.sh    # 两个运行中服务实际吐出的字节
```

`verify_brand_deploy.sh` 走 HTTPS 的 5186 网关；网关有自签证书，
所以用 `curl -k`。成果台 8799 的静态前缀是 `/artifacts-static/`。

## 部署

网关 `PILOTV_DIST` 指向 `ui/dist`，静态文件按请求读取，
**改完品牌只要重建前端，不用重启网关**。

成果台的品牌资源是 `pilotv-artifacts/static/brand/` 的独立副本，
需要单独同步；纯静态文件，不用重启 Python 服务。

设备整装脚本 `scripts/deploy_pilotv_device.sh` 里有 `git reset --hard`，
本地脏工作区上不要跑。

## 归档

```bash
python3 scripts/save_logo_materials.py
```

把品牌文件、组件源、生成器一并打进 `常用资料/PilotV-Logo-v3.zip`，
并校验 SVG 副本与源一致。
