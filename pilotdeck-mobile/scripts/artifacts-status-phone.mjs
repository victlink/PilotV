import { createRequire } from 'node:module';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const out = { errors: [], mobile: {} };
const browser = await chromium.launch({ headless: true, executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome', args: ['--no-sandbox'] });
try {
  // Approve after reject, and phone layout, on separate pages so one failure
  // cannot hide the other's result.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => out.errors.push(e.message));
  await page.goto('http://127.0.0.1:5186/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.getByText('PilotV', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.getByText('新建 PilotDeck 移动端 PWA 项目', { exact: false }).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '成果', exact: true }).click();
  await page.waitForTimeout(6000);
  const select = page.locator('#artifacts-header-controls select');
  const options = await select.locator('option').allInnerTexts();
  const apiStatus = () => page.evaluate(async () => {
    const r = await fetch('/api/artifacts/art_9ea64a');
    const a = await r.json();
    return (a.artifact || a).status;
  });
  await select.selectOption({ index: options.findIndex(t => t.includes('文本清单')) });
  await page.waitForTimeout(6000);
  const frame = page.frameLocator('iframe[title="成果台"]');
  // Approve is only legal from a reviewable state; drive it from ready.
  const setStatus = (status) => page.evaluate(async st => {
    await fetch('/api/artifacts/art_9ea64a/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: st }),
    });
  }, status);
  await setStatus('ready');
  await page.waitForTimeout(2500);
  out.beforeApprove = await apiStatus();
  await frame.locator('#btnApprove').click();
  await page.waitForTimeout(4000);
  out.afterApprove = await apiStatus();
  await setStatus('ready');
  await page.waitForTimeout(2500);
  await frame.locator('#btnReject').click();
  await page.waitForTimeout(4000);
  out.afterRejectAgain = await apiStatus();

  // Phone: reach the console the way a real phone user does.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  phone.on('pageerror', e => out.errors.push('phone:' + e.message));
  await phone.goto('http://127.0.0.1:5186/', { waitUntil: 'networkidle', timeout: 60000 });
  out.mobile.initialText = (await phone.locator('body').innerText()).slice(0, 120);
  const tabs = await phone.locator('button').allInnerTexts();
  out.mobile.tabs = tabs.filter(Boolean).slice(0, 14);
  const toggle = phone.locator('button[aria-label="Show sidebar"], button[aria-label*="showSidebar"], header button').first();
  await toggle.click({ timeout: 10000 }).catch(() => {});
  await phone.waitForTimeout(2000);
  await phone.getByText('新建 PilotDeck 移动端 PWA 项目', { exact: false }).first().click({ timeout: 12000 }).catch(() => {});
  await phone.waitForTimeout(1500);
  await phone.getByRole('button', { name: '成果', exact: true }).click({ timeout: 12000 }).catch(() => {});
  await phone.waitForTimeout(8000);
  out.mobile.console = await phone.evaluate(() => {
    const frameEl = document.querySelector('iframe[title="成果台"]');
    if (!frameEl) return { ok: false, reason: 'no-iframe' };
    const doc = frameEl.contentDocument;
    const stage = doc.querySelector('#stage')?.getBoundingClientRect();
    const anno = doc.querySelector('.art-anno')?.getBoundingClientRect();
    const toolbar = doc.querySelector('.art-toolbar')?.getBoundingClientRect();
    return {
      ok: true,
      stage: stage ? { w: Math.round(stage.width), h: Math.round(stage.height) } : null,
      annoWidth: anno ? Math.round(anno.width) : null,
      toolbarVisible: toolbar ? toolbar.width > 0 : null,
      pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
  await phone.screenshot({ path: 'pilotdeck-mobile/review/artifacts/phone-console.png' });
} catch (err) { out.failure = String(err).slice(0, 200); }
finally { await browser.close(); }
console.log(JSON.stringify(out, null, 2).slice(0, 2000));