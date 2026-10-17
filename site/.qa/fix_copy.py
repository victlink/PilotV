#!/usr/bin/env python3
"""按用户意见改介绍页文案：去掉「研发」后缀，去掉「真实界面 / 不是效果图」式强调。"""
import pathlib

P = pathlib.Path(__file__).resolve().parent.parent / "index.html"

EDITS = [
    # 1) 微麟科技后面不单独加「研发」
    ("PilotV 是 VICTLINK 微麟科技研发的开源生产力工具。不是一个会话",
     "PilotV 是 VICTLINK 微麟科技的开源生产力工具。不是一个会话"),
    ("VICTLINK 微麟科技研发的开源生产力工具。一组项目各自独立记忆与工作区",
     "VICTLINK 微麟科技的开源生产力工具。一组项目各自独立记忆与工作区"),
    ('<span style="font-size:13px;color:var(--tx2)">微麟科技研发</span>',
     '<span style="font-size:13px;color:var(--tx2)">微麟科技</span>'),
    ('<div class="eyebrow">VICTLINK 微麟科技 · 研发</div>',
     '<div class="eyebrow">VICTLINK 微麟科技</div>'),
    ('<h2 class="sec">VICTLINK 微麟科技研发，<em>完全开源</em></h2>',
     '<h2 class="sec">VICTLINK 微麟科技，<em>完全开源</em></h2>'),
    ("PilotV 是 VICTLINK 微麟科技研发的开源生产力工具 —— 一组项目",
     "PilotV 是 VICTLINK 微麟科技的开源生产力工具 —— 一组项目"),
    ('<span class="org">VICTLINK</span> 微麟科技研发 · 开源项目',
     '<span class="org">VICTLINK</span> 微麟科技 · 开源项目'),

    # 2) 不刻意强调「真实 / 不是效果图」
    ('<a class="btn btn-p" href="#shot">看真实界面</a>',
     '<a class="btn btn-p" href="#shot">看界面</a>'),
    ('<div class="eyebrow">02 / 真实界面</div>',
     '<div class="eyebrow">02 / 工作台</div>'),
    ('<p class="lede">下面每一张都是 PilotV 自己跑出来的真实界面截图，不是设计稿。左边是它的工作台，右边是它的成果与评审。</p>',
     '<p class="lede">左边是它的工作台，右边是它的成果与评审。</p>'),
    ("下面是真实交互流程的演示动画，循环播放。",
     "下面是交互流程的演示动画，循环播放。"),
    ("<p class=\"lede\">这是 PilotV 里一件事真实会走的路。",
     "<p class=\"lede\">这是 PilotV 里一件事会走的路。"),
    ('<a class="btn btn-p" href="#shot">再看一遍真实界面</a>',
     '<a class="btn btn-p" href="#shot">再看一遍界面</a>'),
    ("　|　本页所有界面截图均为软件实际运行画面，非设计稿。", ""),
    ('          <span class="vbadge"><i></i>真实录屏</span>\n', ""),
    ('aria-label="真实录屏：Agent 用 Python 驱动 FreeCAD 建出模块机实体"',
     'aria-label="Agent 用 Python 驱动 FreeCAD 建出模块机实体"'),
    ('aria-label="真实录屏：模型体积、重心与开窗干涉的校验过程"',
     'aria-label="模型体积、重心与开窗干涉的校验过程"'),
    ('aria-label="真实录屏：带尺寸标注的交付件图纸在成果台里打开"',
     'aria-label="带尺寸标注的交付件图纸在成果台里打开"'),
    ('aria-label="真实录屏：交付报告与材料清单的生成过程"',
     'aria-label="交付报告与材料清单的生成过程"'),
]


def main() -> None:
    s = P.read_text(encoding="utf-8")
    missing = []
    for old, new in EDITS:
        if old not in s:
            missing.append(old[:50])
            continue
        s = s.replace(old, new, 1)
    if missing:
        print("没匹配上的：")
        for m in missing:
            print("  -", m)
        raise SystemExit(1)
    P.write_text(s, encoding="utf-8")
    print(f"替换 {len(EDITS)} 处，字节数 {len(s)}")


if __name__ == "__main__":
    main()
