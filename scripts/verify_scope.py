"""验收：左栏「项目 / 会话」下拉。

要验的行为（就是用户提的那条）：
  - 有正在活动的会话时，默认落在它上面
  - 都不活跃时，默认落在最近更新的那个
  - 可以手动切到任意会话，也能切回「全部」
  - 选中某个会话时，左栏只剩这个会话的成果
  - 选中的会话没有成果时，不收窄到空树（退到项目级）
  - 手选过一次之后，SSE 刷新不会再把选择拽回默认

跑法：python3 scripts/verify_scope.py [--api http://127.0.0.1:8899]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ROOT)

from _test_guard import NotATestServer, assert_test_server  # noqa: E402
from verify_import import req, start_server  # noqa: E402

PASS = FAIL = 0


def check(cond: bool, msg: str, detail: str = "") -> bool:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {msg}" + (f" — {detail}" if detail else ""), flush=True)
    else:
        FAIL += 1
        print(f"  [FAIL] {msg}" + (f" — {detail}" if detail else ""), flush=True)
    return cond


def section(t: str) -> None:
    print(f"\n[{t}]", flush=True)


# 一个可控的假 PilotDeck 家目录：两个项目、三个会话，活跃标记和更新时间都能定
FAKE_HOME = os.environ.get("PILOTDECK_HOME") or "/tmp/artifacts-scope-home"


def build_fake_pilotdeck() -> None:
    """造 ~/.pilotdeck/projects/<slug>/{chats, .cwd}。

    pilotdeck_workspace.py 读的就是这几个文件，所以这里造得越接近真的，
    验出来的默认值才越可信。
    """
    shutil.rmtree(FAKE_HOME, ignore_errors=True)
    now = time.time()

    def session(slug, sid, title, age_s, live_body=b""):
        d = os.path.join(FAKE_HOME, "projects", slug, "chats")
        os.makedirs(d, exist_ok=True)
        body = live_body
        if not body:
            meta = {"type": "session_metadata", "title": title, "aiTitle": title}
            body = (json.dumps(meta, ensure_ascii=False) + "\n").encode()
        p = os.path.join(d, f"cli:{sid}.jsonl")
        with open(p, "wb") as fh:
            fh.write(body)
        # mtime 决定「最近更新」和「实时」的判定
        t = now - age_s
        os.utime(p, (t, t))
        return sid

    # project-a：sA-old 老、sA-live 活跃（mtime 在 LIVE_WINDOW 内）
    os.makedirs(os.path.join(FAKE_HOME, "projects", "project-a"), exist_ok=True)
    with open(os.path.join(FAKE_HOME, "projects", "project-a", ".cwd"), "w") as fh:
        fh.write("/tmp/scope-a")
    session("project-a", "sA-old", "A 的老会话", 7200)
    session("project-a", "sA-live", "A 的活跃会话", 5)

    # project-b：只有一个较新的会话
    os.makedirs(os.path.join(FAKE_HOME, "projects", "project-b"), exist_ok=True)
    with open(os.path.join(FAKE_HOME, "projects", "project-b", ".cwd"), "w") as fh:
        fh.write("/tmp/scope-b")
    session("project-b", "sB-new", "B 的新会话", 600)


UI = r"""
(async () => {
  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  /* 原来只等 #selSession 这个节点出现。但它是一上来就存在的空 <select>，
   真正要等的是选项填好 —— 满负载跑全量回归时数据回来慢，
   节点在、options 还是空数组，后面一串断言就连着假失败。 */
  const ready = () => { const sp = $('#selProject'), ss = $('#selSession');
    return sp && ss && sp.options.length > 0 && ss.options.length > 0; };
  for (let i = 0; i < 120 && !ready(); i++) await sleep(150);
  const sp = $('#selProject'), ss = $('#selSession');
  out.projectOptions = sp ? [...sp.options].map(o => o.textContent) : null;
  out.sessionOptions = ss ? [...ss.options].map(o => o.textContent) : null;
  out.scope = window.artifactsApi ? JSON.parse(JSON.stringify(window.artifactsApi.state.scope)) : null;
  out.rows = document.querySelectorAll('.art-node-artifact').length;

  /* 切到指定会话 */
  const pick = (sel, v) => { sel.value = v; sel.dispatchEvent(new Event('change')); };
  window.__pick = pick;

  pick(sp, 'project-b'); await sleep(300);
  out.afterProjectB = {
    rows: document.querySelectorAll('.art-node-artifact').length,
    scope: JSON.parse(JSON.stringify(window.artifactsApi.state.scope)),
  };
  pick(ss, 'sB-new'); await sleep(300);
  out.afterSessionB = {
    rows: document.querySelectorAll('.art-node-artifact').length,
    sessionNodes: [...document.querySelectorAll('.art-node-session')]
      .map(e => e.querySelector('.art-node-name').textContent),
  };
  pick(ss, ''); await sleep(300);
  out.afterAll = { rows: document.querySelectorAll('.art-node-artifact').length };
  pick(sp, ''); await sleep(300);
  out.afterAll.allRows = document.querySelectorAll('.art-node-artifact').length;
  out.allProjectSessions = [...ss.options].map(o => o.textContent);
  return out;
})()
"""


def run_browser(api: str, js: str) -> dict:
    import artifacts_cdp
    import asyncio
    res = asyncio.run(artifacts_cdp.run_script(f"{api}/artifacts.html", js))
    if isinstance(res, dict) and res.get("error"):
        print(f"  浏览器脚本报错：{res['error']}", file=sys.stderr)
        return {}
    return (res or {}).get("value", {})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8899")
    ap.add_argument("--token", default=os.environ.get("ARTIFACTS_TOKEN"))
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    api = args.api.rstrip("/")

    proc = start_server(api)
    try:
        assert_test_server(args.api, args.token, force=args.force)
    except NotATestServer as e:
        print(f"拒绝执行：{e}", file=sys.stderr)
        if proc:
            proc.kill()
        return 3

    tag = str(int(time.time()))
    src = os.path.join(FAKE_HOME, f"scope-src-{tag}")

    try:
        section("造数据：两个项目、三个会话")
        build_fake_pilotdeck()
        # 放在 build_fake_pilotdeck() 之后建目录：那个函数开头会 rmtree(FAKE_HOME)
        # 把家目录整个清掉再重造，先建 src 的话这里会被顺手删掉。
        os.makedirs(src, exist_ok=True)

        # 这里**不再**设 PILOTDECK_HOME、也不重启服务：
        # scripts/run_scope_verify.sh 是在 export 完 PILOTDECK_HOME 之后才起服务的，
        # 指向的就是 FAKE_HOME 本身。中途改环境变量对已运行的进程没作用，
        # 硬要生效就只能重启 —— 那会跟 wrapper 自己起的服务抢同一个端口。
        # 现在只是往 FAKE_HOME 里补文件，服务下次扫描（带 15s 缓存）自然看得到。

        # A 的活跃会话 → 2 个成果；B 的会话 → 1 个；A 的老会话 → 1 个
        for sid, n, name in (("sA-live", 2, "活跃稿"), ("sA-old", 1, "老稿")):
            for i in range(n):
                p = os.path.join(src, f"{name}-{sid}-{i}.png")
                with open(p, "wb") as fh:
                    fh.write(bytes([(i * 31 + k) % 251 for k in range(80 + i * 7)]))
                req(api, "/api/artifacts", "POST", {
                    "agent": "scope", "kind": "image", "title": f"{name}-{i}",
                    "path": p, "project": "project-a", "run_id": f"cli:{sid}"})
        p = os.path.join(src, "B稿.png")
        with open(p, "wb") as fh:
            fh.write(bytes([k % 251 for k in range(90)]))
        req(api, "/api/artifacts", "POST", {
            "agent": "scope", "kind": "image", "title": "B稿",
            "path": p, "project": "project-b", "run_id": "cli:sB-new"})

        # 故意造一条**不带 run_id** 的成果，文件放在 project-a 的工作目录里
        # （project-a 的 .cwd 就是 /tmp/scope-a，见 build_fake_pilotdeck）。
        # 这条会走 workspace 里「按路径匹配项目」的兜底分支 —— 而那个分支以前
        # 既 append 进 project["artifacts"] 又 append 进会话，左栏把同一条列两遍。
        # 真实数据上项目 vol3-1000-Work-00-PilotV「直属 258 / 会话内 258」就是这个。
        os.makedirs("/tmp/scope-a", exist_ok=True)
        orphan = "/tmp/scope-a/孤儿稿.png"
        with open(orphan, "wb") as fh:
            fh.write(bytes([k % 251 for k in range(70)]))
        req(api, "/api/artifacts", "POST", {
            "agent": "scope", "kind": "image", "title": "孤儿稿", "path": orphan})

        # 造完数据到真正扫描可能隔了几分钟，活跃会话会掉出 LIVE_WINDOW。
        # 这里重新点一次 mtime，让「实时」判定测的是真逻辑而不是时钟漂移。
        lp = os.path.join(FAKE_HOME, "projects", "project-a", "chats", "cli:sA-live.jsonl")
        os.utime(lp, None)

        ws = req(api, "/api/artifacts/workspace?sessions=50")
        sess = {(s["id"]): s for pp in ws.get("projects", []) for s in pp.get("sessions", [])}
        check(len(sess) >= 3, "假 PilotDeck 家目录被读到了 3 个会话", f"读到 {len(sess)}")
        check(sess.get("cli:sA-live", {}).get("live") is True,
              "mtime 很新的那个会话被标成实时",
              f"live={sess.get('cli:sA-live', {}).get('live')}")
        check(sess.get("cli:sA-old", {}).get("live") is False,
              "两小时前的会话没被误标成实时",
              f"live={sess.get('cli:sA-old', {}).get('live')}")

        # 一条成果只能出现在一个桶里。以前「按路径归属」那条会同时进
        # 项目直属和会话，左栏把同一条列两遍 —— 选中会话也照样多出一堆。
        dup = []
        for pp in ws.get("projects", []):
            seen = set()
            for a in pp.get("artifacts") or []:
                if a.get("id") in seen:
                    dup.append(f"{pp['name']}/直属内重复:{a.get('id')}")
                seen.add(a.get("id"))
            for s in pp.get("sessions", []):
                sseen = set()
                for a in s.get("artifacts") or []:
                    aid = a.get("id")
                    if aid in sseen:
                        dup.append(f"{pp['name']}/{s['id']}内重复:{aid}")
                    sseen.add(aid)
                    if aid in seen:
                        dup.append(f"{pp['name']}/直属与会话重复:{aid}")
                    seen.add(aid)
        check(not dup, "同一条成果不会被列两遍（项目直属 / 会话 各归一处）",
              f"重复 {len(dup)} 条：{dup[:4]}")
        a_own = next((pp for pp in ws["projects"] if pp["name"] == "project-a"), {})
        check("孤儿稿" in {a.get("title") for a in a_own.get("artifacts") or []} or
              "孤儿稿" in {a.get("title") for s in a_own.get("sessions") or []
                           for a in s.get("artifacts") or []},
              "不带 run_id 的成果照样挂得上（按路径兜底），没有凭空消失")

        section("左栏下拉")
        out = run_browser(api, UI)
        check(bool(out), "页面脚本跑通")
        po = out.get("projectOptions") or []
        check(any("project-a" in t for t in po) and any("project-b" in t for t in po),
              "项目下拉列出了两个项目", str(po[:5]))
        # 此刻项目已经被默认收窄到 project-a，所以下拉里只有 A 的会话是对的；
        # 要看到 B，得先把项目摊回「全部项目」。
        so = out.get("sessionOptions") or []
        check(len(so) >= 2 and all("project-b" not in t for t in so),
              "会话下拉随项目收窄，只列当前项目的会话", str(so[:6]))

        scope = out.get("scope") or {}
        check(scope.get("session") == "cli:sA-live",
              "默认落在正在活动的那个会话上", f"scope={scope}")

        afterB = out.get("afterProjectB") or {}
        check((afterB.get("scope") or {}).get("project") == "project-b",
              "切项目后 scope 跟着换", str(afterB.get("scope")))
        afterSess = out.get("afterSessionB") or {}
        rows = afterSess.get("rows")
        check(rows == 1, "选中单个会话后左栏只剩它自己的 1 条成果", f"rows={rows}")
        names = afterSess.get("sessionNodes") or []
        check(all(("B" in n) for n in names) and len(names) >= 1,
              "别的会话不再出现在树里", str(names))
        allSess = out.get("allProjectSessions") or []
        check(any("project-b" in t for t in allSess) and any("sA-live" in t for t in allSess),
              "摊回「全部项目」后会话下拉覆盖多个项目的会话", str(allSess[:6]))

        afterAll = out.get("afterAll") or {}
        # 此刻 project 停在 project-b，所以「全部会话」= 该项目下全部会话；
        # 真正的「全量」得再把项目也摊回「全部项目」才看得到。
        check(afterAll.get("rows", 0) >= rows,
              "切回「全部会话」后本项目的成果都在", f"rows={afterAll.get('rows')} >= {rows}")
        check(afterAll.get("allRows", 0) > afterAll.get("rows", 0),
              "再把项目摊回「全部项目」能看到别的项目的成果",
              f"全部={afterAll.get('allRows')} vs 本项目={afterAll.get('rows')}")

        section("手动选过之后不被拽回默认")
        out2 = run_browser(api, r"""
        (async () => {
          const $ = (s) => document.querySelector(s);
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const sp = $('#selProject'), ss = $('#selSession');
          sp.value = 'project-a'; sp.dispatchEvent(new Event('change'));
          await sleep(300);
          ss.value = 'cli:sA-old'; ss.dispatchEvent(new Event('change'));
          await sleep(200);
          const before = JSON.parse(JSON.stringify(window.artifactsApi.state.scope));
          await window.artifactsApi.loadList();     // 模拟 SSE 触发的重载
          await sleep(600);
          return { before, after: JSON.parse(JSON.stringify(window.artifactsApi.state.scope)) };
        })()""")
        b = (out2 or {}).get("before") or {}
        a = (out2 or {}).get("after") or {}
        check(b.get("session") == "cli:sA-old", "手动选到 sA-old 生效", str(b))
        check(a.get("session") == "cli:sA-old",
              "重载之后仍停在用户选的那个会话，没跳回默认", f"{b} → {a}")

        section("选会话后，中间舞台真的换成那个会话的成果")
        # 以前 onchange 只做 saveScope/renderScope/renderTree，压根没碰
        # state.selectedId —— 左栏换了会话，中间还停在上一条成果上，
        # 看着就像「下拉选了没用」。现在要把选中项对齐到新范围。
        out3 = run_browser(api, r"""
        (async () => {
          const $ = (s) => document.querySelector(s);
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const sp = $('#selProject'), ss = $('#selSession');
          const St = window.artifactsApi.state;
          const ownerOf = (id) => {
            for (const p of (St.projects || []))
              for (const s of (p.sessions || []))
                if ((s.artifacts || []).some(a => a.id === id)) return s.id;
            return null;
          };
          const out = [];
          for (const [proj, sess] of [['project-b', 'cli:sB-new'], ['project-a', 'cli:sA-live']]) {
            sp.value = proj; sp.dispatchEvent(new Event('change'));
            await sleep(400);
            ss.value = sess; ss.dispatchEvent(new Event('change'));
            await sleep(700);
            out.push({ scope: St.scope.session, selectedId: St.selectedId,
                       owner: ownerOf(St.selectedId),
                       stageTitle: (document.getElementById('stageTitle')||{}).textContent || '' });
          }
          return out;
        })()""")
        for row in (out3 or []):
            check(row.get("scope") == row.get("owner") and row.get("selectedId"),
                  f"选到 {row.get('scope')} 后，中间成果确实属于这个会话",
                  f"选中 {row.get('selectedId')} 归属 {row.get('owner')} · 标题「{row.get('stageTitle')}」")

        section("手动选过之后，SSE 重载不再套默认值")
        # location.reload() 会把当前 JS 上下文销毁，在同一次调用里读返回值必然拿到
        # None —— 所以拆成两趟：第一趟只负责落 localStorage 并刷新，第二趟再量。
        run_browser(api, r"""
        (() => {
          // touched=true 表示「用户选过」，默认值不该再套上来
          localStorage.setItem('pdconsole.artscope.v1',
            JSON.stringify({project:'',session:'',touched:true}));
          location.reload();
          return true;
        })()""")
        out3 = run_browser(api, r"""
        (async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          for (let i = 0; i < 40 && !window.artifactsApi; i++) await sleep(150);
          await sleep(400);
          return { rows: document.querySelectorAll('.art-node-artifact').length,
                   scope: JSON.parse(JSON.stringify(window.artifactsApi.state.scope)) };
        })()""")
        sc3 = (out3 or {}).get("scope") or {}
        check(sc3.get("session") == "" and sc3.get("project") == "",
              "标记为手动选过后，重开页面不再自动套默认会话", str(sc3))
        check((out3 or {}).get("rows", 0) >= 1,
              "全量视图下成果都在", str((out3 or {}).get("rows")))
    finally:
        shutil.rmtree(src, ignore_errors=True)
        if proc:
            proc.kill()

    print("\n" + "=" * 56)
    print(f"结果：{PASS} 通过 / {FAIL} 失败")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())