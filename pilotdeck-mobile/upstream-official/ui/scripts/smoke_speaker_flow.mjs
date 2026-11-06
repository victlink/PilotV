/**
 * 真实入口端到端冒烟（中文 locale）：
 *  1. 顶部说话人筛选条：团队芯片 + 各 Agent 芯片 + 角色标签
 *  2. 消息内发言人姓名可点击，每 Agent 独立图标与颜色
 *  3. 点击发言人后按该 Agent 过滤；点击「团队」恢复全部
 *  4. 回复折叠/展开开关
 *  5. 右侧抽屉无「改动」，左栏改动入口保留
 *
 * 认证：复用本机 auth.db 的 jwt_secret 签发短期令牌，仅注入浏览器内存，
 *       不落盘、不打印。
 *
 * 用法：node scripts/smoke_speaker_flow.mjs [baseUrl] [outDir]
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
const OUT_DIR = process.argv[3] || '/tmp/smoke-speaker-flow';

const db = new Database('/home/Marc/.pilotdeck/auth.db', { readonly: true });
const row = db.prepare('select value from app_config where key = ?').get('jwt_secret');
db.close();
if (!row?.value) throw new Error('未找到 jwt_secret');
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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
await context.addInitScript(
  ({ tok, origins }) => {
    const map = {};
    for (const o of origins) map[o] = tok;
    try { localStorage.setItem('pilotdeck-tokens', JSON.stringify(map)); } catch {}
    try { localStorage.setItem('auth-token', tok); } catch {}
    try { localStorage.setItem('userLanguage', 'zh-CN'); } catch {}
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
await page.waitForTimeout(8000);

const snapshot = async (label) =>
  page.evaluate((lbl) => {
    const q = (s) => Array.from(document.querySelectorAll(s));
    const strip = document.querySelector('[data-testid="project-team-strip"]');
    const drawer = document.querySelector('.pd-page-drawer');
    const speakers = q('[data-testid="assistant-message-speaker"]').map((b) => {
      const svg = b.querySelector('svg');
      return {
        text: (b.textContent || '').trim(),
        key: b.getAttribute('data-speaker-key'),
        hasSvg: !!svg,
        color: svg ? getComputedStyle(svg).color : null,
        clickable: b.tagName === 'BUTTON',
      };
    });
    return {
      label: lbl,
      stripPresent: !!strip,
      stripText: (strip?.innerText || '').replace(/\n+/g, ' | '),
      teamChipPresent: !!document.querySelector('[data-testid="speaker-filter-team"]'),
      agentChips: q('[data-testid="speaker-filter-item"]').map((b) => ({
        text: (b.textContent || '').trim(),
        pressed: b.getAttribute('aria-pressed'),
        hasSvg: !!b.querySelector('svg'),
        color: (() => {
          const el = b.querySelector('svg') || b;
          return getComputedStyle(el).color;
        })(),
      })),
      speakerCount: speakers.length,
      speakers,
      distinctSpeakerColors: [...new Set(speakers.map((s) => s.color).filter(Boolean))],
      expandToggles: q('[data-testid="assistant-message-expand"]').length,
      expandedTogglesText: q('[data-testid="assistant-message-expand"]').map(
        (b) => (b.textContent || '').trim().slice(0, 40),
      ),
      visibleMessageBodies: q('[data-testid="assistant-message-content"], .pd-message-body').length,
      drawerLabels: drawer
        ? Array.from(drawer.querySelectorAll('a,button')).map((b) => (b.textContent || '').trim()).filter(Boolean)
        : [],
      drawerHasChanges: drawer ? /改动/.test(drawer.innerText || '') : null,
      sidebarHasChanges: (() => {
        const sb = document.querySelector('aside, nav, [data-testid="sidebar"], .pd-sidebar');
        return sb ? /改动/.test(sb.innerText || '') : null;
      })(),
    };
  }, label);

const before = await snapshot('初始');

// 打开一个有历史消息的会话：优先点侧栏里的会话条目
const clicked = await page.evaluate(() => {
  const cands = Array.from(
    document.querySelectorAll('a,button,li,div[role="button"],[data-testid]'),
  ).filter((el) => {
    const t = (el.textContent || '').trim();
    return t.length > 2 && t.length < 60 && /确认助手的身份名称|请只回答一句话/.test(t);
  });
  const el = cands[cands.length - 1];
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  el.click();
  return (el.textContent || '').trim();
});
await page.waitForTimeout(7000);

const afterOpen = await snapshot('打开会话后');

// 点击一个发言人姓名，验证筛选生效
let afterSpeakerClick = null;
let clickedSpeaker = null;
if (afterOpen.speakerCount > 0) {
  clickedSpeaker = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="assistant-message-speaker"]');
    if (!b) return null;
    const t = (b.textContent || '').trim();
    b.click();
    return t;
  });
  await page.waitForTimeout(2500);
  afterSpeakerClick = await snapshot('点击发言人后');
}

await page.screenshot({ path: `${OUT_DIR}/after-speaker-click.png`, fullPage: false });

// 点「团队」恢复全部
let afterTeamClick = null;
if (afterSpeakerClick) {
  await page.evaluate(() => {
    const t = document.querySelector('[data-testid="speaker-filter-team"]');
    if (t) t.click();
  });
  await page.waitForTimeout(2500);
  afterTeamClick = await snapshot('点击团队后');
  await page.screenshot({ path: `${OUT_DIR}/after-team-click.png`, fullPage: false });
}

console.log(
  JSON.stringify(
    { baseUrl: BASE_URL, clickedSession: clicked, clickedSpeaker, before, afterOpen, afterSpeakerClick, afterTeamClick, errors: errors.slice(0, 8) },
    null,
    2,
  ),
);

await browser.close();
