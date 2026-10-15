import { chromium } from '/vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official/ui/node_modules/playwright-core/index.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:5186';
const SESSION_NAME = process.env.SESSION_NAME || '设计 PilotV logo';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = []; const failed = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 250)); });
page.on('pageerror', e => errors.push('PAGEERROR ' + String(e).slice(0, 250)));
page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 140)}`); });

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !/Loading\.\.\./.test(document.body.innerText), null, { timeout: 90000 });
await page.waitForTimeout(1200);

const project = page.locator('button.project-expand-button').filter({ hasText: /^PilotV$/ }).first();
await project.click();
await page.waitForTimeout(1200);

const rows = await page.evaluate(() => Array.from(document.querySelectorAll('button'))
  .filter(b => /conversation|logo|重启|导航|进展|设计/i.test(b.innerText || ''))
  .map(b => ({ text: (b.innerText || '').trim().slice(0, 36), cls: (b.className || '').toString().slice(0, 60) }))
  .slice(0, 25));

let sessionFound = false;
const session = page.locator('button.project-conversation').filter({ hasText: SESSION_NAME }).first();
if (await session.count()) { await session.click(); sessionFound = true; await page.waitForTimeout(2500); }

// 顶栏 tab 用 role=tab 之外的普通按钮，靠 aria-pressed 认当前页，别靠文本猜。
const tabInfo = await page.evaluate(() => Array.from(document.querySelectorAll('button'))
  .filter(b => ['对话', '文件', '成果'].includes((b.innerText || '').trim()))
  .map(b => ({ text: b.innerText.trim(), pressed: b.getAttribute('aria-pressed'), cls: (b.className || '').toString().slice(0, 50) })));
const artifactsBtn = page.locator('button').filter({ hasText: /^成果$/ }).first();
if (await artifactsBtn.count()) { await artifactsBtn.click(); await page.waitForTimeout(5000); }
const tabAfter = await page.evaluate(() => Array.from(document.querySelectorAll('button'))
  .filter(b => ['对话', '文件', '成果'].includes((b.innerText || '').trim()))
  .map(b => b.innerText.trim() + ':' + b.getAttribute('aria-pressed')));

const stage = await page.evaluate(() => {
  const box = el => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
  const frame = document.querySelector('[data-testid="artifact-frame"]');
  return {
    body: (document.body.innerText || '').slice(0, 700),
    frame: frame ? box(frame) : null,
    framePadTop: frame ? getComputedStyle(frame).paddingTop : null,
    imgs: Array.from(document.querySelectorAll('img')).filter(i => !/wordmark/.test(i.src)).map(i => ({ src: (i.currentSrc || i.src || '').slice(0, 100), box: box(i), nat: [i.naturalWidth, i.naturalHeight], ok: i.complete && i.naturalWidth > 0 })),
    iframes: Array.from(document.querySelectorAll('iframe')).map(f => ({ src: (f.src || '').slice(0, 100), box: box(f) })),
    videos: Array.from(document.querySelectorAll('video')).map(v => ({ src: (v.currentSrc || v.src || '').slice(0, 100), box: box(v) })),
    stageTransform: (() => { const el = frame?.querySelector(':scope > div'); return el ? getComputedStyle(el).transform : null; })(),
    selectOptions: Array.from(document.querySelectorAll('select option')).map(o => (o.textContent || '').trim().slice(0, 40)).slice(0, 25),
  };
});

await page.screenshot({ path: '/tmp/artifacts-selected.png' });
console.log(JSON.stringify({ sessionFound, tabInfo, tabAfter, stage, errors, failed }, null, 2));
await browser.close();