/**
 * 用 Android Chrome 的特征（移动 UA + 移动视口）复现登录流程，
 * 因为桌面 headless 能登录成功，手机上却失败 —— 必须模拟真机。
 *
 * 全程轮询 20 秒，记录 URL 与「是否停在登录页」的变化，
 * 这样能看出到底是「登录后弹回」还是「压根没进去」。
 *
 * 用法: node scripts/repro_login_mobile.mjs [地址]
 */
import { chromium } from '/home/marc/.pilotdeck/app/node_modules/.pnpm/playwright@1.61.0-alpha-1778188671000/node_modules/playwright/index.mjs';

const BASE = process.argv[2] || 'http://100.72.0.111:5186';
const USER = 'Marc';
const PASS = 'qwertyuiop';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const timeline = [];
const badResponses = [];
const consoleLog = [];

const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/marc/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-quic'],
});
const context = await browser.newContext({
  userAgent: ANDROID_UA,
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2.6,
});
const page = await context.newPage();

page.on('console', m => consoleLog.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
page.on('pageerror', e => consoleLog.push(`[pageerror] ${String(e).slice(0, 200)}`));
page.on('response', r => {
  if (r.status() >= 400) badResponses.push(`${r.status()}  ${r.request().method()} ${r.url()}`);
});

const onLoginPage = () => page.locator('input[type="password"]').count().then(n => n > 0);
const snap = async label => {
  const url = page.url().replace(BASE, '') || '/';
  const t = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/auth|token|session/i.test(k)) out[k] = String(localStorage.getItem(k)).slice(0, 24);
    }
    return out;
  }).catch(() => ({}));
  timeline.push(`${label.padEnd(14)} 登录页=${await onLoginPage()}  ${url.slice(0, 60)}  ${JSON.stringify(t)}`);
};

console.log(`打开 ${BASE}（Android 模拟）`);
// NAS 走 DERP 中继，延迟高，默认 30s 导航超时不够
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(5000);
await snap('打开后');

if (await onLoginPage()) {
  console.log('登录...');
  await page.fill('input[type="text"], input[name="username"]', USER);
  await page.fill('input[type="password"]', PASS);
  await page.locator('button[type="submit"], button:has-text("Sign In")').first().click();
  for (let i = 1; i <= 10; i++) {
    await page.waitForTimeout(2000);
    await snap(`登录后${i * 2}s`);
  }
}

console.log('\n=== 状态时间线 ===');
console.log(timeline.join('\n'));
console.log('\n=== >=400 响应 ===');
console.log(badResponses.length ? [...new Set(badResponses)].join('\n') : '（无）');
console.log('\n=== console ===');
console.log(consoleLog.length ? [...new Set(consoleLog)].slice(0, 20).join('\n') : '（无）');

const bounced = timeline.slice(1).some(l => l.includes('登录页=true'));
console.log(`\n结论: ${bounced ? '复现成功 —— 登录后弹回登录页' : '未复现'}`);
await page.screenshot({ path: '/tmp/repro_mobile.png' });
await browser.close();
