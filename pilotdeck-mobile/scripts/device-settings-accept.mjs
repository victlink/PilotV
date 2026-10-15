// 设备设置悬浮窗验收：全新浏览器档案打开 5186，
// 确认预置设备、悬浮窗独立挂载、改名/新增/删除与刷新后保留、打开不改当前选择。
import { createRequire } from 'node:module';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');

const base = process.env.BASE_URL || 'http://127.0.0.1:5186/';
const out = { base, steps: {}, errors: [] };
const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const options = page => page.getByLabel('选择设备').locator('option').allInnerTexts();
const reload = async page => { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3500); };

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', e => out.errors.push(e.message));
  page.on('dialog', d => d.accept());

  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4500);

  // 1. 预置设备
  out.steps.presets = await options(page);
  out.steps.selectedOrigin = await page.getByLabel('选择设备').inputValue();

  // 2. 悬浮窗：独立挂到 body，不是侧栏内联表单
  await page.getByLabel('设备设置').click();
  await page.waitForTimeout(600);
  const dialog = page.locator('[role="dialog"]');
  out.steps.dialogVisible = await dialog.isVisible();
  out.steps.dialogMountedInBody = await dialog.evaluate(node => node.closest('[data-dialog-backdrop]')?.parentElement === document.body);
  out.steps.dialogText = (await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 260);
  out.steps.selectionUnchanged = (await page.getByLabel('选择设备').inputValue()) === out.steps.selectedOrigin;
  out.steps.dialogScreenshot = 'review/live/device-settings-dialog.png';
  await page.screenshot({ path: out.steps.dialogScreenshot });

  // 3. 取消不改动任何东西
  await dialog.getByText('取消').click();
  await page.waitForTimeout(300);
  out.steps.dialogClosedOnCancel = await page.locator('[role="dialog"]').count() === 0;
  out.steps.afterCancel = await options(page);

  // 4. 自定义名称改名
  await page.getByLabel('设备设置').click();
  await page.waitForTimeout(400);
  await page.getByLabel('编辑设备 leo-mac-studio').click();
  await page.getByLabel('设备名称').fill('leo 的 Mac');
  await page.getByText('保存设备').click();
  await page.waitForTimeout(600);
  out.steps.afterRename = await options(page);
  await reload(page);
  out.steps.afterRenameReload = await options(page);
  out.steps.storedAfterRename = await page.evaluate(() => localStorage.getItem('pilotdeck-device-directory-v1'));

  // 5. 新增一台自定义名称的设备
  await page.getByLabel('选择设备').selectOption('__add_device__');
  await page.waitForTimeout(500);
  out.steps.addDialogOpen = await page.locator('[role="dialog"]').isVisible();
  out.steps.addFormEmpty = await page.getByLabel('设备名称').inputValue() === '';
  await page.getByLabel('设备名称').fill('会议室大屏');
  await page.getByLabel('官方 UI 地址').fill('http://10.0.0.9:3001/');
  await page.getByText('保存设备').click();
  await page.waitForTimeout(600);
  out.steps.afterAdd = await options(page);
  await reload(page);
  out.steps.afterAddReload = await options(page);

  // 6. 删除：预置设备刷新后不再复活
  await page.getByLabel('设备设置').click();
  await page.waitForTimeout(400);
  await page.getByLabel('删除设备 会议室大屏').click();
  await page.waitForTimeout(600);
  out.steps.afterDelete = await options(page);
  out.steps.hiddenKey = await page.evaluate(() => localStorage.getItem('pilotdeck-device-directory-hidden-v1'));
  await reload(page);
  out.steps.afterDeleteReload = await options(page);

  // 7. 手机视口下的悬浮窗排版
  let phonePage;
  try {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    phonePage = await phone.newPage();
    phonePage.on('dialog', d => d.accept());
    await phonePage.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await phonePage.waitForTimeout(4000);
    out.steps.phoneOptions = await options(phonePage);
    // 手机上侧栏收在抽屉里，先用顶栏的侧栏按钮拉出来，再进设备设置。
    await phonePage.getByLabel('Show sidebar').click({ timeout: 15000 }).catch(() => phonePage.getByLabel('Open menu').click({ timeout: 15000 }));
    await phonePage.waitForTimeout(900);
    await phonePage.getByLabel('设备设置').click({ timeout: 15000 });
    await phonePage.waitForTimeout(600);
    const phoneBox = await phonePage.locator('.pd-device-settings').boundingBox();
    out.steps.phoneDialog = { width: Math.round(phoneBox?.width ?? 0), bottom: Math.round((phoneBox?.y ?? 0) + (phoneBox?.height ?? 0)), viewportHeight: 844 };
    out.steps.phoneScreenshot = 'review/live/device-settings-phone.png';
    await phonePage.screenshot({ path: out.steps.phoneScreenshot });
    await phone.close();
  } catch (failure) {
    await phonePage?.screenshot({ path: 'review/live/device-settings-phone-failed.png' }).catch(() => {});
    out.errors.push(`phone: ${failure.message.split('\n').slice(0, 4).join(' | ')}`);
  }

  out.steps.finalOrigin = await page.evaluate(() => window.location.origin);
} finally {
  await browser.close();
  console.log(JSON.stringify(out, null, 2).slice(0, 3000));
}
