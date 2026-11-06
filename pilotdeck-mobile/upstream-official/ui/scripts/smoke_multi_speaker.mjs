/**
 * 多 Agent 配色/图标区分的真实验证。
 *
 * 打开 PilotV 项目下的历史会话，收集所有消息内发言人的
 * 图标（lucide 类名）与颜色（computed color），确认不同 agent 有不同取值。
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
const OUT_DIR = process.argv[3] || '/tmp/smoke-multi2';

const db = new Database('/home/Marc/.pilotdeck/auth.db', { readonly: true });
const row = db.prepare('select value from app_config where key = ?').get('jwt_secret');
db.close();
const token = jwt.sign({ userId: 1, username: 'Marc' }, row.value, { expiresIn: '30m' });

const ORIGINS = [BASE_URL, 'http://127.0.0.1:5187', 'http://127.0.0.1:3001'];

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
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(7000);

// 展开左侧栏所有项目，收集全部会话条目
const result = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const collect = () => {
    const out = [];
    for (const b of document.querySelectorAll('[data-testid="assistant-message-speaker"]')) {
      const svg = b.querySelector('svg');
      out.push({
        text: (b.textContent || '').trim(),
        key: b.getAttribute('data-speaker-key'),
        color: svg ? getComputedStyle(svg).color : null,
        icon: svg ? (svg.getAttribute('class') || '').split(' ').filter((c) => c.startsWith('lucide-')).join(' ') : '',
        chipClass: (b.closest('[data-testid="assistant-message-speaker"]') || b).className || '',
      });
    }
    return out;
  };

  // 展开所有项目
  for (let i = 0; i < 6; i += 1) {
    const expanders = Array.from(document.querySelectorAll('.project-expand-button'));
    for (const b of expanders) {
      try { b.click(); await sleep(300); } catch {}
    }
  }
  await sleep(1500);

  // 收集会话行
  const leaves = Array.from(document.querySelectorAll("button.project-conversation"));

  const all = [];
  const seen = new Set();
  for (const el of leaves) {
    const label = (el.textContent || '').trim();
    if (seen.has(label)) continue;
    seen.add(label);
    try { el.click(); } catch { continue; }
    await sleep(1100);
    const items = collect();
    if (items.length) all.push(...items);
  }

  const byKey = new Map();
  for (const s of all) if (!byKey.has(s.key)) byKey.set(s.key, s);
  const unique = [...byKey.values()];
  return {
    sessionsVisited: seen.size,
    speakerKeysFound: [...byKey.keys()],
    uniqueSpeakers: unique.map((u) => ({
      text: u.text,
      key: u.key,
      color: u.color,
      icon: u.icon,
    })),
    distinctColors: [...new Set(unique.map((u) => u.color).filter(Boolean))],
    distinctIcons: [...new Set(unique.map((u) => u.icon).filter(Boolean))],
    totalSpeakerNodes: all.length,
  };
});

await page.screenshot({ path: `${OUT_DIR}/multi.png`, fullPage: false });
console.log(JSON.stringify({ baseUrl: BASE_URL, ...result }, null, 2));
await browser.close();
