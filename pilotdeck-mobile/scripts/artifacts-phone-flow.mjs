import { createRequire } from 'node:module';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const out = { steps: [], errors: [] };
const browser = await chromium.launch({ headless: true, executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on('pageerror', e => out.errors.push(e.message));
  await page.goto('http://127.0.0.1:5186/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('button[aria-label="Show sidebar"]').click();
  await page.waitForTimeout(1500);
  out.steps.push({ afterMenuOpen: (await page.locator('body').innerText()).slice(0, 160) });
  await page.screenshot({ path: 'pilotdeck-mobile/review/artifacts/phone-1-drawer.png' });
  // Selecting a project closes the drawer on phones, so reopen it before the
  // nested project / session rows become clickable again.
  const reopen = async () => {
    const btn = page.locator('button[aria-label="Show sidebar"]');
    if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); await page.waitForTimeout(1200); }
  };
  // 项目行是 button，左上角 Logo 是 span；改名后两者文本都是 PilotV，必须按角色区分。
  await page.getByRole('button', { name: 'PilotV', exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  await reopen();
  const project = page.getByText('新建 PilotDeck 移动端 PWA 项目', { exact: false }).first();
  out.steps.push({ projectVisible: await project.isVisible().catch(() => false) });
  await project.click({ timeout: 12000 });
  await page.waitForTimeout(1500);
  await reopen();
  const session = page.getByText('PilotDeck 移动端适配前端', { exact: false }).first();
  out.steps.push({ sessionVisible: await session.isVisible().catch(() => false) });
  await session.click({ timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(2500);
  // The drawer stays open after picking a session and covers the header,
  // so close it before tapping 对话/成果.
  const closeDrawer = async () => {
    const backdrop = page.locator('button[aria-label="Close sidebar"]');
    if (await backdrop.isVisible().catch(() => false)) {
      await backdrop.click({ position: { x: 370, y: 400 }, force: true }).catch(() => {});
    } else {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(1500);
  };
  await closeDrawer();
  out.hitTest = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '成果');
    const r = btn.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { topTag: top?.tagName, topText: (top?.textContent || '').slice(0, 20), same: top === btn };
  });
  await page.getByRole('button', { name: '成果', exact: true }).click({ timeout: 15000 }).catch(() => {});
  out.afterPlaywrightClick = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '成果');
    return btn?.getAttribute('aria-pressed');
  });
  if (await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '成果')?.getAttribute('aria-pressed') !== 'true')) {
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '成果')?.click());
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(9000);
  out.steps.push({ afterArtifacts: (await page.locator('body').innerText()).slice(0, 160) });
  out.tabState = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '成果');
    return btn ? { pressed: btn.getAttribute('aria-pressed'), visible: btn.offsetParent !== null, rect: btn.getBoundingClientRect().toJSON() } : 'no-button';
  });
  out._paneHtml = null && await page.evaluate(() => {
    const pane = document.querySelector('#artifacts-header-controls')?.closest('div[class*="flex"]')?.parentElement
      || document.querySelector('#artifacts-header-controls')?.parentElement;
    return pane ? pane.outerHTML.slice(0, 900) : 'no-pane';
  });
  out.iframes = await page.evaluate(() => [...document.querySelectorAll('iframe')].map(f => ({ title: f.title, src: f.src.slice(0, 80), w: Math.round(f.getBoundingClientRect().width) })));
  out.console = await page.evaluate(() => {
    const el = document.querySelector('iframe[title="成果台"]');
    if (!el) return { ok: false };
    const doc = el.contentDocument;
    const stage = doc.querySelector('#stage')?.getBoundingClientRect();
    const anno = doc.querySelector('.art-anno')?.getBoundingClientRect();
    const bar = doc.querySelector('.art-toolbar')?.getBoundingClientRect();
    return {
      ok: true,
      iframe: { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) },
      stage: stage ? { w: Math.round(stage.width), h: Math.round(stage.height) } : null,
      anno: anno ? Math.round(anno.width) : null,
      toolbar: bar ? { w: Math.round(bar.width), overflow: bar.scrollWidth > bar.clientWidth } : null,
      pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      options: [...document.querySelectorAll('#artifacts-header-controls option')].length,
    };
  });
  await page.screenshot({ path: 'pilotdeck-mobile/review/artifacts/phone-2-console.png' });
} catch (err) { out.failure = String(err).slice(0, 180); }
finally { await browser.close(); }
console.log(JSON.stringify(out, null, 2).slice(0, 2000));
