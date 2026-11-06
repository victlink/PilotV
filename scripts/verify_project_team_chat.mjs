/**
 * 线上验收：项目团队 Agent 在聊天页的可用性验证。
 *
 * 覆盖点：
 *  1. /api/project-team 在生产服务上对已注册项目根返回真实配置；
 *  2. 选中项目后，composer 出现 Agent 选择控件（.pd-composer-agent-control）；
 *  3. 控件下拉列出项目团队成员（默认 Agent + 启用的成员）；
 *  4. 会话上方出现项目团队 strip（.pd-composer / [data-testid=project-team-strip]）。
 *
 * 只读：不写配置、不发消息。退出码 0 表示全部通过。
 *
 * 用法：node scripts/verify_project_team_chat.mjs [baseUrl] [projectRoot]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('/vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official/ui/package.json');
const { chromium } = require('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const BASE_URL = process.argv[2] || 'http://127.0.0.1:3001';
const PROJECT_ROOT = process.argv[3] || '/vol3/1000/Work/00/PilotV';
const AUTH_DB = '/home/Marc/.pilotdeck/auth.db';
const OUT_DIR = '/vol3/1000/Work/00/PilotV/.pilotdeck/work/chat-probe';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
};

const db = new Database(AUTH_DB, { readonly: true });
const row = db.prepare('select value from app_config where key = ?').get('jwt_secret');
db.close();
const token = jwt.sign({ userId: 1, username: 'Marc' }, row.value, { expiresIn: '2h' });

const ORIGINS = [BASE_URL, 'http://127.0.0.1:3001', 'http://127.0.0.1:5187', 'http://localhost:3001'];

// ---------- 1. 后端 API 直连验证 ----------
const apiRes = await fetch(`${BASE_URL}/api/project-team?projectRoot=${encodeURIComponent(PROJECT_ROOT)}`, {
  headers: { Authorization: `Bearer ${token}` },
});
let apiBody = null;
try {
  apiBody = await apiRes.json();
} catch {
  apiBody = null;
}
check(
  'GET /api/project-team 返回 200',
  apiRes.status === 200,
  `status=${apiRes.status}`,
);
const apiAgents = apiBody && Array.isArray(apiBody.agents) ? apiBody.agents : [];
check(
  '接口返回项目团队成员列表',
  apiAgents.length > 0,
  `agents=${apiAgents.map((a) => `${a.id}/${a.name}`).join(', ') || 'none'}`,
);
const enabledAgents = apiAgents.filter((a) => a.enabled !== false);
check(
  '存在启用状态的成员',
  enabledAgents.length > 0,
  `enabled=${enabledAgents.map((a) => a.name).join(', ') || 'none'}`,
);

// 未认证访问必须被拒绝
const unauth = await fetch(`${BASE_URL}/api/project-team?projectRoot=${encodeURIComponent(PROJECT_ROOT)}`);
check('未认证访问被拒绝', unauth.status === 401 || unauth.status === 403, `status=${unauth.status}`);

// ---------- 2. 浏览器端 UI 验证 ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(
  ({ token, origins }) => {
    const map = {};
    for (const o of origins) map[o] = token;
    try {
      localStorage.setItem('pilotdeck-tokens', JSON.stringify(map));
    } catch {}
    try {
      localStorage.setItem('auth-token', token);
    } catch {}
  },
  { token, origins: ORIGINS },
);

const page = await context.newPage();
const teamCalls = [];
page.on('response', (r) => {
  if (r.url().includes('/api/project-team')) teamCalls.push({ status: r.status(), url: r.url() });
});
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160));
});

await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

// 侧栏项目按钮：文本以项目名开头
const projectLabels = await page.evaluate(() =>
  Array.from(document.querySelectorAll('button.project-expand-button')).map((el) => (el.textContent || '').trim()),
);
console.log('SIDEBAR PROJECTS:', JSON.stringify(projectLabels));

const clicked = await page.evaluate((root) => {
  const target = root.split('/').filter(Boolean).pop();
  const buttons = Array.from(document.querySelectorAll('button.project-expand-button'));
  const hit = buttons.find((el) => (el.textContent || '').trim().startsWith(target));
  if (!hit) return false;
  hit.scrollIntoView({ block: 'center' });
  hit.click();
  return true;
}, PROJECT_ROOT);
check('侧栏可点击项目节点', clicked, `labels=${JSON.stringify(projectLabels)}`);
await page.waitForTimeout(3500);

// composer 上的 Agent 控件
await page
  .waitForSelector('.pd-composer-agent-control', { timeout: 20000 })
  .catch(() => null);
const agentControlCount = await page.locator('.pd-composer-agent-control').count();
check('composer 出现 Agent 选择控件', agentControlCount > 0, `count=${agentControlCount}`);

const controlLabel = agentControlCount
  ? (await page.locator('.pd-composer-agent-control button').first().innerText()).trim()
  : '';
console.log('AGENT CONTROL LABEL:', JSON.stringify(controlLabel));

let menuItems = [];
if (agentControlCount) {
  await page.locator('.pd-composer-agent-control button').first().click();
  await page.waitForTimeout(900);
  menuItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.pd-composer-agent-menu button, .pd-composer-agent-menu [role="option"], .pd-composer-agent-menu a'))
      .map((el) => (el.textContent || '').trim())
      .filter(Boolean),
  );
  await page.screenshot({ path: `${OUT_DIR}/10-agent-menu.png` });
  await page.keyboard.press('Escape');
}
console.log('AGENT MENU ITEMS:', JSON.stringify(menuItems));

const memberNames = apiAgents.map((a) => a.name);
const menuHasMembers = memberNames.length > 0 && memberNames.every((n) => menuItems.some((m) => m.includes(n)));
check('下拉包含项目团队成员', menuHasMembers, `members=${memberNames.join(',')} menu=${JSON.stringify(menuItems)}`);

// 会话上方项目团队 strip
const stripCount = await page.locator('[data-testid="project-team-strip"]').count();
const stripText = stripCount ? (await page.locator('[data-testid="project-team-strip"]').innerText()).trim() : '';
check('会话上方出现项目团队 strip', stripCount > 0, `text=${JSON.stringify(stripText.slice(0, 120))}`);
const stripHasMembers =
  memberNames.length > 0 && memberNames.every((n) => stripText.includes(n));
check('strip 展示成员名称', stripHasMembers, `strip=${JSON.stringify(stripText.slice(0, 160))}`);

await page.screenshot({ path: `${OUT_DIR}/11-project-team-strip.png`, fullPage: false });

console.log('TEAM API CALLS:', JSON.stringify(teamCalls));
console.log('CONSOLE ERRORS:', JSON.stringify(consoleErrors.slice(0, 8)));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:', JSON.stringify(failed, null, 1));
  process.exit(1);
}
