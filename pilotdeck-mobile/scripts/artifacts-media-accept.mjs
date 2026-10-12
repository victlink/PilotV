import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5186/';
await mkdir('pilotdeck-mobile/review/artifacts', { recursive: true });

const SAMPLES = [
  { name: '视频', title: '验收样本 · 12 秒测试视频', check: 'video' },
  { name: '三维', title: '验收样本 · 三维模型 GLB', check: 'model3d' },
  { name: '图纸', title: '验收样本 · 图纸 SVG', check: 'drawing' },
  { name: '页面', title: '验收样本 · HTML 页面', check: 'page' },
  { name: '文档', title: '验收样本 · 文本清单', check: 'doc' },
];

const browser = await chromium.launch({ headless: true, executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome', args: ['--no-sandbox'] });
const report = { errors: [], results: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  // 项目行是 button，左上角 Logo 是 span；改名后两者文本都是 PilotV，必须按角色区分。
  await page.getByRole('button', { name: 'PilotV', exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.getByText('新建 PilotDeck 移动端 PWA 项目', { exact: false }).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '成果', exact: true }).click();
  await page.waitForTimeout(6000);

  const select = page.locator('#artifacts-header-controls select');
  const options = await select.locator('option').allInnerTexts();
  report.optionCount = options.length;

  for (const sample of SAMPLES) {
    const label = options.findIndex(text => text.includes(sample.title));
    if (label < 0) { report.results.push({ ...sample, result: 'missing-from-dropdown' }); continue; }
    await select.selectOption({ index: label });
    await page.waitForTimeout(7000);
    const frame = page.frameLocator('iframe[title="成果台"]');
    const entry = { name: sample.name, title: sample.title };

    if (sample.check === 'video') {
      const v = frame.locator('#stage video');
      entry.hasVideo = await v.count();
      entry.transport = await frame.locator('.art-transport').count();
      await frame.locator('.art-transport [data-act="play"]').click();
      await page.waitForTimeout(1800);
      entry.afterPlay = await v.evaluate(node => ({ t: +node.currentTime.toFixed(2), paused: node.paused }));
      await frame.locator('.art-transport [data-act="play"]').click();
      await page.waitForTimeout(600);
      entry.afterPause = await v.evaluate(node => ({ t: +node.currentTime.toFixed(2), paused: node.paused }));
      // Drag the timeline: a real pointer drag across the seek range.
      const seek = frame.locator('.art-transport .art-seek');
      const box = await seek.boundingBox();
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(800);
      entry.afterSeek = await v.evaluate(node => ({ t: +node.currentTime.toFixed(2), dur: +node.duration.toFixed(2) }));
      entry.timelineMoved = entry.afterSeek.t > 6;
    }

    if (sample.check === 'model3d') {
      const mv = frame.locator('#stage model-viewer');
      entry.hasModelViewer = await mv.count();
      if (entry.hasModelViewer) {
        entry.beforeOrbit = await mv.evaluate(node => node.getCameraOrbit ? { ...node.getCameraOrbit() } : null);
        const box = await mv.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 60, { steps: 18 });
        await page.mouse.up();
        await page.waitForTimeout(700);
        entry.afterDragOrbit = await mv.evaluate(node => node.getCameraOrbit ? { ...node.getCameraOrbit() } : null);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, -400);
        await page.waitForTimeout(700);
        entry.afterZoomOrbit = await mv.evaluate(node => node.getCameraOrbit ? { ...node.getCameraOrbit() } : null);
        const rotated = entry.beforeOrbit && entry.afterDragOrbit &&
          (Math.abs(entry.afterDragOrbit.theta - entry.beforeOrbit.theta) > 0.05 || Math.abs(entry.afterDragOrbit.phi - entry.beforeOrbit.phi) > 0.05);
        const zoomed = entry.afterZoomOrbit && entry.afterDragOrbit &&
          Math.abs(entry.afterZoomOrbit.radius - entry.afterDragOrbit.radius) > 0.05;
        entry.rotated = Boolean(rotated);
        entry.zoomed = Boolean(zoomed);
      }
    }

    if (sample.check === 'drawing') {
      const img = frame.locator('#stage .art-render > img').first();
      entry.img = await frame.locator('#stage img').count();
      entry.imgLoaded = await img.evaluate(node => node.complete && node.naturalWidth > 0).catch(() => false);
      entry.transformBefore = await img.evaluate(node => node.style.transform || '');
      const stage = frame.locator('#stage .art-stage-inner');
      const box = await stage.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(400);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      entry.transformAfter = await img.evaluate(node => node.style.transform || '');
      entry.zoomed = /scale\((?!1\))/.test(entry.transformAfter);
      entry.panned = /translate\((?![0(])/.test(entry.transformAfter);
    }
    if (sample.check === 'page') {
      const thumb = frame.locator('#stage .art-render > img').first();
      entry.imgLoaded = await thumb.evaluate(node => node.complete && node.naturalWidth > 0).catch(() => false);
      entry.imgSize = await thumb.evaluate(node => `${node.naturalWidth}x${node.naturalHeight}`).catch(() => '');
      await frame.locator('#stageModes [data-mode="live"]').click().catch(() => {});
      await page.waitForTimeout(5000);
      entry.liveFrame = await frame.locator('#stage iframe').count();
      entry.liveHeading = entry.liveFrame
        ? await frame.locator('#stage iframe').first().contentFrame().locator('h1').innerText().catch(() => '')
        : '';
    }
    if (sample.check === 'doc') {
      entry.stageText = (await frame.locator('#stage').innerText()).slice(0, 80);
    }
    await page.screenshot({ path: `pilotdeck-mobile/review/artifacts/accept-${sample.name}.png` });
    report.results.push(entry);
  }
} finally { await browser.close(); }
console.log(JSON.stringify(report, null, 2).slice(0, 3000));