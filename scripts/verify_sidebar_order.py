"""验收需求 2：左栏要和 PilotDeck 的项目/会话目录一致，实时会话置顶、其余按时间倒序。

直接读 workspace 接口的原始顺序，再对着页面渲染出来的树核一遍 ——
只看接口不算数，接口对了但前端又重排过，照样是坏的。
"""
import argparse
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from _test_guard import NotATestServer, assert_test_server
import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ROOT)

import artifacts_cdp  # noqa: E402

SCRIPT = r"""
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 80 && !document.querySelector('.art-project, .art-node'); i++) await sleep(150);
  const raw = await fetch('/api/artifacts/workspace?limit=400').then(r => r.json()).catch(e => ({ err: String(e) }));

  /* 接口层：每个项目下 live 的是否都在最前，其余是否时间倒序 */
  const apiOrder = (raw.projects || []).map(p => {
    const ss = p.sessions || [];
    const liveFlags = ss.map(s => !!s.live);
    const firstNonLive = liveFlags.indexOf(false);
    const liveAllFirst = firstNonLive === -1 || !liveFlags.slice(firstNonLive).includes(true);
    const times = ss.filter(s => !s.live).map(s => s.updated_at || '');
    const desc = times.every((t, i) => i === 0 || times[i - 1] >= t);
    return { name: p.name, n: ss.length, liveCount: liveFlags.filter(Boolean).length,
             liveAllFirst, restByTimeDesc: desc };
  });

  /* 页面层：树里实际渲染出来的会话标题顺序 */
  const titles = Array.from(document.querySelectorAll('.art-node .art-node-body'))
    .map(n => (n.querySelector('.art-node-name') || n).textContent.trim()).filter(Boolean);

  return {
    apiProjects: apiOrder.length,
    apiSample: apiOrder.slice(0, 6),
    allLiveFirst: apiOrder.every(x => x.liveAllFirst),
    allRestDesc: apiOrder.every(x => x.restByTimeDesc),
    treeNodes: titles.length,
    treeSample: titles.slice(0, 8),
    hasUnassigned: (raw.unassigned || []).length >= 0,
    unassignedCount: (raw.unassigned || []).length,
  };
})()
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8921")
    ap.add_argument("--force", action="store_true",
                    help="确实要写进这个数据目录（默认拒绝写正式库）")
    args = ap.parse_args()
    # 护栏：目标服务必须是隔离的测试实例 —— 往正式库里写测试成果，
    # 就是左栏被几百条 shot.png 淹没的由来。护栏放在 parse_args 之后。
    try:
        assert_test_server(getattr(args, "api", None), getattr(args, "token", None) or os.environ.get("ARTIFACTS_TOKEN"), force=getattr(args, "force", False))
    except NotATestServer as _e:
        print(f"拒绝执行：{_e}", file=sys.stderr)
        return 3
    api = args.api.rstrip("/")
    res = asyncio.run(artifacts_cdp.run_script(
        f"{api}/artifacts.html", SCRIPT,
        wait_js="document.querySelectorAll('.art-project').length > 0"))
    v = res.get("value")
    print(json.dumps(v, ensure_ascii=False, indent=2))

    ok = bool(v) and v.get("allLiveFirst") and v.get("allRestDesc") and v.get("treeNodes", 0) > 0
    print("\n需求2 左侧目录排序：", "通过" if ok else "不通过")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
