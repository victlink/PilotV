/**
 * 线上验收：设置页「项目团队」面板在真实服务上的可用性验证。
 *
 * 用法：
 *   node scripts/_archive/verify_project_team_settings.mjs [baseUrl] [projectRoot] [outDir]
 *
 * 例：
 *   node scripts/_archive/verify_project_team_settings.mjs http://127.0.0.1:3001 /vol3/1000/Work/00/PilotV
 *
 * 覆盖点：
 *   1. /api/project-team 对已注册项目根返回真实配置（成员列表）；
 *   2. 设置页存在「项目团队」入口，并能跳到 /settings/project-team；
 *   3. 面板 5 个标签页齐全：成员 / 角色 / 模型 / 工具授权 / 协作；
 *   4. 成员页渲染出配置里的 Agent 名称；
 *   5. 工具授权页渲染工具范围与禁止列表；
 *      「允许列表」只在 toolAccess = allow-list 时出现（前端按模式条件渲染），
 *      因此这里额外把下拉临时切到 allow-list，验证该行确实会出现；
 *   6. 角色 / 模型 / 协作页各自渲染对应字段；
 *   7. 面板自身的 /api/project-team 请求全部 2xx。
 *
 * 只读：全程不点「保存」，不写配置；切换下拉后立即 reload 丢弃草稿。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official/ui/package.json');
// 用 1.60.0：它对应本机已装的 chromium-1223（1.64.0 要的 1248 没装）。
const { chromium } = require('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const BASE_URL = process.argv[2] || 'http://127.0.0.1:3001';
const AUTH_DB = process.env.PILOTDECK_AUTH_DB || '/home/Marc/.pilotdeck/auth.db';
const OUT_DIR = process.argv[4] || '/vol3/1000/Work/00/PilotV/.pilotdeck/work/settings-probe';
const I18N_DIR =
  process.env.PROJECT_TEAM_I18N_DIR ||
  '/vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official/ui/src/i18n/locales';
const LOCALES = ['zh-CN', 'en'];

// ------------------------------------------------------------------ i18n 标签
const localeData = {};
for (const loc of LOCALES) {
  localeData[loc] = JSON.parse(fs.readFileSync(path.join(I18N_DIR, loc, 'projectTeam.json'), 'utf8'));
}
function pick(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}
/** 同一个 i18n key 在两种语言下的候选文案。 */
function variants(dotted) {
  return LOCALES.map((loc) => pick(localeData[loc], dotted)).filter((v) => typeof v === 'string' && v.length > 0);
}
function hasAny(text, dotted) {
  return variants(dotted).some((v) => text.includes(v));
}

// ------------------------------------------------------------------ 结果收集
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail ?? '' });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}

// ------------------------------------------------------------------ 令牌
function mintToken() {
  const db = new Database(AUTH_DB, { readonly: true });
  const row = db.prepare('select value from app_config where key = ?').get('jwt_secret');
  db.close();
  if (!row?.value) throw new Error('auth.db 里没有 jwt_secret');
  return jwt.sign({ userId: 1, username: 'Marc' }, row.value, { expiresIn: '2h' });
}
const token = mintToken();
const auth = { Authorization: `Bearer ${token}` };

// ------------------------------------------------------------------ 1. API
const projectsRes = await fetch(`${BASE_URL}/api/projects`, { headers: auth });
let registered = [];
try {
  const parsed = JSON.parse(await projectsRes.text());
  registered = Array.isArray(parsed) ? parsed : (parsed.projects ?? []);
} catch {
  registered = [];
}
let projectRoot = process.argv[3] || '';
if (!projectRoot) {
  const first = registered.find((p) => p.fullPath || p.path);
  projectRoot = first ? first.fullPath || first.path : '';
}
check('找到已注册项目根', !!projectRoot, projectRoot || `projects status=${projectsRes.status}`);

let config = null;
if (projectRoot) {
  const res = await fetch(`${BASE_URL}/api/project-team?projectRoot=${encodeURIComponent(projectRoot)}`, {
    headers: auth,
  });
  try {
    config = JSON.parse(await res.text());
  } catch {
    config = null;
  }
  check('GET /api/project-team 返回 200', res.status === 200, `status=${res.status} projectRoot=${projectRoot}`);
}
const agents = Array.isArray(config?.agents) ? config.agents : [];
check('配置里有团队成员', agents.length > 0, agents.map((a) => `${a.id}/${a.name}`).join(', ') || 'none');

// ------------------------------------------------------------------ 浏览器
fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
await context.addInitScript(
  ({ tok, origins }) => {
    const map = {};
    for (const o of origins) map[o] = tok;
    try {
      localStorage.setItem('pilotdeck-tokens', JSON.stringify(map));
      localStorage.setItem('auth-token', tok);
    } catch {}
  },
  { tok: token, origins: [BASE_URL, 'http://127.0.0.1:3001', 'http://localhost:3001'] },
);

const page = await context.newPage();
const teamCalls = [];
page.on('response', (r) => {
  if (r.url().includes('/api/project-team')) teamCalls.push({ status: r.status(), url: r.url() });
});
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});

// -------------------------------------------------- 2. 设置页入口与跳转
await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
const teamBtn = page.locator('.settings-nav .nav-item', { hasText: /项目团队|Project Team/ }).first();
check('设置页侧栏有「项目团队」入口', (await teamBtn.count()) > 0);
if (await teamBtn.count()) {
  await teamBtn.click();
  await page.waitForTimeout(2000);
}
check('跳转到 /settings/project-team', page.url().includes('/settings/project-team'), page.url());

// 带 projectRoot 打开面板，确保落在目标项目上
const targetUrl = `${BASE_URL}/settings/project-team?projectRoot=${encodeURIComponent(projectRoot)}`;
await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[role="tablist"]', { timeout: 20000 }).catch(() => null);
await page.waitForTimeout(1500);

const tablist = page.locator('[role="tablist"]');
check('渲染出标签栏', (await tablist.count()) > 0);
const tabTexts = (await page.locator('[role="tab"]').allInnerTexts().catch(() => [])).map((s) => s.trim());
console.log('TABS:', JSON.stringify(tabTexts));
for (const key of ['tabs.members', 'tabs.roles', 'tabs.model', 'tabs.tools', 'tabs.collaboration']) {
  const wanted = variants(key);
  check(`标签页 ${key} 存在`, wanted.some((w) => tabTexts.some((t) => t.includes(w))), `wanted=${JSON.stringify(wanted)}`);
}

/** 面板正文 = 标签栏所在容器的文本，去掉标签栏本身。 */
async function panelText() {
  const container = page.locator('[role="tablist"]').locator('xpath=..');
  const full = await container.innerText().catch(() => '');
  const tabs = await page.locator('[role="tablist"]').innerText().catch(() => '');
  return full.replace(tabs, ' ').trim();
}

async function openTab(key, shot) {
  const wanted = variants(key);
  // 界面语言可能是中文或英文，按文本命中任一候选文案即可。
  const tabs = page.locator('[role="tab"]');
  const count = await tabs.count();
  let target = null;
  for (let i = 0; i < count; i += 1) {
    const text = (await tabs.nth(i).innerText()).trim();
    if (wanted.some((w) => text.includes(w))) {
      target = tabs.nth(i);
      break;
    }
  }
  if (!target) throw new Error(`找不到标签页 ${key}（候选 ${JSON.stringify(wanted)}）`);
  await target.click();
  await page.waitForTimeout(900);
  if (shot) await page.screenshot({ path: path.join(OUT_DIR, shot), fullPage: false });
  return panelText();
}

// -------------------------------------------------- 3. 成员页
const membersText = await openTab('tabs.members', '01-members.png');
for (const agent of agents) {
  check(`成员页渲染出「${agent.name}」`, membersText.includes(agent.name));
}

// -------------------------------------------------- 4. 角色页
const rolesText = await openTab('tabs.roles', '02-roles.png');
check('角色页渲染角色字段', hasAny(rolesText, 'roles.role'), rolesText.slice(0, 120).replace(/\n/g, ' | '));
for (const agent of agents) {
  check(`角色页包含成员「${agent.name}」`, rolesText.includes(agent.name));
}

// -------------------------------------------------- 5. 模型页
const modelText = await openTab('tabs.model', '03-model.png');
check('模型页渲染模型来源', hasAny(modelText, 'model.source'), modelText.slice(0, 120).replace(/\n/g, ' | '));

// -------------------------------------------------- 6. 工具授权页
const toolsText = await openTab('tabs.tools', '04-tools.png');
check('工具授权页渲染工具范围', hasAny(toolsText, 'tools.toolAccess'));
check('工具授权页渲染禁止列表', hasAny(toolsText, 'tools.denyList'));

const selected = agents.find((a) => a.id === config?.agents?.find((x) => x.id === a.id)?.id) ?? agents[0];
const mode = selected?.permissions?.toolAccess ?? 'all';
const allowVisible = hasAny(toolsText, 'tools.allowList');
if (mode === 'allow-list') {
  check('allow-list 模式下渲染允许列表', allowVisible);
} else {
  check(`toolAccess=${mode} 时允许列表按设计不出现`, !allowVisible, `allowVisible=${allowVisible}`);
}

// 切到 allow-list 模式，允许列表这一行应该出现（不保存，仅前端状态）
const toolAccessSelect = page.locator('select').filter({ has: page.locator('option[value="allow-list"]') }).first();
if (await toolAccessSelect.count()) {
  await toolAccessSelect.selectOption('allow-list');
  await page.waitForTimeout(700);
  const afterSwitch = await panelText();
  check('切到 allow-list 后渲染允许列表', hasAny(afterSwitch, 'tools.allowList'), afterSwitch.slice(0, 160).replace(/\n/g, ' | '));
  await page.screenshot({ path: path.join(OUT_DIR, '05-allowlist.png'), fullPage: false });
  // 丢弃草稿：重新加载，不保存
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[role="tab"]', { timeout: 20000 }).catch(() => null);
  await page.waitForTimeout(2500);
} else {
  check('找到工具范围下拉框', false, 'select[option=allow-list] not found');
}

// -------------------------------------------------- 7. 协作页
const collabText = await openTab('tabs.collaboration', '06-collaboration.png');
check('协作页渲染协作模式', hasAny(collabText, 'collaboration.mode'), collabText.slice(0, 120).replace(/\n/g, ' | '));
const modeValue = config?.collaboration?.mode ?? 'manual';
const modeLabel = variants(`collaboration.modes.${modeValue}`);
check(`协作模式当前值「${modeValue}」有对应文案`, modeLabel.some((m) => collabText.includes(m)), `labels=${JSON.stringify(modeLabel)}`);

// -------------------------------------------------- 8. 网络与控制台
const badCalls = teamCalls.filter((c) => c.status >= 400);
check('面板自身的 /api/project-team 请求全部成功', badCalls.length === 0, JSON.stringify(badCalls));
console.log('TEAM API CALLS:', JSON.stringify(teamCalls));
const realConsoleErrors = consoleErrors.filter(
  (e) => !/Failed to load resource/.test(e) && !/401/.test(e) && !/404/.test(e),
);
check('控制台无非资源类报错', realConsoleErrors.length === 0, JSON.stringify(realConsoleErrors.slice(0, 4)));
console.log('CONSOLE ERRORS:', JSON.stringify(consoleErrors.slice(0, 8)));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify({ results, teamCalls, consoleErrors }, null, 2));
if (failed.length) {
  console.log('FAILED:', JSON.stringify(failed, null, 1));
  process.exit(1);
}
