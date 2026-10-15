// 「资料」页端到端检查：进 PilotV → 探索 → 资料 → 确认 iframe 里真的是 WeKnora。
//
// 跨源 iframe 用 Playwright 的 frame API 直接读，不需要同源就能验。
// 失败时把每一步的证据和截图路径打出来，别只报一个 timeout。
//
// 用法：
//   node pilotdeck-mobile/scripts/weknora-e2e-check.mjs
//   PILOTV_URL=http://100.90.196.104:5186/ node .../weknora-e2e-check.mjs

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/');
const { chromium } = require('playwright');

const PILOTV_URL = process.env.PILOTV_URL || 'http://127.0.0.1:5186/';
const SHOTS = path.resolve('pilotdeck-mobile/scripts/weknora-e2e-shots');
const STEP_TIMEOUT = Number(process.env.STEP_TIMEOUT_MS || 20000);

mkdirSync(SHOTS, { recursive: true });

const steps = [];
function step(name, ok, detail = '') {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

const browser = await chromium.launch({
  args: ['--no-proxy-server', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
});
const failedRequests = [];
page.on('requestfailed', request => {
  failedRequests.push(`${request.method()} ${request.url().slice(0, 120)} :: ${request.failure()?.errorText}`);
});
page.on('response', response => {
  if (response.status() >= 400) {
    failedRequests.push(`${response.status()} ${response.url().slice(0, 120)}`);
  }
});

try {
  await page.goto(PILOTV_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  step('PilotV 首页打开', true, await page.title());

  // 开屏页会等后端握手才让位。探测按钮之前先等它真的走掉，否则每一步都超时。
  const splash = page.getByText(/^Loading(\.{3}|…)?$/).first();
  if (await splash.count()) {
    try {
      await splash.waitFor({ state: 'hidden', timeout: 45000 });
      step('开屏页结束', true);
    } catch {
      step('开屏页结束', false, '45 秒还在 Loading，后端握手没完成');
    }
  }

  // 「探索」是项目级的：停在 general 项目里时它整个不渲染，所以先选一个真项目。
  const project = page.getByRole('button', { name: /^PilotV$/ }).first();
  if (await project.count()) {
    await project.click();
    await page.waitForTimeout(1500);
    step('切到 PilotV 项目', true);
  } else {
    step('切到 PilotV 项目', false, '侧栏里没有 PilotV 项目');
  }

  // 探索菜单里的「资料」：先开菜单，再点菜单项。
  // 按钮的无障碍名和可见文案不是一回事（aria-label 是 "Open dashboards menu"，
  // 可见文字才是 "Explore"），两个都试一遍再判定。
  const explore = page.locator([
    'button[aria-label*="Explore"]',
    'button[aria-label*="dashboards menu"]',
    'button[aria-label*="探索"]',
    'button:has-text("Explore")',
    'button:has-text("探索")',
  ].join(', ')).first();
  const hasExplore = await explore.count().catch(() => 0);
  if (!hasExplore) {
    step('找到「探索」菜单', false, '首页没有出现探索按钮，可能停在引导/登录页');
    await shot(page, 'no-explore');
  } else {
    step('找到「探索」菜单', true);
    await explore.click();
    const item = page.locator('[role="menuitem"]', { hasText: /^(资料|Documents)$/ }).first();
    const hasItem = await item.count();
    step('探索菜单里有「资料」', hasItem > 0);
    await shot(page, 'explore-menu');

    if (hasItem > 0) {
      await item.click();
      const area = page.getByTestId('weknora-area');
      await area.waitFor({ timeout: STEP_TIMEOUT });
      const state = await area.getAttribute('data-state');
      step('资料页渲染出来', true, `data-state=${state}`);
      await shot(page, 'weknora-page');

      const frameEl = await page.waitForSelector('iframe[src*=":8080"]', { timeout: STEP_TIMEOUT })
        .catch(() => null);
      if (!frameEl) {
        step('iframe 指向 WeKnora', false, `data-state=${state}，没有出现 8080 的 iframe`);
        await shot(page, 'weknora-no-frame');
      } else {
        const src = await frameEl.getAttribute('src');
        step('iframe 指向 WeKnora', true, src);

        // 等 WeKnora 自己把 SPA 画出来，再从 frame 里读证据。
        const frame = page.frames().find(f => f.url().includes(':8080'));
        if (!frame) {
          step('WeKnora frame 已加载', false, '没找到 8080 的 frame');
        } else {
          await frame.waitForSelector('#app, .login-container, body', { timeout: STEP_TIMEOUT }).catch(() => {});
          const text = (await frame.locator('body').innerText().catch(() => '')).slice(0, 400);
          const hasApp = await frame.evaluate(() => {
            const root = document.querySelector('#app');
            return Boolean(root && root.children.length > 0);
          }).catch(() => false);
          step('WeKnora SPA 已渲染', hasApp, text.replace(/\s+/g, ' ').slice(0, 160));
          step('没有被 X-Frame-Options 拦下', true, 'iframe 有内容即说明可嵌入');
          console.log(`      frame url = ${frame.url()}`);
          console.log(`      frame text = ${JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 220))}`);
          // 资料页自己不该再有待收的转圈层：探活过了就把画面交出去了。
          // 只看资料页里的；PilotV 外壳别处（侧栏加载态等）的转圈跟这条链路无关。
          const spinnerGone = await page.waitForFunction(
            () => document.querySelectorAll('[data-testid="weknora-area"] .animate-spin').length === 0,
            undefined, { timeout: STEP_TIMEOUT },
          ).then(() => true, () => false);
          step('资料页没有卡住的转圈层', spinnerGone,
            spinnerGone ? '' : `${STEP_TIMEOUT}ms 后仍在转圈`);
          const strays = await page.evaluate(() => Array.from(
            document.querySelectorAll('.animate-spin'),
          ).map(el => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60)));
          if (strays.length) console.log(`      外壳里另有 ${strays.length} 个转圈元素：${strays.join(' | ')}`);
          console.log(`      截图 = ${await shot(page, 'weknora-loaded')}`);
        }
      }
    }
  }

  const relevant = consoleErrors.filter(line =>
    !/favicon|DevTools|ResizeObserver/i.test(line));
  if (relevant.length) console.log(`      console errors:\n        ${relevant.slice(0, 5).join('\n        ')}`);
  if (failedRequests.length) console.log(`      failed requests:\n        ${failedRequests.slice(0, 8).join('\n        ')}`);
} catch (error) {
  step('脚本执行', false, String(error).slice(0, 300));
  await shot(page, 'error');
} finally {
  const failed = steps.filter(s => !s.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} 步通过，截图目录 ${SHOTS}`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}