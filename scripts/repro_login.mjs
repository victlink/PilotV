/**
 * 用真实浏览器复现「登录后又回到登录页」，并把整个过程录下来：
 *   - 所有 console 消息与未捕获异常
 *   - 所有 >=400 的响应（这是真凶所在：前端拿到 401 就清 token 刷新）
 *   - 登录前后 localStorage 里的 auth-token
 *   - 最终停在哪个页面
 *
 * 用法: node scripts/repro_login.mjs [地址]
 *   地址默认 http://100.72.0.111:5186（用户手机实际打开的入口）
 */
import { chromium } from '/home/marc/.pilotdeck/app/node_modules/.pnpm/playwright@1.61.0-alpha-1778188671000/node_modules/playwright/index.mjs';

const BASE = process.argv[2] || 'http://100.72.0.111:5186';
const USER = 'Marc';
const PASS = 'qwertyuiop';

const consoleLog = [];
const errors = [];
const badResponses = [];

const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/marc/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const context = await browser.newContext();
const page = await context.newPage();

page.on('console', m => consoleLog.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
page.on('response', r => {
  if (r.status() >= 400) badResponses.push(`${r.status()}  ${r.request().method()} ${r.url()}`);
});

const tokenNow = () => page.evaluate(() => localStorage.getItem('auth-token'));
const onLoginPage = () => page.locator('input[type="password"]').count().then(n => n > 0);

console.log(`打开 ${BASE}`);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

console.log(`打开后是否停在登录页: ${await onLoginPage()}`);
console.log(`打开后 localStorage.auth-token: ${(await tokenNow()) ? '有' : '无'}`);

if (await onLoginPage()) {
  console.log('输入用户名密码并登录...');
  await page.fill('input[type="text"], input[name="username"]', USER);
  await page.fill('input[type="password"]', PASS);
  await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/auth/login'), { timeout: 15000 })
      .then(r => console.log(`  /api/auth/login -> ${r.status()}`)),
    page.locator('button[type="submit"], button:has-text("Sign In")').first().click(),
  ]);
  await page.waitForTimeout(6000);
}

const tokenAfter = await tokenNow();
console.log(`\n登录后 localStorage.auth-token: ${tokenAfter ? '有' : '无（已被清掉！）'}`);
console.log(`登录后是否又回到登录页: ${await onLoginPage()}`);
console.log(`最终 URL: ${page.url()}`);

console.log('\n=== >=400 的响应（真凶） ===');
console.log(badResponses.length ? [...new Set(badResponses)].join('\n') : '（无）');

console.log('\n=== 页面异常 ===');
console.log(errors.length ? [...new Set(errors)].join('\n') : '（无）');

console.log('\n=== console（含 chunk 加载/自动刷新线索） ===');
console.log(consoleLog.length ? [...new Set(consoleLog)].slice(0, 25).join('\n') : '（无）');

await page.screenshot({ path: '/tmp/repro_login.png' });
console.log('\n截图: /tmp/repro_login.png');
await browser.close();
