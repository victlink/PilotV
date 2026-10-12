import { createRequire } from 'node:module';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true, executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome', args: ['--no-sandbox'] });
const out = { errors: [], buttons: {}, downloads: [], status: {} };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', e => out.errors.push(e.message));
  await page.goto('http://127.0.0.1:5186/', { waitUntil: 'networkidle', timeout: 60000 });
  // 项目行是 button，左上角 Logo 是 span；改名后两者文本都是 PilotV，必须按角色区分。
  await page.getByRole('button', { name: 'PilotV', exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.getByText('新建 PilotDeck 移动端 PWA 项目', { exact: false }).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '成果', exact: true }).click();
  await page.waitForTimeout(6000);

  const select = page.locator('#artifacts-header-controls select');
  const options = await select.locator('option').allInnerTexts();
  const idx = options.findIndex(t => t.includes('文本清单'));
  await select.selectOption({ index: idx });
  await page.waitForTimeout(6000);

  const frame = page.frameLocator('iframe[title="成果台"]');
  const artifactStatus = async id => {
    const res = await page.evaluate(async aid => {
      const r = await fetch(`/api/artifacts/${aid}`);
      if (!r.ok) return `http-${r.status}`;
      const a = await r.json();
      return `${a.artifact ? a.artifact.status : a.status}`;
    }, id);
    return res;
  };
  const docText = () => page.evaluate(() => {
    const doc = document.querySelector('iframe[title="成果台"]').contentDocument;
    return doc.querySelector('#stageVer')?.textContent || '';
  });

  out.buttons.visible = await frame.locator('.art-toolbar button:visible').allInnerTexts();
  out.buttons.hidden = await frame.locator('.art-toolbar button[hidden]').count();

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    frame.locator('#btnDownload').click(),
  ]);
  out.downloads.push(download ? download.suggestedFilename() : 'no-download-event');

  await frame.locator('#btnReject').click();
  await page.waitForTimeout(3000);
  await page.waitForTimeout(2500);
  out.status.afterReject = { api: await artifactStatus('art_9ea64a'), badge: await docText() };
  await frame.locator('#btnApprove').click();
  await page.waitForTimeout(2500);
  out.status.afterApprove = { api: await artifactStatus('art_9ea64a'), badge: await docText() };

  await select.selectOption({ index: options.findIndex(t => t.includes('文本清单')) });
  await page.waitForTimeout(4000);
  out.buttons.editVisible = await frame.locator('#btnEdit').isVisible().catch(() => false);

  // Editing writes back through the console's own editor; verify it saves.
  const readText = () => page.evaluate(async () => (await (await fetch('/api/artifacts/art_9ea64a/raw')).text()));
  out.buttons.textBefore = (await readText()).slice(0, 24);
  await frame.locator('#btnEdit').click();
  await page.waitForTimeout(1500);
  const editor = frame.locator('#textArea');
  out.buttons.editorCount = await editor.count();
  if (out.buttons.editorCount) {
    const original = await editor.inputValue();
    await editor.fill(`${original}\n5. 编辑保存验收`);
    await editor.press('Control+s');
    // Saving goes through the console's own PUT; poll instead of guessing a delay.
    for (let i = 0; i < 12; i += 1) {
      await page.waitForTimeout(1000);
      const now = await readText();
      if (now.includes('编辑保存验收')) { out.buttons.saved = true; out.buttons.textAfter = now.slice(-24); break; }
      if (i === 11) { out.buttons.saved = false; out.buttons.textAfter = now.slice(-24); }
    }
  }

  // Mobile: the merged console must stay usable at phone width.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.goto('http://127.0.0.1:5186/', { waitUntil: 'networkidle', timeout: 60000 });
  const project = phone.getByText('新建 PilotDeck 移动端 PWA 项目', { exact: false }).first();
  if (!await project.isVisible().catch(() => false)) {
    await phone.locator('header button, [class*=top] button').first().click().catch(() => {});
    await phone.waitForTimeout(1200);
  }
  await phone.getByText('PilotV', { exact: true }).first().click().catch(() => {});
  await phone.waitForTimeout(1500);
  await phone.getByText('新建 PilotDeck 移动端 PWA 项目', { exact: false }).first().click({ timeout: 15000 }).catch(() => {});
  await phone.waitForTimeout(1200);
  await phone.getByRole('button', { name: '成果', exact: true }).click({ timeout: 15000 }).catch(() => {});
  await phone.waitForTimeout(7000);
  out.mobile = await phone.evaluate(() => {
    const doc = document.querySelector('iframe[title="成果台"]')?.contentDocument;
    if (!doc) return { ok: false };
    const stage = doc.querySelector('#stage')?.getBoundingClientRect();
    const anno = doc.querySelector('.art-anno')?.getBoundingClientRect();
    return {
      ok: true,
      viewport: innerWidth,
      stage: stage ? Math.round(stage.width) : null,
      anno: anno ? Math.round(anno.width) : null,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
  await phone.screenshot({ path: 'pilotdeck-mobile/review/artifacts/phone-console.png' });
  await context.close();
} catch (err) { out.failure = String(err).slice(0, 200); }
finally { await browser.close(); }
console.log(JSON.stringify(out, null, 2).slice(0, 2200));