// 多标签页隔离验收：同一个浏览器上下文里开两个标签页各连一台设备。
// Cookie 是上下文共享的，所以如果网关还靠 Cookie 判断设备，这里必然串味。
// 另外验一遍「在设置窗口里加的设备，换个浏览器也看得见」。
import { createRequire } from 'node:module';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');

const base = process.env.BASE_URL || 'http://127.0.0.1:5186/';
const A = process.env.DEVICE_A || 'http://100.108.86.109:3001';  // jx88，免登录
const B = process.env.DEVICE_B || 'http://100.72.0.111:3001';    // marc-linux-pc
const out = { base, deviceA: A, deviceB: B, steps: {}, errors: [] };
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

const ignore = text => !/ERR_ABORTED|Failed to load resource/.test(text);

try {
  const context = await browser.newContext();
  context.on('page', page => {
    page.on('pageerror', e => out.errors.push(`未捕获异常：${e.message}`));
    page.on('crash', () => out.errors.push('页面崩溃'));
  });

  // ── 两个标签页各连一台 ──────────────────────────────────────────
  const tabA = await context.newPage();
  await tabA.goto(`${base}?d=${encodeURIComponent(A)}`, { waitUntil: 'domcontentloaded' });
  const tabB = await context.newPage();
  await tabB.goto(`${base}?d=${encodeURIComponent(B)}`, { waitUntil: 'domcontentloaded' });

  const backendOf = page => page.evaluate(() => window.__PILOTV__?.backend || '');
  check('标签页 A 连的是 A 设备', await backendOf(tabA) === A, await backendOf(tabA));
  check('标签页 B 连的是 B 设备', await backendOf(tabB) === B, await backendOf(tabB));

  // 关键：Cookie 已经被 B 改掉了，但 A 的请求仍然必须走 A。
  const cookies = await context.cookies(base);
  const cookieValue = cookies.find(item => item.name === 'pdv_backend')?.value || '';
  check('共享 Cookie 确实指向 B', decodeURIComponent(cookieValue) === B, decodeURIComponent(cookieValue));

  const projectsOf = page => page.evaluate(async () => {
    const response = await fetch('/api/projects', { cache: 'no-store' });
    const body = await response.text();
    return { status: response.status, sample: body.slice(0, 120) };
  });
  const [respA, respB] = await Promise.all([projectsOf(tabA), projectsOf(tabB)]);
  out.projectsA = respA;
  out.projectsB = respB;
  check('两个标签页拿到的后端回应不同', respA.sample !== respB.sample,
    `A=${respA.status} B=${respB.status}`);

  // 逐请求头路由：即便把 Cookie 抹掉，两个标签页依然各连各的。
  const cleared = await context.clearCookies();
  const [againA, againB] = await Promise.all([projectsOf(tabA), projectsOf(tabB)]);
  check('清掉 Cookie 后仍各连各的', againA.sample === respA.sample && againB.sample === respB.sample,
    `A=${againA.status} B=${againB.status} ${cleared === undefined ? '' : ''}`);
  check('两个标签页全程无未捕获异常', out.errors.length === 0, out.errors.join(' | '));

  // ── 服务端设备清单跨浏览器可见 ──────────────────────────────────
  const registry = await context.request.get(new URL('/api/pilotv/devices', base).toString());
  const list = await registry.json();
  const addedName = `多标签验收-${process.pid}`;
  const addedOrigin = 'http://100.99.99.99:3001';

  const created = await context.request.post(new URL('/api/pilotv/devices', base).toString(), {
    data: { name: addedName, origin: addedOrigin },
  });
  check('服务端接受新增设备', created.ok(), `status=${created.status()}`);

  // 另一个完全独立的浏览器档案：既没有 localStorage，也没有 Cookie。
  const freshContext = await browser.newContext();
  const freshPage = await freshContext.newPage();
  await freshPage.goto(base, { waitUntil: 'domcontentloaded' });
  // 清单是异步拉的，要一直等到目标名字出现再收。
  // 空数组在 Playwright 眼里也是「有结果」，所以得自己判空，否则会秒返回空列表。
  const freshOptions = await freshPage.waitForFunction(
    expected => {
      const select = document.querySelector('select[aria-label="选择设备"]');
      const names = Array.from(select?.querySelectorAll('option') || []).map(option => option.textContent);
      return names.includes(expected) ? names : null;
    },
    addedName,
    { timeout: 15000, polling: 200 },
  ).then(handle => handle.jsonValue()).catch(() => []);
  check('新浏览器能看到别的标签页加的设备', freshOptions.includes(addedName), freshOptions.join(' / '));

  // 陌生设备不会被当成可用代理目标。
  const rejected = await context.request.post(new URL('/api/pilotv/devices', base).toString(), {
    data: { name: '公网', origin: 'http://8.8.8.8:80' },
  });
  check('公网地址被拒绝', rejected.status() === 400, `status=${rejected.status()}`);

  const metadata = await context.request.post(new URL('/api/pilotv/devices', base).toString(), {
    data: { name: '元数据', origin: 'http://169.254.169.254:80' },
  });
  check('云元数据地址被拒绝', metadata.status() === 400, `status=${metadata.status()}`);

  // 收拾干净，别把测试设备留在清单里。
  await context.request.delete(`${new URL('/api/pilotv/devices', base).toString()}?origin=${encodeURIComponent(addedOrigin)}`);
  await freshContext.close();
  out.finalDevices = (await (await context.request.get(new URL('/api/pilotv/devices', base).toString())).json()).devices
    .map(device => device.name);
} catch (error) {
  out.errors.push(`验收中断：${error.message}`);
  failures += 1;
} finally {
  await browser.close();
}

out.failures = failures;
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项不通过`}`);
process.exit(failures === 0 ? 0 : 1);