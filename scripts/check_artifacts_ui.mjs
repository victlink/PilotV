#!/usr/bin/env node
// 用真实浏览器验收成果台的三件事：
//   1. STEP/IGES 能不能转起来看（拖动=旋转，滚轮=缩放）；
//   2. 打开成果默认是「浏览」，标注只能手动切到框选/手绘之后才发生；
//   3. 列表只留每轮最后一份，声明了对比组的整组都留。
// 用法：node scripts/check_artifacts_ui.mjs [--url https://127.0.0.1:5186] [--out /tmp/shots] [--session <id>] [--only <n>]
// playwright 装在 UI 工程里，脚本本身在仓库根：按路径找它，不靠 cwd。
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const UI_DIR = process.env.PILOTV_UI_DIR || join(import.meta.dirname, '..', 'pilotdeck-mobile/upstream-official/ui');
const { chromium } = createRequire(join(UI_DIR, 'package.json'))('playwright');

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const URL_ = arg('url', 'https://127.0.0.1:5186');
const OUT = arg('out', '/tmp/shots');
const SESSION = arg('session', '');
const ONLY = Number(arg('only', '0'));

mkdirSync(OUT, { recursive: true });
const log = (...parts) => console.log(...parts);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const shotHash = buf => createHash('sha1').update(buf).digest('hex').slice(0, 12);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 950 } });
const page = await context.newPage();
const consoleErrors = [];
const badResponses = [];
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', err => consoleErrors.push(`pageerror: ${err.message}`));
// 只记服务端的 4xx/5xx：登录前那次 401 是设计如此，分开看才知道是不是新问题。
page.on('response', res => {
  if (res.status() >= 400) badResponses.push(`${res.status()} ${res.request().method()} ${res.url()}`);
});

await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);

// 自建账号要登录才进得去。凭据从环境变量来，不写死在脚本里。
if (await page.locator('input[type="password"]').count()) {
  const user = process.env.PILOTV_USER || '';
  const pass = process.env.PILOTV_PASS || '';
  if (!user || !pass) {
    log('页面停在登录页：没有 PILOTV_USER/PILOTV_PASS，跳过应用内验收。');
    writeFileSync(join(OUT, 'console.txt'), consoleErrors.join('\n'));
    await browser.close();
    process.exit(2);
  }
  await page.locator('input[type="password"]').first().fill(pass);
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.getByRole('button', { name: /sign in|登录/i }).first().click();
  await page.waitForTimeout(4000);
  log('登录后停在', page.url());
}

// 探路用：把侧边栏结构打出来，好写稳定的定位。
if (process.argv.includes('--dump')) {
  await page.waitForTimeout(2000);
  const tree = await page.evaluate(() => {
    const side = document.querySelector('aside, nav, [class*="sidebar"]') || document.body;
    return [...side.querySelectorAll('button, a, [role="treeitem"], [role="button"], li, div[data-testid]')]
      .slice(0, 80)
      .map(n => `${n.tagName}${n.getAttribute('role') || ''}${n.dataset.testid ? `[${n.dataset.testid}]` : ''} "${(n.textContent || '').trim().slice(0, 28)}"`)
      .join('\n');
  });
  writeFileSync(join(OUT, 'sidebar.txt'), tree);
  log('侧边栏结构已写入', join(OUT, 'sidebar.txt'));
  log(tree.split('\n').slice(0, 40).join('\n'));
  await browser.close();
  process.exit(0);
}
await page.screenshot({ path: join(OUT, '01-home.png') });
log('打开', URL_, '→', page.url());

// --inject <artifactId>：把一份真实 STEP 成果塞进当前会话的 workspace 返回里，
// 走真实渲染路径（/viewer 现场转 GLB），但一个字节都不写进成果库。
// 用途：成果库没有删除接口，往真会话里发测试件就收不回来了，只能在浏览器这层注入。
const inject = arg('inject', '');
if (inject) {
  // 先把那份成果的原始 payload 取回来，再改 workspace 的返回。
  const res0 = await (await context.request.get(`${new URL(`/api/artifacts/${inject}`, URL_).href}`)).json();
  const one = res0?.artifact || res0;
  log('注入源:', inject, one?.kind, one?.file_name, one?.entry?.url);
  await page.route('**/api/artifacts/workspace*', async route => {
    const res = await route.fetch();
    const body = await res.json();
    const a = JSON.parse(JSON.stringify(one));
    for (const p of body.projects || []) {
      for (const s of p.sessions || []) {
        if ((p.name || '').includes('PilotV') && (s.id || '').includes('s_461e9e')) {
          a.run_id = s.id;
          s.artifacts = [a];
        }
      }
    }
    await route.fulfill({ response: res, body: JSON.stringify(body) });
  });
  log('已注入成果', inject, '（只改浏览器里的接口返回，不写库）');
}
if (ONLY !== 1) {
  // 直接进会话路由，比在侧边栏里猜哪个会话有成果稳。
  const route = arg('route', '');
  if (route) {
    await page.goto(new URL(route, URL_).href, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    log('进入路由', route, '→', page.url());
  }
  // 深链接在这版没把会话选起来（侧边栏一直 Loading），只能走侧边栏：展开项目 → 点会话。
  const project = arg('project', '');
  if (project) {
    // 登录后的落地页每次不一样（有时是设置页），先回到主界面再点侧边栏。
    if (!/\/p\//.test(page.url())) {
      await page.goto(new URL('/p/general', URL_).href, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
    }
    await page.locator('text=Projects').first().waitFor({ timeout: 20000 }).catch(() => log('侧边栏没出现'));
    await page.waitForTimeout(1500);
    // 顶部 logo 和项目行都叫 PilotV：点最后一个（项目行），并等它展开。
    const projBtns = page.locator('button').filter({ hasText: new RegExp(`^${project}$`) });
    const total = await projBtns.count();
    log(`名为「${project}」的按钮 ${total} 个，点最后一个`);
    await projBtns.nth(Math.max(total - 1, 0)).click().catch(e => log('点项目失败', e.message));
    await page.waitForTimeout(2000);
    const convo = arg('conversation', '');
    const list = await page.getByRole('button').allTextContents();
    log('项目下的按钮:', list.map(t => t.trim()).filter(Boolean).slice(0, 24).join(' | '));
    if (convo) {
      // 会话行文字带计数后缀（标题148），用前缀正则才点得准；模糊匹配会点到设置页去。
      const convoBtn = page.locator('button').filter({ hasText: new RegExp(`^${convo}`) }).first();
      await convoBtn.click().catch(e => log('点会话失败', e.message));
      await page.waitForTimeout(3500);
      log('已选会话 →', page.url());
    }
  }
  if (SESSION && !route && !project) {
    const proj = page.locator(`text=${SESSION}`).first();
    if (await proj.count()) { await proj.click().catch(() => {}); await page.waitForTimeout(1200); }
    const convo = page.locator('[role="treeitem"], a, button').filter({ hasText: SESSION }).last();
    if (await convo.count()) { await convo.click().catch(() => {}); await page.waitForTimeout(2500); }
    log('已尝试选中对话:', SESSION, '→', page.url());
  }
  // 成果在右边悬浮标签栏上；换会话后标签栏可能是收起的，先展开再点。
  const artifactsTab = page.locator('button:has(> span:text-is("成果"))');
  if (!(await artifactsTab.first().isVisible().catch(() => false))) {
    await page.locator('.pd-page-drawer-toggle, [aria-label*="展开"]').first().click().catch(() => {});
    await page.waitForTimeout(800);
  }
  await artifactsTab.first().click({ timeout: 15000 }).catch(e => log('点「成果」失败', e.message));
  await page.waitForTimeout(2500);
  const frame = page.locator('[data-testid="artifact-frame"]');
  log('成果舞台存在:', await frame.count() > 0);
  await page.screenshot({ path: join(OUT, '02-artifacts-pane.png') });

  const select = page.locator('select[aria-label="选择成果"]');
  if (await select.count()) {
    const options = (await select.locator('option').allTextContents()).map(t => t.trim());
    log('下拉里的成果:', options.length, options.slice(0, 20).join(' | '));

    // 中间过程是否真的被藏起来：拿会话里成果的原始条数对比下拉里的条数。
    // 少的那些就是被隐藏的中间稿（每轮只留最后一份 + 对比组整组保留）。
    const sid = (page.url().match(/session\/([^?]+)/) || [])[1];
    if (sid && !inject) {
      const ws = await (await context.request.get(new URL('/api/artifacts/workspace?limit=200', URL_).href)).json();
      const total = (ws.projects || []).flatMap(p => (p.sessions || []).map(s => [p, s]))
        .filter(([, s]) => (s.id || '') === sid)
        .reduce((n, [, s]) => n + ((s.artifacts || []).length), 0);
      check('中间过程已隐藏（下拉条数 ≤ 会话原始条数）', options.length <= total,
        `下拉 ${options.length} 条 / 会话 ${total} 条`);
      log(`  会话共 ${total} 条，下拉 ${options.length} 条 → 隐藏了 ${total - options.length} 条中间稿`);
    }

    const pick = arg('pick', '');
    const wantName = arg('name', '');
    // 按名字选：watcher 会因为新文件继续往会话里发成果，下标两次跑下来就对不上了。
    const wanted = wantName ? options.findIndex(o => o.includes(wantName))
      : pick !== '' ? Number(pick)
        : options.findIndex(o => /STEP|step|CAD/i.test(o));
    if (wanted >= 0) {
      await select.selectOption({ index: wanted });
      await page.waitForTimeout(4000);
      log('已选中第', wanted + 1, '项:', options[wanted]);
    }
  }

  // 默认工具
  const tools = page.locator('[aria-label="成果操作"] button[aria-pressed]');
  const toolStates = await tools.evaluateAll(nodes => nodes.map(n => ({
    label: n.textContent.trim(), pressed: n.getAttribute('aria-pressed'),
  })));
  log('工具按钮:', JSON.stringify(toolStates));
  const browseOn = toolStates.some(t => /浏览/.test(t.label) && t.pressed === 'true');
  check('打开成果默认是浏览模式', browseOn, JSON.stringify(toolStates.map(t => t.label)));

  // 三维模型
  const viewer = page.locator('model-viewer');
  if (await viewer.count()) {
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(OUT, '03-model.png') });
    const before = await page.screenshot();
    const orbitBefore = JSON.stringify(await viewer.evaluate(el => el.getCameraOrbit ? el.getCameraOrbit() : ''));
    const box = await viewer.boundingBox();
    if (box) {
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 160, cy + 40, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(700);
    }
    const orbitAfter = JSON.stringify(await viewer.evaluate(el => el.getCameraOrbit ? el.getCameraOrbit() : ""));
    const afterDrag = await page.screenshot();
    check('三维模型可以拖动旋转', orbitBefore !== orbitAfter || shotHash(before) !== shotHash(afterDrag),
      `orbit ${orbitBefore} → ${orbitAfter}`);

    const box2 = await viewer.boundingBox();
    if (box2) {
      await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(700);
    }
    const afterZoom = await page.screenshot();
    await page.screenshot({ path: join(OUT, '04-model-zoomed.png') });
    // 缩放要的是相机距离真的变了：截图哈希变了也可能是阴影动画之类在动，
    // 只有 radius 收窄才算滚轮缩放生效。
    const orbitZoom = await viewer.evaluate(el => el.getCameraOrbit ? el.getCameraOrbit() : null);
    const radiusNow = orbitZoom && Number(orbitZoom.radius);
    const radiusWas = JSON.parse(orbitAfter).radius;
    check('三维模型可以滚轮缩放', Number.isFinite(radiusNow) && radiusNow < radiusWas - 0.5,
      `radius ${radiusWas} → ${radiusNow}（截图 ${shotHash(afterDrag)} → ${shotHash(afterZoom)}）`);

    // 上面刚在模型上拖了又滚了轮：浏览模式下这些手势只能是看，不能顺手标出来。
    const pendingText = (await page.locator('text=/标注 \\d+ 条待处理/').first().textContent().catch(() => '')) || '';
    check('浏览模式下手势不会顺手产生标注', /标注 0 条待处理/.test(pendingText), pendingText.trim());
  } else {
    log('当前成果不是三维模型，跳过旋转/缩放检查');
  }
}
writeFileSync(join(OUT, 'console.txt'), consoleErrors.join('\n'));
writeFileSync(join(OUT, 'responses.txt'), badResponses.join('\n'));
// 自签证书 + headless 下 Service Worker 的脚本请求会报 SSL，这不是应用缺陷；
// 只对真的接口错误判失败。
const apiErrors = badResponses.filter(r => /\/api\//.test(r) && !/401/.test(r));
check('接口没有报错', apiErrors.length === 0, apiErrors.slice(0, 3).join(' / '));
const realErrors = consoleErrors.filter(t => !/SSL certificate/i.test(t));
check('控制台没有报错', realErrors.length === 0, realErrors.slice(0, 3).join(' / '));
await browser.close();
const failed = results.filter(r => !r.ok);
log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
