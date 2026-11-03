/**
 * 模拟「手机上的真实状态」：浏览器里已经积累了旧数据
 *   - pdv_backend cookie 指向另一台设备（leo-mac-studio）
 *   - pilotdeck-tokens 里存着那台设备的旧 token
 *   - 已经装过 Service Worker
 * 然后再走一遍登录，看会不会弹回登录页。
 *
 * 用法: node scripts/repro_stale_state.mjs [地址]
 */
import { chromium } from '/home/marc/.pilotdeck/app/node_modules/.pnpm/playwright@1.61.0-alpha-1778188671000/node_modules/playwright/index.mjs';

const BASE = process.argv[2] || 'http://100.72.0.111:5186';
const USER = 'Marc';
const PASS = 'qwertyuiop';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

// 另一台设备上的 token（用 leo-mac 自己的登录接口拿一个真的）
const other = await fetch('http://100.117.103.34:3002/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
}).then(r => r.json()).catch(() => ({}));
const otherToken = other.token || '';
console.log(`leo-mac 上的 token: ${otherToken ? '已获取' : '没拿到'}`);

const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/marc/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const context = await browser.newContext({
  userAgent: ANDROID_UA,
  viewport: { width: 412, height: 915 },
  isMobile: true, hasTouch: true,
});

// 播种旧状态
await context.addCookies([{
  name: 'pdv_backend',
  value: encodeURIComponent('http://100.117.103.34:3002'),
  domain: '100.72.0.111', path: '/',
}]);
await context.addInitScript(`
  try {
    localStorage.setItem('pilotdeck-tokens', JSON.stringify({
      'http://100.117.103.34:3002': ${JSON.stringify(otherToken)},
    }));
    localStorage.setItem('auth-token', ${JSON.stringify(otherToken)});
  } catch (e) {}
`);

const page = await context.newPage();
const bad = [];
page.on('response', r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

const onLoginPage = () => page.locator('input[type="password"]').count().then(n => n > 0);
const timeline = [];
const snap = async label => {
  timeline.push(`${label.padEnd(10)} 登录页=${await onLoginPage()}  ${(page.url().replace(BASE, '') || '/').slice(0, 55)}`);
};

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await snap('打开后');

if (await onLoginPage()) {
  console.log('登录...');
  await page.fill('input[type="text"], input[name="username"]', USER);
  await page.fill('input[type="password"]', PASS);
  await page.locator('button[type="submit"], button:has-text("Sign In")').first().click();
  for (let i = 1; i <= 8; i++) { await page.waitForTimeout(2500); await snap(`登录后${i * 2.5}s`); }
}

console.log('\n=== 状态时间线 ===');
console.log(timeline.join('\n'));
console.log('\n=== >=400 ===');
console.log(bad.length ? [...new Set(bad)].join('\n') : '（无）');
const bounced = timeline.slice(1).some(l => l.includes('登录页=true'));
console.log(`\n结论: ${bounced ? '复现成功 —— 带旧状态时登录后弹回登录页' : '未复现'}`);
await page.screenshot({ path: '/tmp/repro_stale.png' });
await browser.close();
