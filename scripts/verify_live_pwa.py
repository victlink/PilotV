#!/usr/bin/env python3
"""Check secure-context, service worker and Chromium installability on live PilotV."""
import asyncio
import json
import sys
from playwright.async_api import async_playwright

async def main():
    url = sys.argv[1]
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=['--no-proxy-server'])
        page = await browser.new_page()
        await page.add_init_script("window.installEventSeen=false;window.addEventListener('beforeinstallprompt',()=>window.installEventSeen=true)")
        await page.goto(url, wait_until='domcontentloaded')
        await page.evaluate('navigator.serviceWorker.ready.then(()=>true)')
        cdp = await page.context.new_cdp_session(page)
        await cdp.send('Page.enable')
        errors = await cdp.send('Page.getInstallabilityErrors')
        state = await page.evaluate('({secure:isSecureContext,sw:!!navigator.serviceWorker.controller,installEvent:window.installEventSeen})')
        print(json.dumps({'url':url,**state,**errors},ensure_ascii=False,indent=2))
        await browser.close()
        if not state['secure'] or errors.get('installabilityErrors'):
            raise SystemExit(1)

asyncio.run(main())
