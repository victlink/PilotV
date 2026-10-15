import { chromium } from '/vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official/ui/node_modules/playwright-core/index.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:5186';
const SESSION_NAME = process.env.SESSION_NAME || '设计 PilotV logo';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const VIEW = (process.env.VIEW || 'desktop').toLowerCase();
const viewports = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };
const page = await browser.newPage({ viewport: viewports[VIEW] || viewports.desktop, hasTouch: VIEW === 'phone', isMobile: VIEW === 'phone' });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', e => errors.push('PAGEERROR ' + String(e).slice(0, 200)));

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !/Loading\.\.\./.test(document.body.innerText), null, { timeout: 90000 });
await page.waitForTimeout(1200);
await page.locator('button.project-expand-button').filter({ hasText: /^PilotV$/ }).first().click();
await page.waitForTimeout(1000);
// 有成果的会话可能被 "Show more" 折起来，先展开再找。
const more = page.getByText(/Show more \(\d+\)/).first();
if (await more.count()) { await more.click(); await page.waitForTimeout(1200); }
const visible = await page.locator('button.project-conversation').allInnerTexts();
console.error('visible conversations:', JSON.stringify(visible.map(t=>t.trim().slice(0,20))));
await page.locator('button.project-conversation').filter({ hasText: SESSION_NAME }).first().click();
await page.waitForTimeout(2000);
await page.locator('button').filter({ hasText: /^成果$/ }).first().click();
await page.waitForTimeout(4000);

const total = await page.evaluate(() => document.querySelector('select[aria-label="选择成果"]')?.options.length || 0);
const rows = [];

for (let i = 0; i < total; i += 1) {
  await page.evaluate(idx => {
    const sel = document.querySelector('select[aria-label="选择成果"]');
    if (sel) { sel.selectedIndex = idx; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  }, i);
  await page.waitForTimeout(1200);

  const row = await page.evaluate(() => {
    const box = el => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    const frame = document.querySelector('[data-testid="artifact-frame"]');
    const sel = document.querySelector('select[aria-label="选择成果"]');
    const img = frame?.querySelector('img:not([src^="data:"])');
    const iframe = frame?.querySelector('iframe');
    const video = frame?.querySelector('video');
    const model = frame?.querySelector('model-viewer');
    const notice = frame ? Array.from(frame.querySelectorAll('p')).map(p => p.innerText).filter(t => /无法|失败|不能|错误/.test(t)) : [];
    return {
      label: sel?.selectedOptions?.[0]?.textContent?.trim().slice(0, 40) || '',
      frame: frame ? box(frame) : null,
      kind: img ? 'img' : iframe ? 'iframe' : video ? 'video' : model ? 'model3d' : 'none',
      src: (img?.currentSrc || iframe?.src || video?.currentSrc || model?.getAttribute('src') || '').slice(0, 90),
      box: img ? box(img) : iframe ? box(iframe) : video ? box(video) : model ? box(model) : null,
      nat: img ? [img.naturalWidth, img.naturalHeight] : null,
      imgOk: img ? img.complete && img.naturalWidth > 0 : null,
      notice: notice[0]?.slice(0, 50) || '',
      iframeVisible: iframe ? (() => { try { return !!iframe.contentDocument?.body?.children.length; } catch { return 'cross-origin'; } })() : null,
    };
  });
  rows.push(row);
}

const bad = rows.filter(r => r.kind === 'none'
  || (r.kind === 'img' && r.imgOk === false)
  || (r.box && (r.box[0] === 0 || r.box[1] === 0))
  || r.notice);

const clipped = rows.filter(r => r.frame && r.box && (r.box[1] > r.frame[1] + 2 || r.box[0] > r.frame[0] + 2)).slice(0, 8);
console.log(JSON.stringify({ view: VIEW, total, badCount: bad.length, bad, clipped, sample: rows.slice(0, 3), errors: errors.slice(0, 5) }, null, 2));
await browser.close();