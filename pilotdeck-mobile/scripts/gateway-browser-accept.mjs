// 设备切换验收：全新档案打开 PilotV 入口，
// 确认切换设备后仍然停在 5186、地址用 ?d= 标记、页面数据来自被选中的那台设备，
// 并且成果台跟着设备走、令牌互不串味。
import { createRequire } from 'node:module';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');

const base = process.env.BASE_URL || 'http://127.0.0.1:5186/';
const out = { base, steps: {}, errors: [] };
let failures = 0;
function check(name, ok, detail = '') {
  out.steps[name] = { ok, detail };
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  // 只记真正的问题：未捕获异常和 4xx/5xx。
  // 刷新时浏览器会主动中断在途请求（ERR_ABORTED），那是导航的正常产物，不算缺陷。
  page.on('pageerror', e => out.errors.push(`未捕获异常：${e.message}`));
  page.on('crash', () => out.errors.push('页面崩溃'));
  page.on('response', r => { if (r.status() >= 400) out.errors.push(`${r.status()} ${r.url()}`); });
  page.on('dialog', d => d.accept());

  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByLabel('选择设备').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);

  const deviceOptions = await page.getByLabel('选择设备').locator('option').allInnerTexts();
  check('下拉里有预置设备', deviceOptions.includes('jx88') && deviceOptions.length >= 4, deviceOptions.join(' / '));
  check('默认选中本机后端', await page.getByLabel('选择设备').inputValue() === 'http://127.0.0.1:3001',
    await page.getByLabel('选择设备').inputValue());
  check('页面在 5186 打开', page.url().startsWith(new URL(base).origin), page.url());

  // 1. 切到 jx88：地址留在 5186，只多一个 ?d=。
  await page.getByLabel('选择设备').selectOption('http://100.108.86.109:3001');
  await page.waitForURL(/[?&]d=/, { timeout: 30000 });
  await page.waitForTimeout(6000);
  check('切换后仍停在 PilotV 入口', page.url().startsWith(new URL(base).origin), page.url());
  check('地址用 ?d= 标记设备', page.url().includes('d=http%3A%2F%2F100.108.86.109%3A3001'), page.url());
  check('下拉选中被选中的设备', await page.getByLabel('选择设备').inputValue() === 'http://100.108.86.109:3001');
  check('运行时信息也切了', await page.evaluate(() => window.__PILOTV__?.backend) === 'http://100.108.86.109:3001',
    String(await page.evaluate(() => window.__PILOTV__?.backend)));

  // 2. 数据确实来自那台机器：页面应该出现 jx88 家目录下的项目。
  const body = await page.locator('body').innerText();
  check('页面数据来自远端后端', /jx88|general/i.test(body), body.slice(0, 120).replace(/\s+/g, ' '));

  // 3. 令牌不串味：jx88 不需要登录，本机需要，两个 key 各自独立。
  // jx88 不需要登录，所以可能一个令牌都没有；只要别落回那个全局共用的 auth-token 就算对。
  const tokenState = await page.evaluate(() => ({
    shared: localStorage.getItem('auth-token'),
    perDevice: JSON.parse(localStorage.getItem('pilotdeck-tokens') || '{}'),
  }));
  out.steps.tokens = tokenState;
  check('令牌不放在全局共用键里', tokenState.shared === null, JSON.stringify(tokenState));

  // 4. 成果台。远端设备本身不带成果台（上游 PilotDeck 没有这个功能），
  //    成果台由 PilotV 本机的独立服务提供。所以这里接受两种结果：
  //      - 200 且正文是真正的成果 JSON；
  //      - 诚实的 404（这台设备没部署成果台）。
  //    但 200 + HTML 是假象——那是 SPA 回退页冒充接口，必须判失败。
  const artifacts = await page.evaluate(async () => {
    const response = await fetch('/api/artifacts?limit=1');
    const body = (await response.text()).slice(0, 200);
    return { status: response.status, type: response.headers.get('content-type') || '', body };
  });
  out.steps.artifacts = artifacts;
  const realJson = artifacts.status === 200 && artifacts.body.trimStart().startsWith('{');
  const honest404 = artifacts.status === 404;
  check('成果台是真接口或诚实的 404（不接受假 200）',
    realJson || honest404,
    `status=${artifacts.status} type=${artifacts.type || '-'}${artifacts.status === 200 && !realJson ? ' ← 假 200：HTML 回退页冒充接口' : ''}`);

  // 5. 刷新后仍在同一台设备（Cookie 记住了选择）。
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  check('刷新后保持该设备', await page.evaluate(() => window.__PILOTV__?.backend) === 'http://100.108.86.109:3001',
    page.url());
  check('刷新后下拉仍选中它', await page.getByLabel('选择设备').inputValue() === 'http://100.108.86.109:3001');

  // 6. 切回本机。
  out.steps.backOptions = await page.getByLabel('选择设备').locator('option').evaluateAll(
    nodes => nodes.map(n => ({ value: n.value, label: n.textContent })));
  await page.getByLabel('选择设备').selectOption('http://127.0.0.1:3001', { timeout: 60000 });
  await page.waitForTimeout(6000);
  check('可以切回本机', await page.evaluate(() => window.__PILOTV__?.backend) === 'http://127.0.0.1:3001', page.url());

  // 远端设备没有部署成果台，所以这条是预期内的，不算失败；除此之外任何报错都要暴露。
  const unexpected = out.errors.filter((line) => !/artifacts\?limit=1/.test(line));
  check('除预期的成果台 404 外没有未捕获异常或失败请求', unexpected.length === 0,
    unexpected.slice(0, 3).join(' | ') || out.errors.slice(0, 3).join(' | '));
} catch (error) {
  failures += 1;
  out.steps.crashed = String(error).split('\n')[0];
  console.log(`✘ 验收中断：${String(error).split('\n')[0]}`);
  console.log(`  页面报错：${out.errors.slice(0, 5).join(' | ') || '（无）'}`);
} finally {
  await browser.close();
}

console.log(`\n${failures ? `${failures} 项不通过` : '全部通过'}`);
process.exit(failures ? 1 : 0);