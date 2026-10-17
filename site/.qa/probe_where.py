"""在侧栏里定位「三维成果展示与交互标注」到底挂在哪个项目下，以及为什么点不到。"""
import argparse
import re
import sys

sys.path.insert(0, "/home/marc/PilotV/site/.qa")
import shot_app_real as S
from playwright.sync_api import sync_playwright
from rec_app_video import seed_token_script as SEED

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="https://127.0.0.1:5186/")
ap.add_argument("--token-file", default="/tmp/pilotv-shot-token")
ap.add_argument("--session", default="三维成果展示与交互标注")
ap.add_argument("--headful", action="store_true")
ap.add_argument("--mint", action="store_true")
args = ap.parse_args()

if args.mint:
    import pathlib
    import subprocess
    subprocess.run(["python3", str(pathlib.Path(__file__).with_name("mint_local_token.py"))], check=True)

with sync_playwright() as p:
    br = p.chromium.launch(
        headless=not args.headful,
        args=["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"],
    )
    ctx = br.new_context(viewport={"width": 1440, "height": 810}, ignore_https_errors=True)
    page = ctx.new_page()
    token = open(args.token_file).read().strip()
    keys = sorted({"http://127.0.0.1:3001", "127.0.0.1:5186", "https://127.0.0.1:5186", "auth-token"})
    page.add_init_script(SEED(token, keys))
    page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
    backend = page.evaluate("() => (window.__PILOTV__ && window.__PILOTV__.backend) || ''")
    if backend and backend not in keys:
        page.add_init_script(SEED(token, sorted(set(keys) | {backend})))
        page.reload(wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(4000)
    try:
        page.wait_for_selector("text=Loading...", state="detached", timeout=60000)
    except Exception:
        pass
    page.wait_for_timeout(6000)
    print("首屏:", " ".join(page.locator("body").inner_text().split())[:200])

    # 把所有项目行都点开，顺便点掉 Show more
    rows = page.locator("aside, [class*=sidebar], [class*=Sidebar]")
    print("侧栏容器:", rows.count())

    names = page.evaluate(
        """() => {
            const out = [];
            document.querySelectorAll('button, [role=button], li, div[class*=project], div[class*=Project]').forEach((el) => {
                const t = (el.innerText || '').trim().split('\\n')[0];
                if (t && t.length < 24 && !out.includes(t)) out.push(t);
            });
            return out.slice(0, 60);
        }"""
    )
    print("侧栏可点文本:", names)

    clicked = []
    PROJECTS = ["PilotV", "CAD", "设备管理", "3D", "sub2api", "pilotcode", "aistudio",
                "VICTLINK-AI", "OBS", "General conversation", "PilotStudio"]
    target = page.get_by_text(args.session, exact=False).first
    for name in PROJECTS:
        row = page.get_by_text(name, exact=True).first
        try:
            if not row.is_visible(timeout=3000):
                continue
            row.click(timeout=5000)
        except Exception as e:
            print(f"项目 {name} 点不开:", str(e)[:80])
            continue
        page.wait_for_timeout(1200)
        for _ in range(6):
            more = page.get_by_role("button", name=re.compile("Show more|显示更多"))
            if more.count() == 0:
                break
            try:
                if not more.first.is_visible():
                    break
                more.first.click(timeout=5000)
                page.wait_for_timeout(900)
            except Exception:
                break
        sessions = page.evaluate(
            """() => [...document.querySelectorAll('button, li, a')]
                 .map(el => (el.innerText || '').trim().split('\\n')[0])
                 .filter(t => t && t.length < 40 && !t.startsWith('Show more'))""")
        seen, uniq = set(), []
        for s in sessions:
            if s not in seen:
                seen.add(s)
                uniq.append(s)
        print(f"项目 {name}: {uniq[:12]}")
        if target.count() and target.is_visible():
            print(f"→ 在项目 {name} 下命中目标")
            clicked.append(name)
            break

    info = page.evaluate(
        """(s) => {
            const all = [...document.querySelectorAll('*')].filter(
                (el) => el.children.length === 0 && (el.textContent || '').trim() === s);
            return all.slice(0, 5).map((el) => {
                const chain = [];
                let n = el;
                while (n && chain.length < 8) {
                    let desc = n.tagName.toLowerCase();
                    if (n.className && typeof n.className === 'string') desc += '.' + n.className.trim().split(/\\s+/).slice(0, 3).join('.');
                    if (n.dataset && Object.keys(n.dataset).length) desc += '{' + Object.keys(n.dataset).join(',') + '}';
                    if (n.getAttribute) {
                        const al = n.getAttribute('aria-label');
                        if (al) desc += ' aria=' + al;
                    }
                    const cs = getComputedStyle(n);
                    chain.push(desc + ' [' + cs.display + '/' + cs.visibility + '/' + n.getBoundingClientRect().height + ']');
                    n = n.parentElement;
                }
                return chain;
            });
        }""",
        args.session,
    )
    print("目标命中:", info)
    page.screenshot(path="/tmp/probe-where.png", full_page=False)
    br.close()
