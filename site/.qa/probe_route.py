"""探路2：走会话路由进去后，看目标会话在 DOM 里挂在哪、为什么选不中。"""
import argparse
import pathlib
import subprocess
import sys

sys.path.insert(0, "/home/marc/PilotV/site/.qa")
from playwright.sync_api import sync_playwright
from rec_app_video import seed_token_script as SEED

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="https://127.0.0.1:5186/")
ap.add_argument("--token-file", default="/tmp/pilotv-shot-token")
ap.add_argument("--session", default="三维成果展示与交互标注")
ap.add_argument("--session-id", default="web:s_461e9e95-3e5b-44aa-b62e-9594f058e8a7")
ap.add_argument("--project", default="home-marc-PilotV")
ap.add_argument("--backend", default="http://127.0.0.1:3001")
ap.add_argument("--mint", action="store_true")
args = ap.parse_args()

if args.mint:
    subprocess.run(["python3", str(pathlib.Path(__file__).with_name("mint_local_token.py"))], check=True)

import urllib.parse

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, args=["--no-sandbox", "--use-gl=angle",
                                                 "--use-angle=swiftshader",
                                                 "--enable-unsafe-swiftshader"])
    ctx = br.new_context(viewport={"width": 1440, "height": 810}, ignore_https_errors=True)
    page = ctx.new_page()
    token = open(args.token_file).read().strip()
    keys = sorted({args.backend, "127.0.0.1:5186", "https://127.0.0.1:5186", "auth-token"})
    page.add_init_script(SEED(token, keys))
    target = (f"{args.url.rstrip('/')}/p/{args.project}/c/"
              f"{urllib.parse.quote(args.session_id, safe='')}"
              f"?d={urllib.parse.quote(args.backend, safe='')}")
    page.goto(target, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(9000)
    page.screenshot(path="/tmp/route-session.png")
    print("落地路由:", page.url)
    print("头部:", " ".join(page.locator("body").inner_text().split())[:220])

    info = page.evaluate(
        """(s) => {
            const leaves = [...document.querySelectorAll('*')].filter(
                el => el.children.length === 0 && (el.textContent || '').trim() === s);
            return leaves.slice(0, 3).map(el => {
                const chain = []; let n = el;
                while (n && chain.length < 10) {
                    let d = n.tagName.toLowerCase();
                    if (typeof n.className === 'string' && n.className.trim())
                        d += '.' + n.className.trim().split(/\\s+/).slice(0, 3).join('.');
                    if (n.dataset && Object.keys(n.dataset).length)
                        d += '{' + Object.keys(n.dataset).join(',') + '}';
                    for (const a of ['aria-expanded', 'role', 'aria-label', 'title'])
                        if (n.getAttribute && n.getAttribute(a)) d += ` ${a}=${n.getAttribute(a)}`;
                    const cs = getComputedStyle(n);
                    const r = n.getBoundingClientRect();
                    chain.push(`${d} [${cs.display}/${cs.visibility}/h${Math.round(r.height)}]`);
                    n = n.parentElement;
                }
                return chain;
            });
        }""",
        args.session,
    )
    print("目标 DOM:", info)
    print("目标 visible:", page.get_by_text(args.session, exact=False).first.is_visible())
    br.close()
