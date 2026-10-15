// PilotV 成果页真实验收：走真实会话、真实成果，验证「看得见」与「能标注」。
//
//     node pilotdeck-mobile/scripts/artifacts-pane-accept.mjs
//
// 为什么不用 iframe 里的旧成果台做断言：旧页面已经删除，成果页现在是 PilotV
// 前端里的原生组件，必须对着真实 DOM 验，否则页面改了断言还在骗人。
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5186/';
// 验收会话必须自己带成果，否则列表本来就是空的，测不出问题。
const SESSION_TITLE = process.env.SESSION_TITLE || '设计 PilotV logo';
const PROJECT_TITLE = process.env.PROJECT_TITLE || 'PilotV';
const review = 'pilotdeck-mobile/review';
await mkdir(review, { recursive: true });

const browser = await chromium.launch({ headless: true, executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const problems = [];
page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
page.on('console', message => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
// 资源 404 会让成果看起来是空白，必须点名到具体地址。
page.on('response', response => { if (response.status() >= 400) problems.push(`http ${response.status()}: ${response.url().replace(BASE, '/')}`); });

const shot = name => page.screenshot({ path: `${review}/${name}.png`, timeout: 20000 });
const step = async (label, fn) => {
  try { const value = await fn(); console.log(`PASS  ${label}`, value ?? ''); return value; }
  catch (error) { console.log(`FAIL  ${label}: ${error.message}`); problems.push(`${label}: ${error.message}`); }
};

try {
  await step('打开 PilotV 并进入有成果的会话', async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    // 会话按项目分组，默认展开的不是 PilotV，先点项目再等真实条目。
    // 后端冷启动拉项目与会话要十几秒，等条目而不是等固定时长。
    await page.getByRole('button', { name: PROJECT_TITLE, exact: true }).first().click({ timeout: 30000 });
    // 侧边栏每个项目只显示前几条，目标会话可能藏在「Show more」后面。
    const session = page.getByText(SESSION_TITLE, { exact: false }).first();
    for (let attempt = 0; attempt < 6 && !(await session.isVisible().catch(() => false)); attempt += 1) {
      const more = page.getByRole('button', { name: /Show more|显示更多|展开/ }).first();
      if (!await more.isVisible().catch(() => false)) break;
      await more.click();
      await page.waitForTimeout(400);
    }
    await session.waitFor({ timeout: 60000 });
    await session.click();
    await page.getByRole('navigation', { name: '对话与成果切换' }).waitFor({ timeout: 30000 });
    return SESSION_TITLE;
  });

  await step('切到成果页并列出当前会话成果', async () => {
    await page.getByRole('navigation', { name: '对话与成果切换' }).getByRole('button', { name: '成果' }).click();
    const pane = page.getByRole('region', { name: '当前会话成果' });
    await pane.waitFor({ timeout: 15000 });
    // 桌面端成果选择器挂在顶栏槽位里（不在 pane 内），所以这里按全局定位。
    const picker = page.locator('select[aria-label="选择成果"]');
    await picker.waitFor({ timeout: 15000 });
    const slot = page.locator('#artifacts-header-controls');
    if (!await slot.isVisible()) throw new Error('成果选择器没有挂到顶栏槽位');
    // 列表是异步拉的，「暂无成果」是加载中，不是真的没有 —— 等到真条目为止。
    await page.waitForFunction(() => {
      const select = document.querySelector('select[aria-label="选择成果"]');
      const first = select?.querySelector('option');
      return Boolean(first && !/^暂无/.test(first.textContent || ''));
    }, { timeout: 30000 });
    const options = await picker.locator('option').allTextContents();
    if (!/^1\./.test(options[0])) throw new Error(`第一条成果没有编号：${options[0]}`);
    return options.slice(0, 3);
  });

  let artifactUrl = '';
  await step('预览真的画出来了（不是 0×0 的空壳）', async () => {
    const pane = page.getByRole('region', { name: '当前会话成果' });
    const shotBefore = await shot('pane-01-listed');
    const media = await pane.evaluate(node => {
      const item = node.querySelector('img, video, iframe, model-viewer');
      if (!item) return { found: false };
      const box = item.getBoundingClientRect();
      const stage = item.parentElement.getBoundingClientRect();
      const area = node.querySelector('img, video, iframe, model-viewer').closest('div.overflow-hidden')
        ?.getBoundingClientRect() ?? null;
      const box3 = rect => ({ w: Math.round(rect.width), h: Math.round(rect.height) });
      return {
        found: true,
        tag: item.tagName.toLowerCase(),
        area: area ? box3(area) : null,
        stage: box3(stage),
        item: { ...box3(box), src: item.getAttribute('src') || '' },
        complete: item.complete ?? null,
        naturalWidth: item.naturalWidth ?? null,
      };
    });
    if (!media.found) throw new Error('画面里没有任何预览元素');
    if (!media.area || media.area.w < 200 || media.area.h < 200) throw new Error(`预览区太小 ${JSON.stringify(media.area)}`);
    if (media.item.w < 40 || media.item.h < 40) throw new Error(`预览元素没尺寸 ${JSON.stringify(media.item)}`);
    if (media.tag === 'img' && !(media.naturalWidth > 0)) throw new Error('图片没加载出来（naturalWidth=0）');
    // 标注是相对媒体本体的，媒体盒子必须和承载标注的舞台完全重合。
    if (media.item.w !== media.stage.w || media.item.h !== media.stage.h) {
      throw new Error(`媒体与标注舞台错位：媒体 ${media.item.w}x${media.item.h} vs 舞台 ${media.stage.w}x${media.stage.h}`);
    }
    // 缩放要完整 contain：不许溢出成需要滚动的长图。
    if (media.area && (media.item.h > media.area.h + 1 || media.item.w > media.area.w + 1)) {
      throw new Error(`媒体超出预览区：媒体 ${media.item.w}x${media.item.h} vs 预览区 ${media.area.w}x${media.area.h}`);
    }
    artifactUrl = media.item.src;
    return media;
  });

  await step('单击画面生成编号标注并保存', async () => {
    const pane = page.getByRole('region', { name: '当前会话成果' });
    // 必须点媒体本体的中心，不是滚动容器的中心：图片比容器高时两者不是同一点，
    // 拿容器归一化就会把标注记到画面之外。
    const box = await pane.locator('img, video, iframe, model-viewer').first().boundingBox();
    if (!box) throw new Error('媒体没有可点的盒子');
    await page.mouse.click(box.x + Math.round(box.width / 2), box.y + Math.round(box.height / 2));
    await pane.getByLabel('新标注（1）').fill('验收脚本：这块要改');
    await shot('pane-02-draft');
    await pane.getByRole('button', { name: '保存标注' }).click();
    await pane.getByRole('listitem').filter({ hasText: '验收脚本：这块要改' }).first().waitFor({ timeout: 15000 });
    await shot('pane-03-saved');
    return 'note saved';
  });

  await step('标注相对媒体归一化，不随容器尺寸漂移', async () => {
    const pane = page.getByRole('region', { name: '当前会话成果' });
    const pin = pane.locator('button[aria-label^="标注 1："]');
    await pin.waitFor({ timeout: 10000 });
    await pane.locator('img, video, iframe, model-viewer').first().waitFor({ timeout: 20000 });
    const media = await pane.locator('img, video, iframe, model-viewer').first().boundingBox();
    const saved = await pin.boundingBox();
    const nx = (saved.x + saved.width / 2 - media.x) / media.width;
    const ny = (saved.y + saved.height / 2 - media.y) / media.height;
    if (Math.abs(nx - 0.5) > 0.04 || Math.abs(ny - 0.5) > 0.04) throw new Error(`标注没落在点击处 nx=${nx.toFixed(3)} ny=${ny.toFixed(3)}`);

    // 锚点是 0–1 相对媒体：把预览区改窄，标注在媒体里的相对位置必须不变。
    const widthBefore = media.width;
    await page.setViewportSize({ width: 980, height: 900 });
    await page.waitForTimeout(500);
    const resized = await pane.locator('img, video, iframe, model-viewer').first().boundingBox();
    const pinAfter = await pin.boundingBox();
    const mx = (pinAfter.x + pinAfter.width / 2 - resized.x) / resized.width;
    const my = (pinAfter.y + pinAfter.height / 2 - resized.y) / resized.height;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);
    if (Math.abs(mx - nx) > 0.02 || Math.abs(my - ny) > 0.02) throw new Error(`改窗口后标注漂移 ${nx.toFixed(3)},${ny.toFixed(3)} -> ${mx.toFixed(3)},${my.toFixed(3)}`);
    if (Math.abs(resized.width - widthBefore) < 20) throw new Error(`预览区宽度几乎没变（${widthBefore} → ${resized.width}），这条断言没验到东西`);
    return {
      点中的位置: { nx: Number(nx.toFixed(3)), ny: Number(ny.toFixed(3)) },
      改窗口后: { nx: Number(mx.toFixed(3)), ny: Number(my.toFixed(3)) },
      媒体尺寸: [`${Math.round(media.width)}x${Math.round(media.height)}`, `${Math.round(resized.width)}x${Math.round(resized.height)}`],
    };
  });

  await step('拖出框选标注，位置和框选范围一致', async () => {
    const pane = page.getByRole('region', { name: '当前会话成果' });
    const media = await pane.locator('img, video, iframe, model-viewer').first().boundingBox();
    const from = { x: media.x + media.width * 0.25, y: media.y + media.height * 0.25 };
    const to = { x: media.x + media.width * 0.75, y: media.y + media.height * 0.75 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await pane.getByLabel('新标注（2）').fill('验收脚本：这块整体换掉');
    await pane.getByRole('button', { name: '保存标注' }).click();
    await pane.getByRole('listitem').filter({ hasText: '验收脚本：这块整体换掉' }).first().waitFor({ timeout: 15000 });
    await shot('pane-05-drag');

    const pin = pane.locator('button[aria-label^="标注 2："]');
    const saved = await pin.boundingBox();
    const nx = (saved.x - media.x) / media.width;
    const ny = (saved.y - media.y) / media.height;
    // 框选起点就是左上角标号所在处；宽高要占满拖过的范围。
    const width = (await pin.evaluate(node => parseFloat(getComputedStyle(node).width))) / media.width;
    const height = (await pin.evaluate(node => parseFloat(getComputedStyle(node).height))) / media.height;
    if (Math.abs(nx - 0.25) > 0.05 || Math.abs(ny - 0.25) > 0.05) throw new Error(`框选左上角偏了 nx=${nx.toFixed(3)} ny=${ny.toFixed(3)}`);
    if (width < 0.4 || height < 0.4) throw new Error(`框选范围太小 ${width.toFixed(2)}x${height.toFixed(2)}`);
    await pane.getByRole('listitem').filter({ hasText: '验收脚本：这块整体换掉' }).first().getByRole('button', { name: '删除' }).click();
    await pane.getByRole('listitem').filter({ hasText: '验收脚本：这块整体换掉' }).first().waitFor({ state: 'detached', timeout: 15000 });
    return { 左上角: [Number(nx.toFixed(3)), Number(ny.toFixed(3))], 框大小: [Number(width.toFixed(2)), Number(height.toFixed(2))] };
  });

  await step('刷新后标注仍在（真的写进了服务）', async () => {
    const pane = page.getByRole('region', { name: '当前会话成果' });
    // 刷新按钮和选择器一样在顶栏槽位里。
    await page.getByRole('button', { name: '刷新' }).click();
    await pane.getByRole('listitem').filter({ hasText: '验收脚本：这块要改' }).first().waitFor({ timeout: 15000 });
    return 'persisted';
  });

  await step('删掉验收标注，不留脏数据', async () => {
    const pane = page.getByRole('region', { name: '当前会话成果' });
    const item = pane.getByRole('listitem').filter({ hasText: '验收脚本：这块要改' }).first();
    await item.getByRole('button', { name: '删除' }).click();
    await pane.getByText('还没有标注', { exact: false }).waitFor({ timeout: 15000 });
    return 'cleaned';
  });

  await step('每种成果都真的渲染出来', async () => {
    // 只验图片等于没验：HTML/PDF、视频、三维、无法预览的格式各走一遍。
    const pane = page.getByRole('region', { name: '当前会话成果' });
    const picker = page.locator('select[aria-label="选择成果"]');
    const options = await picker.locator('option').evaluateAll(nodes => nodes.map(n => ({ value: n.value, text: n.textContent || '' })));
    const seen = new Map();
    const report = [];
    for (const option of options.filter(item => item.value)) {
      const detail = await fetch(new URL(`/api/artifacts/${option.value}`, BASE)).then(r => r.json());
      const kind = detail.kind || detail.media_type || 'unknown';
      if (seen.has(kind)) continue;
      seen.set(kind, option.value);
      await picker.selectOption(option.value);
      await pane.locator('img, video, iframe, model-viewer, [role="alert"], p').first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(900);
      const state = await pane.evaluate(() => {
        const node = document.querySelector('[aria-label="当前会话成果"]');
        const img = node.querySelector('img');
        const video = node.querySelector('video');
        const frame = node.querySelector('iframe');
        const model = node.querySelector('model-viewer');
        const alert = node.querySelector('[role="alert"]');
        const box = el => { const r = el?.getBoundingClientRect(); return r ? `${Math.round(r.width)}x${Math.round(r.height)}` : null; };
        const viewer = img || video || frame || model;
        return {
          // 标注是叠在这个盒子上的：媒体和承载标注的舞台必须重合，否则框会飘。
          viewerMatchesStage: viewer ? box(viewer) === box(viewer.parentElement) : null,
          img: img ? { box: box(img), naturalWidth: img.naturalWidth } : null,
          video: video ? { box: box(video), readyState: video.readyState, duration: video.duration, width: video.videoWidth } : null,
          timeline: Boolean(node.querySelector('input[aria-label="时间线"]')),
          iframe: frame ? { box: box(frame), loaded: (() => { try { return Boolean(frame.contentDocument?.body?.childElementCount); } catch { return 'cross-origin'; } })() } : null,
          model: model ? { box: box(model), upgraded: model.shadowRoot !== null, defined: Boolean(customElements.get('model-viewer')) } : null,
          alert: alert ? alert.textContent.slice(0, 40) : null,
          hasDownload: Boolean(node.querySelector('a[download]')),
        };
      });
      if (kind === 'page' || kind === 'model3d') await shot(`pane-07-${kind}`);
      report.push({ kind, file: option.text, ...state });
    }
    const problems = [];
    for (const row of report) {
      if (row.kind === 'image' && !(row.img && row.img.naturalWidth > 0)) problems.push(`图片没加载：${row.file}`);
      if (row.kind === 'video' && !(row.video && row.video.readyState >= 1 && row.video.duration > 0)) problems.push(`视频没出画面：${row.file} ${JSON.stringify(row.video)}`);
      if (row.kind === 'video' && !row.timeline) problems.push('视频没有时间线');
      if (row.kind === 'page' && !(row.iframe && row.iframe.box)) problems.push(`网页没嵌进去：${row.file}`);
      if (row.kind === 'doc' && row.iframe && row.iframe.loaded === true === false && row.iframe.loaded !== 'cross-origin' && !row.model && !row.video && !row.img) problems.push(`文档嵌进去了但内容是空的：${row.file}`);
      if (row.kind === 'model3d' && !(row.model && row.model.upgraded && row.model.defined)) problems.push(`三维没加载：${row.file} ${JSON.stringify(row.model)}`);
      if (row.viewerMatchesStage === false) problems.push(`${row.kind} 的预览和标注舞台没重合：${row.file}`);
      if (!row.img && !row.video && !row.iframe && !row.model && !row.hasDownload) problems.push(`这个格式什么都看不到：${row.file}`);
    }
    if (problems.length) throw new Error(problems.join('; '));
    return report.map(row => `${row.kind} ${row.file} ${JSON.stringify(row.img || row.video || row.iframe || row.model || row.alert)}`);
  });

  await step('手机宽度下成果页不出横向滚动', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    const phone = await page.evaluate(() => {
      const pane = document.querySelector('[aria-label="当前会话成果"]');
      const picker = document.querySelector('select[aria-label="选择成果"]');
      const slot = document.querySelector('#artifacts-header-controls');
      return {
        scrollWidth: pane?.scrollWidth ?? 0,
        clientWidth: pane?.clientWidth ?? 0,
        pickerInHeader: Boolean(slot && picker && slot.contains(picker)),
      };
    });
    if (!phone.clientWidth) throw new Error('成果页不见了');
    if (phone.scrollWidth > phone.clientWidth + 2) throw new Error(`成果页横向溢出 ${JSON.stringify(phone)}`);
    // 手机上顶栏已经有对话/成果、标题与搜索，再塞一份控制条会重叠，必须落到成果页自己这行。
    if (phone.pickerInHeader) throw new Error('手机上控制条还在顶栏里，会和对话/成果切换重叠');
    return { image: await shot('pane-06-phone'), ...phone };
  });

  console.log(`\n预览地址：${artifactUrl}`);
} finally {
  await browser.close();
}

if (problems.length) {
  console.log(`\n${problems.length} 个问题：`);
  problems.forEach(item => console.log(' -', item));
  process.exit(1);
}
console.log('\n全部通过');