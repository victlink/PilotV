import { chromium } from '/vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official/ui/node_modules/playwright-core/index.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:5186';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !/Loading\.\.\./.test(document.body.innerText), null, { timeout: 90000 });
await page.waitForTimeout(1500);

const info = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('button, [role="treeitem"], [role="button"]').forEach(el => {
    const text = (el.innerText || '').trim().slice(0, 30);
    const label = el.getAttribute('aria-label') || '';
    const title = el.getAttribute('title') || '';
    if (!text && !label && !title) return;
    if (!/PilotV|PilotCode|Mingxin|公司|app|General conversation|会话|conversation/i.test(text + label + title)) return;
    out.push({
      tag: el.tagName, role: el.getAttribute('role'), text,
      label: label.slice(0, 60), title: title.slice(0, 60),
      cls: (el.className || '').toString().slice(0, 70),
      depth: (() => { let d = 0, p = el; while ((p = p.parentElement)) d += 1; return d; })(),
    });
  });
  return out.slice(0, 30);
});
console.log(JSON.stringify(info, null, 2));
await browser.close();