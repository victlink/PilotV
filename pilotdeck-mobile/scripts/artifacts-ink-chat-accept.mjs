// 验收两件此前没被真实验证过的事：
//  1) 无锚点的历史标注（anchor_json={}）在画面上真的看得见「无位置」标记——
//     用户报的「标注看不到」就是这条路径把它整个丢掉了。
//  2) 手绘能变成对话输入框里真正可提交的 PNG 附件 + 说明文字。
// 只读：不真的发消息，按钮点完就撤销。
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');

const BASE = process.env.PILOTV_BASE || 'http://127.0.0.1:5186/';
const PROJECT_TITLE = 'PilotV';
const SESSION = '询问当前进展';
const NOTE_TEXT = '成果面板主窗口应铺满，左栏与顶栏已去掉';
const review = new URL('../review/', import.meta.url).pathname;
await mkdir(review, { recursive: true });

const results = [];
const step = async (label, fn) => {
  try {
    const detail = await fn();
    results.push({ label, ok: true, detail });
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ label, ok: false, detail: String(error.message).split('\n')[0] });
    console.log(`FAIL  ${label}: ${String(error.message).split('\n')[0]}`);
  }
};

const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const page = await (await browser.newContext({
  viewport: { width: 1440, height: 900 }, hasTouch: true, serviceWorkers: 'block',
})).newPage();

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: PROJECT_TITLE, exact: true }).first().click({ timeout: 30000 });
const session = page.getByText(SESSION, { exact: false }).first();
for (let i = 0; i < 6 && !(await session.isVisible().catch(() => false)); i += 1) {
  const more = page.getByRole('button', { name: /Show more|显示更多|展开/ }).first();
  if (!await more.isVisible().catch(() => false)) break;
  await more.click();
  await page.waitForTimeout(400);
}
await session.click();
await page.getByRole('navigation', { name: '对话与成果切换' }).getByRole('button', { name: '成果' }).click();
const pane = page.getByRole('region', { name: '当前会话成果' });
await pane.waitFor({ timeout: 20000 });

await step('无锚点的历史标注在画面上有位置标记', async () => {
  const picker = page.locator('select[aria-label="选择成果"]');
  await picker.waitFor({ timeout: 15000 });
  const options = await picker.locator('option').evaluateAll(nodes =>
    nodes.map(n => ({ value: n.value, label: n.textContent.trim() })));
  const target = options.find(o => o.label.includes('移动端适配前端'));
  if (!target) throw new Error(`成果下拉里没有这条：${JSON.stringify(options.map(o => o.label))}`);
  await picker.selectOption(target.value);
  await page.waitForTimeout(2500);
  const orphan = pane.getByText('无位置', { exact: false }).first();
  await orphan.waitFor({ timeout: 15000 });
  await pane.getByText(NOTE_TEXT.slice(0, 10), { exact: false }).first().waitFor({ timeout: 10000 });
  const box = await orphan.boundingBox();
  if (!box || box.width === 0) throw new Error('「无位置」标记没有实际尺寸');
  await page.screenshot({ path: `${review}legacy-note-visible.png` });
  return `「无位置」标记 ${Math.round(box.width)}×${Math.round(box.height)}px @${Math.round(box.x)},${Math.round(box.y)}`;
});

await step('手绘能送进对话输入框（PNG 附件 + 说明）', async () => {
  // 先画一笔
  await page.getByRole('button', { name: '手绘', exact: true }).click();
  const canvas = page.locator('[data-testid="ink-canvas"]');
  await canvas.waitFor({ timeout: 10000 });
  const box = await canvas.boundingBox();
  const x = box.x + box.width * 0.3, y = box.y + box.height * 0.4;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) { await page.mouse.move(x + i * 9, y + Math.sin(i) * 18); await page.waitForTimeout(14); }
  await page.mouse.up();
  await page.waitForTimeout(600);
  const bar = page.locator('#artifact-note-draft');
  await bar.waitFor({ timeout: 10000 });
  await bar.fill('验收：手绘进对话');
  // 「手绘发到对话」只在草稿还在时出现，先发图再存标注。
  await page.getByRole('button', { name: '手绘发到对话', exact: true }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /保存标注/ }).click();
  await page.waitForTimeout(2500);
  // 再点一次面板上的「同步到对话输入」：应该替换而不是叠加。
  await page.getByRole('button', { name: '同步到对话输入', exact: true }).click();
  await page.waitForTimeout(2000);
  await page.getByRole('navigation', { name: '对话与成果切换' }).getByRole('button', { name: '对话' }).click();
  // 附件要走真实上传：只有出现「Remove attachment」才算上传完成，
// 「Cancel upload」/「Retry」都说明还在传或失败了。
  const composer = page.locator('textarea').first();
  await composer.waitFor({ timeout: 15000 });
  await page.waitForFunction(() => {
    const box = document.querySelector('textarea')?.closest('form');
    if (!box || box.querySelectorAll('img').length === 0) return false;
    return Array.from(box.querySelectorAll('button'))
      .some(b => /Remove attachment|移除附件/.test(b.getAttribute('aria-label') || ''));
  }, { timeout: 60000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  const value = await composer.inputValue();
  // 附件渲染在 composer 的 form 里；只统计 form 子树，避免把成果里的图片算进来。
  const attachments = await composer.evaluate(node => {
    const scope = node.closest('form') || node.parentElement;
    return {
      imgs: Array.from(scope.querySelectorAll('img')).length,
      buttons: Array.from(scope.querySelectorAll('button')).map(b => b.getAttribute('aria-label') || '').filter(Boolean).slice(0, 8),
      text: scope.innerText.replace(/\s+/g, ' ').slice(0, 160),
    };
  });
  await page.screenshot({ path: `${review}ink-into-composer.png` });
  const text = value.slice(0, 300);
  const blocks = (text.match(/请(根据成果标注|参考这张手绘标注)修改/g) || []).length;
  if (!value.trim()) throw new Error('对话输入框是空的');
  if (attachments.imgs === 0) throw new Error(`PNG 没进附件区：${JSON.stringify(attachments)}`);
  if (attachments.buttons.some(l => /Retry|重试|Cancel upload/.test(l)) || /limit reached/.test(attachments.text)) {
    throw new Error(`附件上传未完成：${JSON.stringify(attachments)}`);
  }
  if (blocks !== 1) throw new Error(`同步块重复了 ${blocks} 次：${JSON.stringify(text)}`);
  return `附件图 ${attachments.imgs} 张，上传完成（${JSON.stringify(attachments.buttons.slice(0, 3))}）；同步块 ${blocks} 段；文字 ${JSON.stringify(text.slice(0, 70))}`;
});

await browser.close();
console.log(results.every(r => r.ok) ? '\nOK: 历史标注可见 + 手绘进对话' : '\nPROBLEMS:');
for (const r of results.filter(x => !x.ok)) console.log(' -', r.label, r.detail);
process.exit(results.every(r => r.ok) ? 0 : 1);