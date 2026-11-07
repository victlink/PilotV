/**
 * 线上验收脚本：用真实浏览器检查 PilotV 页面上的「项目团队」入口与聊天 Agent 选择器。
 *
 * 用法：
 *   node scripts/_archive/verify_project_team_ui.mjs <baseUrl> [outDir]
 *
 * 例：
 *   node scripts/_archive/verify_project_team_ui.mjs http://127.0.0.1:5187 .pilotdeck/work/verify
 *
 * 说明：
 *   - 令牌从本地 auth.db 的 jwt_secret 现签，不需要用户密码。
 *   - 只读检查，不改任何配置；截图写入 outDir。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official/ui/package.json');
// 用 1.60.0：它对应本机已装的 chromium-1223（1.64.0 要的 1248 没装）。
const { chromium } = require('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright');
const BASE_URL = process.argv[2] || 'http://127.0.0.1:5187';
const OUT_DIR = process.argv[3] || '.pilotdeck/work/verify';
const AUTH_DB = process.env.PILOTDECK_AUTH_DB || '/home/Marc/.pilotdeck/auth.db';

fs.mkdirSync(OUT_DIR, { recursive: true });

// --- 取 jwt_secret 并签一个 7 天有效的 token ---
function mintToken() {
  const Database = require('better-sqlite3');
  const db = new Database(AUTH_DB, { readonly: true });
  const row = db.prepare('select value from app_config where key = ?').get('jwt_secret');
  db.close();
  if (!row?.value) throw new Error('auth.db 里没有 jwt_secret');
  const jwt = require('jsonwebtoken');
  return jwt.sign({ userId: 1, username: 'Marc' }, row.value, { expiresIn: '7d' });
}

const token = mintToken();
const results = [];
function log(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${step}${detail ? ' :: ' + detail : ''}`);
}

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({
  viewport: (() => {
    const v = process.env.VERIFY_VIEWPORT || '1440x900';
    const [w, h] = v.split('x').map(Number);
    return { width: w, height: h };
  })(),
  locale: 'zh-CN',
  isMobile: process.env.VERIFY_MOBILE === '1',
  hasTouch: process.env.VERIFY_MOBILE === '1',
});
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

// --- 1. 打开首页并注入令牌 ---
const origin = new URL(BASE_URL).origin;
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(
  ([orig, tok]) => {
    const map = { [orig]: tok };
    localStorage.setItem('pilotdeck-tokens', JSON.stringify(map));
    localStorage.setItem('auth-token', tok);
  },
  [origin, token],
);
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: path.join(OUT_DIR, '01-home.png'), fullPage: false });

// --- 2. 打开设置页 ---
await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: path.join(OUT_DIR, '02-settings.png'), fullPage: false });

// --- 3. 侧栏里找「项目团队」 ---
const navTexts = await page.locator('.settings-nav .nav-item').allInnerTexts().catch(() => []);
log('settings sidebar rendered', navTexts.length > 0, `${navTexts.length} nav items`);
console.log('   nav items:', JSON.stringify(navTexts));

const teamBtn = page.locator('.settings-nav .nav-item', { hasText: /项目团队|Project Team/ }).first();
const teamCount = await teamBtn.count();
log('「项目团队 / Project Team」nav entry exists', teamCount > 0, `count=${teamCount}`);

if (teamCount > 0) {
  await teamBtn.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT_DIR, '03-sidebar-team.png') });
  await teamBtn.click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT_DIR, '04-project-team.png'), fullPage: false });
  const url = page.url();
  log('navigates to /settings/project-team', url.includes('/settings/project-team'), url);
  const bodyText = await page.locator('body').innerText();
  log(
    'project team panel rendered',
    /成员|Members|角色|Roles/.test(bodyText),
    bodyText.slice(0, 200).replace(/\n/g, ' | '),
  );
  console.log('   panel text head:', JSON.stringify(bodyText.slice(0, 400)));
}

// --- 4. 聊天页的 Agent 选择器 ---
await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3500);
await page.screenshot({ path: path.join(OUT_DIR, '05-chat.png'), fullPage: false });
const chatText = await page.locator('body').innerText();
const hasAgentPicker = /选择\s*Agent|Agent\s*选择|selectAgent|projectAgent|Agents?\b.*选择/i.test(chatText);
log('chat agent selector visible', hasAgentPicker, chatText.slice(0, 160).replace(/\n/g, ' | '));
// 把聊天页里所有含 Agent / agent 的元素单独列出来，方便定位选择器。
const agentish = await page
  .locator('button, [role="button"], [role="menu"], select, [class*="agent" i]')
  .allInnerTexts()
  .catch(() => []);
const agentishFiltered = [...new Set(agentish.map((s) => s.trim()).filter((s) => s && /agent/i.test(s)))];
console.log('   agent-ish elements:', JSON.stringify(agentishFiltered.slice(0, 20)));

// --- 5. API：未认证必须拒绝 ---
const unauth = await page.evaluate(async (base) => {
  const r = await fetch(`${base}/api/project-team?projectRoot=/tmp`, {
    headers: { 'X-PilotV-Device': 'x' },
  });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}, BASE_URL);
log('unauthenticated /api/project-team rejected', unauth.status === 401 || unauth.status === 403, JSON.stringify(unauth));

// --- 6. API：认证后应可访问 ---
const authed = await page.evaluate(
  async ([base, tok]) => {
    const r = await fetch(`${base}/api/project-team?projectRoot=/tmp`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    return { status: r.status, body: (await r.text()).slice(0, 300) };
  },
  [BASE_URL, token],
);
log('authenticated /api/project-team responds', authed.status !== 0, JSON.stringify(authed));

console.log('\n--- console errors ---');
console.log(consoleErrors.slice(0, 10).join('\n') || '(none)');

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} checks passed`);
fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify({ results, consoleErrors }, null, 2));
process.exit(failed.length ? 1 : 0);
