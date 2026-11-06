/**
 * 真实入口冒烟：确认用户实际访问的 https://nas.tail2b98e5.ts.net:5186 上
 * 渲染出的界面包含本轮四项改动：
 *   1. 说话人筛选条（团队 / 各 Agent 芯片 / 角色标签）
 *   2. 消息内可点击的发言人姓名 + 每 Agent 独立图标与颜色
 *   3. 回复折叠/展开（reply-expand-toggle）
 *   4. 右侧抽屉不再有「改动」，但左栏仍保留
 *
 * 认证：复用本机 auth.db 中的 jwt_secret，为本机用户签发短期令牌，
 * 只注入浏览器 localStorage，不落盘、不打印令牌值。
 *
 * 用法：node scripts/smoke_speaker_ui.mjs [baseUrl] [outDir]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(
  '/vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official/ui/package.json',
);
const { chromium } = require(
  '/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright',
);
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const BASE_URL = process.argv[2] || 'http://127.0.0.1:5187';
const OUT_DIR = process.argv[3] || '/tmp/smoke-speaker';

const AUTH_DB = '/home/Marc/.pilotdeck/auth.db';
const db = new Database(AUTH_DB, { readonly: true });
const row = db.prepare('select value from app_config where key = ?').get('jwt_secret');
db.close();
if (!row?.value) throw new Error('未找到 jwt_secret，无法签发本机令牌');
const token = jwt.sign({ userId: 1, username: 'Marc' }, row.value, { expiresIn: '30m' });

const ORIGINS = [
  BASE_URL,
  'http://127.0.0.1:5187',
  'http://127.0.0.1:3001',
  'http://localhost:3001',
  'https://nas.tail2b98e5.ts.net:5186',
];

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.SMOKE_CHROME || '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(
  ({ tok, origins }) => {
    const map = {};
    for (const o of origins) map[o] = tok;
    try {
      localStorage.setItem('pilotdeck-tokens', JSON.stringify(map));
    } catch {}
    try {
      localStorage.setItem('auth-token', tok);
    } catch {}
  },
  { tok: token, origins: ORIGINS },
);

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 160)}`);
});

await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

const info = await page.evaluate(() => {
  const text = document.body.innerText || '';
  const q = (sel) => Array.from(document.querySelectorAll(sel));
  const drawer = document.querySelector('.pd-page-drawer');
  const sidebar = document.querySelector('aside, nav, [data-testid="sidebar"], .pd-sidebar');

  const strip = document.querySelector('[data-testid="project-team-strip"]');
  const chips = strip
    ? Array.from(strip.querySelectorAll('button')).map((b) => ({
        text: (b.textContent || '').trim(),
        pressed: b.getAttribute('aria-pressed'),
        hasSvg: !!b.querySelector('svg'),
        color: (() => {
          const el = b.querySelector('svg') || b;
          const s = getComputedStyle(el);
          return s.color;
        })(),
      }))
    : [];

  const speakers = q('[data-testid="assistant-message-speaker"]').map((b) => {
    const svg = b.querySelector('svg');
    const s = svg ? getComputedStyle(svg) : null;
    return {
      text: (b.textContent || '').trim(),
      key: b.getAttribute('data-speaker-key'),
      hasSvg: !!svg,
      color: s ? s.color : null,
      clickable: b.tagName === 'BUTTON',
    };
  });

  return {
    title: document.title,
    url: location.href,
    loggedIn: !/Welcome Back|Sign in to your/i.test(text),
    hasStrip: !!strip,
    stripRoleWords: ['团队', '指挥', '主agent', '审查', '执行', '监督'].filter((w) =>
      (strip?.innerText || '').includes(w),
    ),
    chips,
    speakers,
    distinctSpeakerColors: [...new Set(speakers.map((s) => s.color).filter(Boolean))],
    expandToggles: q('[data-testid="reply-expand-toggle"]').length,
    drawerLabels: drawer
      ? Array.from(drawer.querySelectorAll('a,button')).map((b) => (b.textContent || '').trim()).filter(Boolean)
      : [],
    drawerHasChanges: drawer ? /改动/.test(drawer.innerText || '') : null,
    sidebarHasChanges: sidebar ? /改动/.test(sidebar.innerText || '') : null,
    bodySample: text.slice(0, 400).replace(/\n+/g, ' | '),
  };
});

const shot = `${OUT_DIR}/smoke.png`;
await page.screenshot({ path: shot, fullPage: false });

console.log(JSON.stringify({ baseUrl: BASE_URL, ...info, screenshot: shot, errors: errors.slice(0, 8) }, null, 2));

await browser.close();
