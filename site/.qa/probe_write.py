#!/usr/bin/env python3
"""谁在改 pilotdeck-tokens？给 setItem 打桩，记录每次写入的调用栈。"""
from __future__ import annotations

import json
import pathlib

from playwright.sync_api import sync_playwright

TOKEN = pathlib.Path("/tmp/pilotv-shot-token").read_text().strip()
SEED = {"token": TOKEN, "keys": ["auth-token", "http://127.0.0.1:3001",
                                "https://127.0.0.1:5186"]}

with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True, args=["--no-sandbox"])
    ctx = b.new_context(ignore_https_errors=True)
    page = ctx.new_page()
    page.add_init_script(
        "seed => { try { const o={}; for (const k of seed.keys) o[k]=seed.token;"
        " localStorage.setItem('pilotdeck-tokens', JSON.stringify(o)); } catch(e){} }")
    page.add_init_script(
        "() => { window.__writes = [];"
        " const orig = Storage.prototype.setItem;"
        " Storage.prototype.setItem = function(k, v) {"
        "   if (k === 'pilotdeck-tokens') {"
        "     try { window.__writes.push({ v: String(v).slice(0, 60),"
        "       stack: new Error().stack.split('\\n').slice(2, 5).join(' | ')"
        "         .slice(0, 320) }); } catch (e) {} }"
        "   return orig.call(this, k, v); };"
        " const origR = Storage.prototype.removeItem;"
        " Storage.prototype.removeItem = function(k) {"
        "   if (String(k).indexOf('token') >= 0) {"
        "     try { window.__writes.push({ v: 'REMOVE ' + k,"
        "       stack: new Error().stack.split('\\n').slice(2, 5).join(' | ').slice(0, 320) }); }"
        "     catch (e) {} }"
        "   return origR.call(this, k); };"
        " const origC = Storage.prototype.clear;"
        " Storage.prototype.clear = function() {"
        "   try { window.__writes.push({ v: 'CLEAR ALL',"
        "     stack: new Error().stack.split('\\n').slice(2, 5).join(' | ').slice(0, 320) }); }"
        "   catch (e) {} return origC.call(this); }; }")
    page.goto("https://127.0.0.1:5186/", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(7000)
    for w in page.evaluate("() => window.__writes || []"):
        print("-", w["v"][:70])
        print("   ", w["stack"][:300])
    print("final keys:", page.evaluate(
        "() => Object.keys(JSON.parse(localStorage.getItem('pilotdeck-tokens')||'{}'))"))
    b.close()
