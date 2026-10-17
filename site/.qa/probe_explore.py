"""探路：侧栏「Explore」里应该列着全部会话，从那里点进去最稳。"""
import argparse
import pathlib
import re
import subprocess
import sys

sys.path.insert(0, "/home/marc/PilotV/site/.qa")
from playwright.sync_api import sync_playwright
from rec_app_video import seed_token_script as SEED

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="https://127.0.0.1:5186/")
ap.add_argument("--token-file", default="/tmp/pilotv-shot-token")
ap.add_argument("--session", default="三维成果展示与交互标注")
ap.add_argument("--mint", action="store_true")
args = ap.parse_args()

if args.mint:
    subprocess.run(["python3", str(pathlib.Path(__file__).with_name("mint_local_token.py"))], check=True)

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, args=["--no-sandbox", "--use-gl=angle",
                                                 "--use-angle=swiftshader",
                                                 "--enable-unsafe-swiftshader"])
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
    try:
        page.wait_for_selector("text=Loading...", state="detached", timeout=60000)
    except Exception:
        pass
    page.wait_for_timeout(5000)

    exp = page.get_by_text("Explore", exact=False).first
    print("Explore 可见:", exp.is_visible())
    exp.click()
    page.wait_for_timeout(4000)
    page.screenshot(path="/tmp/explore-1.png")

    for _ in range(4):
        more = page.get_by_role("button", name=re.compile("Show more|显示更多"))
        if more.count() == 0 or not more.first.is_visible():
            break
        more.first.click()
        page.wait_for_timeout(900)

    body = " ".join(page.locator("body").inner_text().split())
    print("Explore 面板正文:", body[:900])
    tgt = page.get_by_text(args.session, exact=False)
    print("目标命中数:", tgt.count())
    for i in range(tgt.count()):
        print(f"  [{i}] visible={tgt.nth(i).is_visible()} text={tgt.nth(i).inner_text()[:40]!r}")

    if tgt.count() and any(tgt.nth(i).is_visible() for i in range(tgt.count())):
        for i in range(tgt.count()):
            if tgt.nth(i).is_visible():
                tgt.nth(i).click()
                break
        page.get_by_role("button", name="对话", exact=True).first.wait_for(timeout=60000)
        page.wait_for_timeout(4000)
        page.get_by_role("button", name="成果", exact=True).first.click(timeout=30000)
        page.wait_for_timeout(6000)
        page.screenshot(path="/tmp/explore-artifacts.png")
        opts = page.evaluate(
            """() => [...document.querySelectorAll('select')].map(s =>
                 Array.from(s.options).map(o => o.textContent || ''))""")
        print("成果下拉:", opts)
        print("model-viewer:", page.locator("model-viewer").count())
        print("落地路由:", page.url)
    br.close()
